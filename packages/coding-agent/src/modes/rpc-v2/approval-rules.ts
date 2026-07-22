import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, Snowflake } from "@oh-my-pi/pi-utils";
import { withFileLock } from "../../config/file-lock";
import type { ApprovalPolicySnapshot, ApprovalScope, PermissionPolicySnapshot, PermissionRule } from "./dto/approval";
import type { ApprovalId } from "./protocol/ids";

export type ApprovalPolicyScope = "session" | "workspace" | "global";
export type ApprovalPolicyDefaults = Record<"read" | "write" | "exec", "ask" | "allow" | "deny">;

interface StoredScopePolicy {
	revision: number;
	defaults: Partial<ApprovalPolicyDefaults>;
	rules: PermissionRule[];
}

interface StoredApprovalPolicies {
	schemaVersion: 1;
	policies: Record<string, StoredScopePolicy>;
}

export interface ApprovalPolicyContext {
	sessionId?: string;
	cwd?: string;
}

export interface ApprovalPolicyResolution {
	snapshot: ApprovalPolicySnapshot;
	scope: ApprovalScope;
}

const BUILTIN_DEFAULTS: ApprovalPolicyDefaults = { read: "allow", write: "ask", exec: "ask" };

/** Generate a canonical fingerprint for an approval request. */
export function generateFingerprint(params: {
	requestAction: string;
	toolName?: string;
	operationKind?: string;
	targetCanonical?: string;
	riskTier: string;
	workspaceRoot?: string;
}): string {
	const canonical = stableSerialize({
		requestAction: params.requestAction,
		toolName: params.toolName ?? null,
		operationKind: params.operationKind ?? null,
		targetCanonical: params.targetCanonical ?? null,
		riskTier: params.riskTier,
		workspaceRoot: params.workspaceRoot ? path.resolve(params.workspaceRoot) : null,
	});
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
}

/** San 持有的分层审批策略；写入采用同目录临时文件加 rename。 */
export class ApprovalRuleStore {
	readonly #storagePath: string;
	#policies: StoredApprovalPolicies = { schemaVersion: 1, policies: {} };
	#loaded = false;
	#operationTail: Promise<void> = Promise.resolve();

	constructor(storagePath = path.join(getAgentDir(), "rpc-v2", "approval-policy.json")) {
		this.#storagePath = storagePath;
	}

	async load(): Promise<void> {
		if (this.#loaded) return;
		await this.refresh();
	}

	/** 重新读取共享策略文件，让长驻 Runtime 看到其他进程提交的规则。 */
	async refresh(): Promise<void> {
		await this.#exclusive(async () => {
			this.#policies = await this.#loadFromDisk();
			this.#loaded = true;
		});
	}

	async #loadFromDisk(): Promise<StoredApprovalPolicies> {
		try {
			const value = (await Bun.file(this.#storagePath).json()) as Partial<StoredApprovalPolicies>;
			if (value.schemaVersion !== 1 || !isRecord(value.policies)) {
				throw new Error("expected schemaVersion 1 and policies object");
			}
			const policies: Record<string, StoredScopePolicy> = {};
			for (const [key, raw] of Object.entries(value.policies)) {
				if (!isRecord(raw)) continue;
				policies[key] = {
					revision: typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) ? raw.revision : 0,
					defaults: validateDefaults(raw.defaults, true),
					rules: Array.isArray(raw.rules)
						? raw.rules.filter(isPermissionRule).map(rule => structuredClone(rule))
						: [],
				};
			}
			return { schemaVersion: 1, policies };
		} catch (error: unknown) {
			if (!isEnoent(error))
				throw new Error(`Failed to load approval policies ${this.#storagePath}: ${String(error)}`);
			return { schemaVersion: 1, policies: {} };
		}
	}

	get revision(): number {
		return Object.values(this.#policies.policies).reduce((total, policy) => total + policy.revision, 0);
	}

	getRevision(scope: ApprovalPolicyScope, context: ApprovalPolicyContext = {}): number {
		return this.#policies.policies[scopeKey(scope, context)]?.revision ?? 0;
	}

	/** Add a rule from an approval decision. */
	async addRule(params: {
		scope?: ApprovalPolicyScope;
		context?: ApprovalPolicyContext;
		decision: "allow" | "deny";
		fingerprint: string;
		toolName?: string;
		operationKind?: string;
		targetPattern?: string;
		riskCeiling?: "low" | "medium" | "high";
		sourceApprovalId?: ApprovalId;
	}): Promise<PermissionRule> {
		this.#assertLoaded();
		return await this.#mutate(async () => {
			const scope = params.scope ?? "session";
			const context = params.context ?? {};
			const policy = this.#mutablePolicy(scope, context);
			if (params.sourceApprovalId) {
				const existing = policy.rules.find(rule => rule.sourceApprovalId === params.sourceApprovalId);
				if (existing) {
					if (existing.decision !== params.decision || existing.fingerprint !== params.fingerprint) {
						throw new Error(`Approval ${params.sourceApprovalId} already created a different permission rule`);
					}
					return structuredClone(existing);
				}
			}
			const rule: PermissionRule = {
				ruleId: `rule_${Snowflake.next()}`,
				decision: params.decision,
				fingerprint: params.fingerprint,
				toolName: params.toolName,
				operationKind: params.operationKind,
				targetPattern: params.targetPattern,
				riskCeiling: params.riskCeiling,
				createdAt: new Date().toISOString(),
				sourceApprovalId: params.sourceApprovalId,
				mutable: true,
				sourceScope: scope,
				sourceScopeId: scopeId(scope, context),
			};
			policy.rules.push(rule);
			policy.revision++;
			return structuredClone(rule);
		});
	}

	/** Revoke a mutable rule with optimistic revision validation. */
	async revoke(params: {
		scope: ApprovalPolicyScope;
		context?: ApprovalPolicyContext;
		ruleId: string;
		expectedRevision?: number;
	}): Promise<boolean> {
		this.#assertLoaded();
		return await this.#mutate(async () => {
			const context = params.context ?? {};
			const policy = this.#mutablePolicy(params.scope, context);
			assertRevision(policy.revision, params.expectedRevision);
			const index = policy.rules.findIndex(rule => rule.ruleId === params.ruleId && rule.mutable);
			if (index === -1) return false;
			policy.rules.splice(index, 1);
			policy.revision++;
			return true;
		});
	}

	async updateDefaults(params: {
		scope: ApprovalPolicyScope;
		context?: ApprovalPolicyContext;
		patch: Partial<ApprovalPolicyDefaults>;
		expectedRevision?: number;
	}): Promise<PermissionPolicySnapshot> {
		this.#assertLoaded();
		return await this.#mutate(async () => {
			const context = params.context ?? {};
			const policy = this.#mutablePolicy(params.scope, context);
			assertRevision(policy.revision, params.expectedRevision);
			policy.defaults = { ...policy.defaults, ...validateDefaults(params.patch, true) };
			policy.revision++;
			return this.getPolicy(params.scope, context, true);
		});
	}

	/** Check the most specific matching rule: session, workspace, then global. */
	match(fingerprint: string, context: ApprovalPolicyContext = {}): PermissionRule | undefined {
		this.#assertLoaded();
		const scopes: ApprovalPolicyScope[] = ["session", "workspace", "global"];
		for (const scope of scopes) {
			const rules = this.#policies.policies[scopeKey(scope, context)]?.rules ?? [];
			for (let index = rules.length - 1; index >= 0; index--) {
				if (rules[index]?.fingerprint === fingerprint) return structuredClone(rules[index]);
			}
		}
		return undefined;
	}

	/** Resolve the effective decision used by a live Approval request. */
	resolve(params: {
		fingerprint: string;
		tier: "read" | "write" | "exec";
		requestOverride: boolean;
		canPersistRule: boolean;
		context?: ApprovalPolicyContext;
	}): ApprovalPolicyResolution {
		this.#assertLoaded();
		if (params.requestOverride) {
			return {
				scope: "once",
				snapshot: {
					source: "request_override",
					effectiveDecision: "ask",
					canPersistRule: false,
					rationale: "The tool explicitly requires a one-time decision",
				},
			};
		}

		const context = params.context ?? {};
		const matched = this.match(params.fingerprint, context);
		if (matched) {
			const source = matched.sourceScope ?? "session";
			return {
				scope: source,
				snapshot: {
					source,
					ruleId: matched.ruleId,
					matchedFingerprint: matched.fingerprint,
					effectiveDecision: matched.decision,
					canPersistRule: params.canPersistRule,
					rationale: `Matched approval rule ${matched.ruleId}`,
				},
			};
		}

		let source: ApprovalPolicySnapshot["source"] = "builtin";
		let decision = BUILTIN_DEFAULTS[params.tier];
		for (const scope of policyHierarchy("session")) {
			if (scope === "workspace" && !context.cwd) continue;
			if (scope === "session" && !context.sessionId) continue;
			const configured = this.#policies.policies[scopeKey(scope, context)]?.defaults[params.tier];
			if (configured !== undefined) {
				source = scope;
				decision = configured;
			}
		}
		return {
			scope: source === "builtin" ? "once" : source,
			snapshot: {
				source,
				effectiveDecision: decision,
				canPersistRule: params.canPersistRule,
				rationale: source === "builtin" ? "Built-in approval default" : `Effective ${source} approval default`,
			},
		};
	}

	/** Get inherited effective policy and the target scope revision. */
	getPolicy(
		scope: ApprovalPolicyScope,
		context: ApprovalPolicyContext = {},
		includeInherited = true,
	): PermissionPolicySnapshot {
		this.#assertLoaded();
		const hierarchy = policyHierarchy(scope);
		let defaults = { ...BUILTIN_DEFAULTS };
		const rules: PermissionRule[] = [];
		for (const candidate of hierarchy) {
			const policy = this.#policies.policies[scopeKey(candidate, context)];
			if (!policy) continue;
			defaults = { ...defaults, ...policy.defaults };
			if (includeInherited || candidate === scope) rules.push(...policy.rules.map(rule => structuredClone(rule)));
		}
		return {
			schemaVersion: 1,
			scope,
			scopeId: scopeId(scope, context),
			revision: this.getRevision(scope, context),
			defaults,
			rules,
			restartRequired: false,
		};
	}

	list(options?: {
		toolName?: string;
		scope?: ApprovalPolicyScope;
		context?: ApprovalPolicyContext;
	}): PermissionRule[] {
		this.#assertLoaded();
		const policy = this.getPolicy(options?.scope ?? "session", options?.context, true);
		return options?.toolName ? policy.rules.filter(rule => rule.toolName === options.toolName) : policy.rules;
	}

	#mutablePolicy(scope: ApprovalPolicyScope, context: ApprovalPolicyContext): StoredScopePolicy {
		const key = scopeKey(scope, context);
		const existing = this.#policies.policies[key];
		if (existing) return existing;
		const policy: StoredScopePolicy = { revision: 0, defaults: {}, rules: [] };
		this.#policies.policies[key] = policy;
		return policy;
	}

	async #mutate<T>(mutation: () => Promise<T>): Promise<T> {
		return await this.#exclusive(async () => {
			await fs.mkdir(path.dirname(this.#storagePath), { recursive: true });
			return await withFileLock(this.#storagePath, async () => {
				this.#policies = await this.#loadFromDisk();
				const result = await mutation();
				await this.#save();
				return result;
			});
		});
	}

	async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#operationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#operationTail = previous.then(() => promise);
		await previous;
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	async #save(): Promise<void> {
		const tempPath = `${this.#storagePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await Bun.write(tempPath, `${JSON.stringify(this.#policies)}\n`);
			await fs.rename(tempPath, this.#storagePath);
		} finally {
			await fs.rm(tempPath, { force: true });
		}
	}

	#assertLoaded(): void {
		if (!this.#loaded) throw new Error("ApprovalRuleStore.load() must complete before use");
	}
}

function policyHierarchy(scope: ApprovalPolicyScope): ApprovalPolicyScope[] {
	if (scope === "global") return ["global"];
	if (scope === "workspace") return ["global", "workspace"];
	return ["global", "workspace", "session"];
}

function scopeKey(scope: ApprovalPolicyScope, context: ApprovalPolicyContext): string {
	return `${scope}:${scopeId(scope, context)}`;
}

function scopeId(scope: ApprovalPolicyScope, context: ApprovalPolicyContext): string {
	if (scope === "global") return "global";
	if (scope === "workspace") {
		if (!context.cwd) throw new Error("Workspace approval policy requires cwd");
		return path.resolve(context.cwd);
	}
	if (!context.sessionId) throw new Error("Session approval policy requires sessionId");
	return context.sessionId;
}

function assertRevision(current: number, expected: number | undefined): void {
	if (expected !== undefined && expected !== current) {
		throw new ApprovalPolicyRevisionError(expected, current);
	}
}

export class ApprovalPolicyRevisionError extends Error {
	readonly expectedRevision: number;
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Approval policy revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
		this.name = "ApprovalPolicyRevisionError";
		this.expectedRevision = expectedRevision;
		this.currentRevision = currentRevision;
	}
}

function validateDefaults(value: unknown, partial: true): Partial<ApprovalPolicyDefaults>;
function validateDefaults(value: unknown, partial: boolean): Partial<ApprovalPolicyDefaults> {
	if (!isRecord(value)) return {};
	const result: Partial<ApprovalPolicyDefaults> = {};
	for (const tier of ["read", "write", "exec"] as const) {
		const decision = value[tier];
		if (decision === undefined && partial) continue;
		if (decision !== "ask" && decision !== "allow" && decision !== "deny") {
			throw new Error(`Approval policy ${tier} must be ask, allow, or deny`);
		}
		result[tier] = decision;
	}
	return result;
}

function isPermissionRule(value: unknown): value is PermissionRule {
	return (
		isRecord(value) &&
		typeof value.ruleId === "string" &&
		(value.decision === "allow" || value.decision === "deny") &&
		typeof value.fingerprint === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.mutable === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
			.join(",")}}`;
	}
	throw new Error(`Approval fingerprint contains unsupported ${typeof value} value`);
}
