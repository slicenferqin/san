import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ArrayExpression,
	type ArrowFunctionExpression,
	type AssignmentExpression,
	type BinaryExpression,
	type BlockStatement,
	type CallExpression,
	type Expression,
	type File,
	type FunctionDeclaration,
	type FunctionExpression,
	type FunctionParameter,
	isExpression,
	type LogicalExpression,
	type LVal,
	type MemberExpression,
	type ObjectExpression,
	type OptionalCallExpression,
	type OptionalMemberExpression,
	type PatternLike,
	type Statement,
	type UnaryExpression,
	type UpdateExpression,
	type VariableDeclaration,
} from "@babel/types";
import { Semaphore } from "../../task/parallel";
import { workflowValueHash } from "../fingerprint";
import { isWorkflowJsonValue, validateWorkflowJsonSchema, WORKFLOW_MAX_STRING_LENGTH } from "../schema";
import { parseWorkflowSource } from "../source-parser";
import type {
	WorkflowAgentBridge,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowBudgetSnapshot,
	WorkflowJsonSchema,
	WorkflowJsonValue,
	WorkflowLimits,
	WorkflowPermissionManifest,
} from "../types";
import { WorkflowRuntimeControl } from "./control";

type ProgramItem = File["program"]["body"][number];
type CallableBody = BlockStatement | Expression;
type BindingPattern = FunctionParameter | LVal;

export type WorkflowRuntimeErrorCode =
	| "agent_limit"
	| "cancelled"
	| "invalid_result"
	| "permission_denied"
	| "script_error"
	| "step_limit"
	| "time_limit"
	| "token_limit"
	| "unsupported_syntax";

export class WorkflowRuntimeError extends Error {
	readonly code: WorkflowRuntimeErrorCode;

	constructor(code: WorkflowRuntimeErrorCode, message: string) {
		super(message);
		this.name = "WorkflowRuntimeError";
		this.code = code;
	}
}

export interface WorkflowRuntimeHooks {
	onPhase?(title: string): void;
	onLog?(message: string): void;
	onAgentScheduled?(request: WorkflowAgentRequest): void;
	onAgentStarted?(request: WorkflowAgentRequest): void;
	/** Receives a result only after it fits the node's reserved hard-token allocation. */
	onAgentResult?(request: WorkflowAgentRequest, result: WorkflowAgentResult): void | Promise<void>;
	/** 报告观测到的累计用量，包括 provider 在闭锁终止前上报的超额用量。 */
	onTokensUsed?(tokensUsed: number): void;
	onAgentCompleted?(request: WorkflowAgentRequest, result: WorkflowAgentResult): void;
	onAgentFailed?(request: WorkflowAgentRequest, error: unknown): void;
	onAgentCacheHit?(callId: string, result: WorkflowAgentResult): void;
}

export interface WorkflowRuntimeOptions {
	sourceText: string;
	sourceHash: string;
	scopeKey: string;
	args?: WorkflowJsonValue;
	bridge: WorkflowAgentBridge;
	permissions: WorkflowPermissionManifest;
	limits: WorkflowLimits;
	control?: WorkflowRuntimeControl;
	signal?: AbortSignal;
	hooks?: WorkflowRuntimeHooks;
	completedCalls?: ReadonlyMap<string, WorkflowAgentResult>;
	initialAgentsStarted?: number;
	initialAgentsCompleted?: number;
	initialTokensUsed?: number;
	initialStartedAt?: number;
	maxSteps?: number;
	maxCollectionSize?: number;
	now?: () => number;
}

export interface WorkflowRuntimeResult {
	value: WorkflowJsonValue;
	budget: WorkflowBudgetSnapshot;
	phases: string[];
	logs: string[];
	completedCalls: ReadonlyMap<string, WorkflowAgentResult>;
}

class Environment {
	#values = new Map<string, unknown>();
	#parent: Environment | undefined;

	constructor(parent?: Environment) {
		this.#parent = parent;
	}

	fork(): Environment {
		const environment = new Environment(this.#parent);
		for (const [name, value] of this.#values) environment.#values.set(name, value);
		return environment;
	}

	declare(name: string, value: unknown): void {
		this.#values.set(name, value);
	}

	has(name: string): boolean {
		return this.#values.has(name) || this.#parent?.has(name) === true;
	}

	get(name: string): unknown {
		if (this.#values.has(name)) return this.#values.get(name);
		if (this.#parent) return this.#parent.get(name);
		throw new WorkflowRuntimeError("script_error", `Unknown Workflow identifier: ${name}`);
	}

	assign(name: string, value: unknown): void {
		if (this.#values.has(name)) {
			this.#values.set(name, value);
			return;
		}
		if (this.#parent) {
			this.#parent.assign(name, value);
			return;
		}
		throw new WorkflowRuntimeError("script_error", `Cannot assign undeclared Workflow identifier: ${name}`);
	}
}

type NativeHandler = (args: unknown[], callsite: number) => Promise<unknown>;

class NativeCallable {
	readonly name: string;
	#handler: NativeHandler;

	constructor(name: string, handler: NativeHandler) {
		this.name = name;
		this.#handler = handler;
	}

	invoke(args: unknown[], callsite: number): Promise<unknown> {
		return this.#handler(args, callsite);
	}
}

class InterpretedCallable {
	readonly params: FunctionParameter[];
	readonly body: CallableBody;
	readonly environment: Environment;

	constructor(params: FunctionParameter[], body: CallableBody, environment: Environment) {
		this.params = params;
		this.body = body;
		this.environment = environment;
	}
}

class ReturnFlow {
	readonly value: unknown;

	constructor(value: unknown) {
		this.value = value;
	}
}

class BreakFlow {}
class ContinueFlow {}

interface TokenLane {
	limit: number;
	used: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) throw new WorkflowRuntimeError("script_error", `${context} expects an array`);
	return value;
}

function requireCallable(value: unknown, context: string): NativeCallable | InterpretedCallable {
	if (value instanceof NativeCallable || value instanceof InterpretedCallable) return value;
	throw new WorkflowRuntimeError("script_error", `${context} expects a function`);
}

function toFiniteNumber(value: unknown, context: string): number {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new WorkflowRuntimeError("script_error", `${context} requires a finite number`);
	return number;
}

function usageTokens(result: WorkflowAgentResult): number {
	const tokens = result.usage?.totalTokens ?? 0;
	if (!Number.isSafeInteger(tokens) || tokens < 0) {
		throw new WorkflowRuntimeError("invalid_result", "Workflow agent usage must contain non-negative integer tokens");
	}
	return tokens;
}

function assertAgentResult(result: WorkflowAgentResult): void {
	if (!result.agentId || typeof result.agentId !== "string") {
		throw new WorkflowRuntimeError("invalid_result", "Workflow agent result must contain an agent id");
	}
	if (typeof result.text !== "string" || !isWorkflowJsonValue(result.value)) {
		throw new WorkflowRuntimeError("invalid_result", "Workflow agent result must contain JSON-compatible output");
	}
	if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
		throw new WorkflowRuntimeError("invalid_result", "Workflow agent result must contain a non-negative duration");
	}
}

const FORBIDDEN_MEMBER_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const DEFAULT_MAX_STEPS = 100_000;
const DEFAULT_MAX_COLLECTION_SIZE = 10_000;

/**
 * An allowlist interpreter for the documented Workflow JavaScript subset.
 * It never evals source and never exposes host objects, modules or globals.
 */
export class RestrictedWorkflowRuntime {
	#sourceText: string;
	#sourceHash: string;
	#scopeKey: string;
	#args: WorkflowJsonValue | undefined;
	#bridge: WorkflowAgentBridge;
	#permissions: WorkflowPermissionManifest;
	#limits: WorkflowLimits;
	#control: WorkflowRuntimeControl;
	#externalSignal: AbortSignal | undefined;
	#deadlineSignal: AbortSignal;
	#fatalController = new AbortController();
	#signal: AbortSignal;
	#hooks: WorkflowRuntimeHooks;
	#completedCalls: Map<string, WorkflowAgentResult>;
	#callCounters = new Map<string, number>();
	#semaphore: Semaphore;
	#agentsStarted: number;
	#agentsCompleted: number;
	#tokensUsed: number;
	#tokenLane = new AsyncLocalStorage<TokenLane>();
	#steps = 0;
	#maxSteps: number;
	#maxCollectionSize: number;
	#startedAt: number;
	#now: () => number;
	#durationExhaustedAtStart: boolean;
	#currentPhase = "workflow";
	#phases: string[] = [];
	#logs: string[] = [];
	#fatalError: WorkflowRuntimeError | undefined;
	#nodeControllers = new Map<string, AbortController>();

	constructor(options: WorkflowRuntimeOptions) {
		this.#sourceText = options.sourceText;
		this.#sourceHash = options.sourceHash;
		this.#scopeKey = options.scopeKey;
		// The interpreter may mutate its own JSON working values, but it must
		// never mutate objects owned by the host approval or caller.
		this.#args = options.args === undefined ? undefined : structuredClone(options.args);
		this.#bridge = options.bridge;
		this.#permissions = options.permissions;
		this.#limits = options.limits;
		this.#now = options.now ?? Date.now;
		this.#control = options.control ?? new WorkflowRuntimeControl();
		this.#externalSignal = options.signal;
		const initialStartedAt = options.initialStartedAt ?? this.#now();
		const elapsedBeforeStart = Math.max(0, this.#now() - initialStartedAt);
		this.#durationExhaustedAtStart = elapsedBeforeStart >= options.limits.durationMs;
		const remainingDurationMs = Math.max(1, options.limits.durationMs - elapsedBeforeStart);
		this.#deadlineSignal = AbortSignal.timeout(remainingDurationMs);
		const signals = [this.#control.signal, this.#deadlineSignal, this.#fatalController.signal];
		if (options.signal) signals.push(options.signal);
		this.#signal = AbortSignal.any(signals);
		this.#hooks = options.hooks ?? {};
		this.#completedCalls = new Map(options.completedCalls ?? []);
		this.#semaphore = new Semaphore(options.limits.concurrency);
		this.#agentsStarted = options.initialAgentsStarted ?? 0;
		this.#agentsCompleted = options.initialAgentsCompleted ?? 0;
		this.#tokensUsed = options.initialTokensUsed ?? 0;
		this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
		this.#maxCollectionSize = options.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE;
		this.#startedAt = initialStartedAt;
	}

	get control(): WorkflowRuntimeControl {
		return this.#control;
	}

	cancelNode(nodeId: string, reason = "Workflow Agent cancelled by user"): boolean {
		const controller = this.#nodeControllers.get(nodeId);
		if (!controller || controller.signal.aborted) return false;
		controller.abort(new WorkflowRuntimeError("cancelled", reason));
		return true;
	}

	async execute(): Promise<WorkflowRuntimeResult> {
		if (this.#durationExhaustedAtStart) {
			throw new WorkflowRuntimeError("time_limit", `Workflow exceeded its ${this.#limits.durationMs}ms time limit`);
		}
		if (this.#signal.aborted) throw this.#signalError();
		const parsed = parseWorkflowSource(this.#sourceText);
		if (parsed.violations.length > 0) {
			throw new WorkflowRuntimeError("permission_denied", parsed.violations.join("; "));
		}
		const environment = this.#createRootEnvironment();
		let result: unknown = null;
		try {
			for (const statement of parsed.ast.program.body) await this.#executeProgramItem(statement, environment);
		} catch (error) {
			if (error instanceof ReturnFlow) result = error.value;
			else throw this.#normalizeError(error);
		}
		if (result === undefined) result = null;
		if (!isWorkflowJsonValue(result)) {
			throw new WorkflowRuntimeError("invalid_result", "Workflow final result must be JSON-compatible");
		}
		return {
			value: result,
			budget: this.#budgetSnapshot(),
			phases: [...this.#phases],
			logs: [...this.#logs],
			completedCalls: new Map(this.#completedCalls),
		};
	}

	#createRootEnvironment(): Environment {
		const environment = new Environment();
		environment.declare("undefined", undefined);
		environment.declare("args", this.#args);
		environment.declare("agent", new NativeCallable("agent", (args, callsite) => this.#runAgent(args, callsite)));
		environment.declare("parallel", new NativeCallable("parallel", args => this.#runParallel(args)));
		environment.declare("pipeline", new NativeCallable("pipeline", args => this.#runPipeline(args)));
		environment.declare("phase", new NativeCallable("phase", args => this.#setPhase(args)));
		environment.declare("log", new NativeCallable("log", args => this.#recordLog(args)));
		environment.declare("Boolean", new NativeCallable("Boolean", async args => Boolean(args[0])));
		environment.declare("String", new NativeCallable("String", async args => String(args[0] ?? "")));
		environment.declare("Number", new NativeCallable("Number", async args => Number(args[0])));
		environment.declare("Array", new NativeCallable("Array", async args => [...args]));
		environment.declare(
			"Object",
			new NativeCallable("Object", async args => (isPlainObject(args[0]) ? { ...args[0] } : {})),
		);
		environment.declare(
			"parseInt",
			new NativeCallable("parseInt", async args => Number.parseInt(String(args[0]), Number(args[1] ?? 10))),
		);
		environment.declare(
			"parseFloat",
			new NativeCallable("parseFloat", async args => Number.parseFloat(String(args[0]))),
		);
		environment.declare("JSON", {
			parse: new NativeCallable("JSON.parse", async args => this.#parseJson(args[0])),
			stringify: new NativeCallable("JSON.stringify", async args => this.#stringifyJson(args[0])),
		});
		environment.declare("Math", {
			PI: Math.PI,
			E: Math.E,
			abs: new NativeCallable("Math.abs", async args => Math.abs(toFiniteNumber(args[0], "Math.abs"))),
			ceil: new NativeCallable("Math.ceil", async args => Math.ceil(toFiniteNumber(args[0], "Math.ceil"))),
			floor: new NativeCallable("Math.floor", async args => Math.floor(toFiniteNumber(args[0], "Math.floor"))),
			max: new NativeCallable("Math.max", async args =>
				Math.max(...args.map(value => toFiniteNumber(value, "Math.max"))),
			),
			min: new NativeCallable("Math.min", async args =>
				Math.min(...args.map(value => toFiniteNumber(value, "Math.min"))),
			),
			round: new NativeCallable("Math.round", async args => Math.round(toFiniteNumber(args[0], "Math.round"))),
		});
		environment.declare("budget", {
			total: new NativeCallable("budget.total", async () => this.#limits.tokenLimit),
			spent: new NativeCallable("budget.spent", async () => this.#tokensUsed),
			remaining: new NativeCallable("budget.remaining", async () =>
				Math.max(0, this.#limits.tokenLimit - this.#tokensUsed),
			),
			hard: new NativeCallable("budget.hard", async () => true),
		});
		return environment;
	}

	async #tick(): Promise<void> {
		this.#steps++;
		if (this.#steps > this.#maxSteps) {
			throw this.#setFatal("step_limit", `Workflow exceeded the ${this.#maxSteps} interpreter-step limit`);
		}
		if (this.#signal.aborted) throw this.#signalError();
		await this.#control.checkpoint(this.#signal);
		if (this.#signal.aborted) throw this.#signalError();
	}

	#setFatal(code: WorkflowRuntimeErrorCode, message: string): WorkflowRuntimeError {
		const error = new WorkflowRuntimeError(code, message);
		if (!this.#fatalError) {
			this.#fatalError = error;
			this.#fatalController.abort(error);
		}
		return this.#fatalError;
	}

	#signalError(): WorkflowRuntimeError {
		if (this.#fatalError) return this.#fatalError;
		if (this.#deadlineSignal.aborted) {
			return new WorkflowRuntimeError("time_limit", `Workflow exceeded its ${this.#limits.durationMs}ms time limit`);
		}
		if (this.#control.signal.aborted || this.#externalSignal?.aborted) {
			return new WorkflowRuntimeError("cancelled", "Workflow was cancelled");
		}
		return new WorkflowRuntimeError("cancelled", "Workflow execution was aborted");
	}

	#normalizeError(error: unknown): Error {
		if (this.#fatalError) return this.#fatalError;
		if (this.#signal.aborted) return this.#signalError();
		if (error instanceof Error) return error;
		return new WorkflowRuntimeError("script_error", String(error));
	}

	#normalizeAgentError(error: unknown): Error {
		if (this.#fatalError) return this.#fatalError;
		if (this.#signal.aborted) return this.#signalError();
		if (error instanceof WorkflowRuntimeError) return error;
		if (error instanceof Error) return error;
		return new WorkflowRuntimeError("script_error", String(error));
	}

	#budgetSnapshot(): WorkflowBudgetSnapshot {
		return {
			agentsStarted: this.#agentsStarted,
			agentsCompleted: this.#agentsCompleted,
			tokensUsed: this.#tokensUsed,
			startedAt: new Date(this.#startedAt).toISOString(),
			elapsedMs: Math.max(0, this.#now() - this.#startedAt),
			limits: { ...this.#limits },
		};
	}

	#nextCallIdentity(callsite: number, inputHash: string): { callId: string; nodeId: string } {
		const counterKey = `${callsite}:${inputHash}`;
		const invocation = this.#callCounters.get(counterKey) ?? 0;
		this.#callCounters.set(counterKey, invocation + 1);
		const digest = workflowValueHash({ sourceHash: this.#sourceHash, callsite, inputHash, invocation });
		return { callId: `workflow-call-${digest.slice(0, 32)}`, nodeId: `workflow-node-${digest}` };
	}

	async #runAgent(args: unknown[], callsite: number): Promise<WorkflowJsonValue> {
		await this.#tick();
		const prompt = typeof args[0] === "string" ? args[0].trim() : "";
		if (!prompt) throw new WorkflowRuntimeError("script_error", "agent() requires a non-empty prompt");
		if (prompt.length > WORKFLOW_MAX_STRING_LENGTH) {
			throw new WorkflowRuntimeError(
				"script_error",
				`agent() prompt exceeds the ${WORKFLOW_MAX_STRING_LENGTH}-character limit`,
			);
		}
		const options = args[1] === undefined ? {} : args[1];
		if (!isPlainObject(options)) throw new WorkflowRuntimeError("script_error", "agent() options must be an object");
		const allowedKeys = new Set(["agent", "label", "model", "schema"]);
		const unknownKeys = Object.keys(options).filter(key => !allowedKeys.has(key));
		if (unknownKeys.length > 0) {
			throw new WorkflowRuntimeError(
				"permission_denied",
				`agent() options are not allowed: ${unknownKeys.sort().join(", ")}`,
			);
		}
		const agent = options.agent;
		const label = options.label;
		const model = options.model;
		if (agent !== undefined && typeof agent !== "string")
			throw new WorkflowRuntimeError("script_error", "agent option must be a string");
		if (label !== undefined && typeof label !== "string")
			throw new WorkflowRuntimeError("script_error", "label option must be a string");
		if (
			model !== undefined &&
			typeof model !== "string" &&
			(!Array.isArray(model) || model.some(item => typeof item !== "string"))
		) {
			throw new WorkflowRuntimeError("script_error", "model option must be a string or string array");
		}
		let schema: WorkflowJsonSchema | undefined;
		if (options.schema !== undefined) {
			if (!isPlainObject(options.schema) || !isWorkflowJsonValue(options.schema)) {
				throw new WorkflowRuntimeError("script_error", "schema option must be JSON-compatible");
			}
			try {
				schema = validateWorkflowJsonSchema(options.schema, "agent.schema");
			} catch (error) {
				throw new WorkflowRuntimeError(
					"script_error",
					error instanceof Error ? error.message : "agent.schema is invalid",
				);
			}
		}
		const inputHash = workflowValueHash({
			prompt,
			agent: agent ?? null,
			model: model ?? null,
			label: label ?? null,
			schema: schema ?? null,
			scopeKey: this.#scopeKey,
			allowedTools: [...this.#permissions.tools].sort(),
			writeMode: this.#permissions.writeMode,
		});
		const identity = this.#nextCallIdentity(callsite, inputHash);
		const cached = this.#completedCalls.get(identity.callId);
		if (cached) {
			assertAgentResult(cached);
			usageTokens(cached);
			this.#hooks.onAgentCacheHit?.(identity.callId, cached);
			return structuredClone(cached.value);
		}
		let acquired = false;
		let request: WorkflowAgentRequest | undefined;
		let nodeController: AbortController | undefined;
		try {
			await this.#semaphore.acquire(this.#signal);
			acquired = true;
			if (this.#agentsStarted >= this.#limits.agentLimit) {
				throw this.#setFatal("agent_limit", `Workflow reached its ${this.#limits.agentLimit}-agent hard limit`);
			}
			const lane = this.#tokenLane.getStore();
			const availableTokens = lane ? lane.limit - lane.used : this.#limits.tokenLimit - this.#tokensUsed;
			if (availableTokens < 1) {
				throw this.#setFatal("token_limit", `Workflow reached its ${this.#limits.tokenLimit}-token hard limit`);
			}
			nodeController = new AbortController();
			this.#nodeControllers.set(identity.nodeId, nodeController);
			request = {
				...identity,
				inputHash,
				phase: this.#currentPhase,
				scopeKey: this.#scopeKey,
				prompt,
				agent,
				model: model as string | string[] | undefined,
				label,
				schema,
				allowedTools: [...this.#permissions.tools],
				writeMode: this.#permissions.writeMode,
				remainingTokenBudget: availableTokens,
				signal: AbortSignal.any([this.#signal, nodeController.signal]),
			};
			this.#agentsStarted++;
			this.#hooks.onAgentScheduled?.(request);
			this.#hooks.onAgentStarted?.(request);
			const result = await this.#bridge.run(request);
			assertAgentResult(result);
			const actualTokens = usageTokens(result);
			if (actualTokens > availableTokens) {
				if (lane) lane.used += actualTokens;
				this.#tokensUsed += actualTokens;
				this.#hooks.onTokensUsed?.(this.#tokensUsed);
				throw this.#setFatal(
					"token_limit",
					`Workflow agent exceeded its ${availableTokens}-token allocation from the approved ${this.#limits.tokenLimit}-token budget`,
				);
			}
			await this.#hooks.onAgentResult?.(request, result);
			if (lane) lane.used += actualTokens;
			this.#tokensUsed += actualTokens;
			this.#hooks.onTokensUsed?.(this.#tokensUsed);
			this.#agentsCompleted++;
			const committed = structuredClone(result);
			this.#completedCalls.set(identity.callId, committed);
			this.#hooks.onAgentCompleted?.(request, committed);
			return structuredClone(committed.value);
		} catch (error) {
			if (request) this.#hooks.onAgentFailed?.(request, error);
			throw this.#normalizeAgentError(error);
		} finally {
			if (nodeController) this.#nodeControllers.delete(identity.nodeId);
			if (acquired) this.#semaphore.release();
		}
	}

	async #runParallel(args: unknown[]): Promise<unknown[]> {
		const thunks = requireArray(args[0], "parallel()");
		return this.#runPool(thunks, (thunk, index) => this.#invoke(requireCallable(thunk, "parallel()"), [index], 0));
	}

	async #runPipeline(args: unknown[]): Promise<unknown[]> {
		let current = [...requireArray(args[0], "pipeline()")];
		this.#ensureCollectionSize(current.length, "pipeline input");
		for (const stageValue of args.slice(1)) {
			const stage = requireCallable(stageValue, "pipeline()");
			current = await this.#runPool(current, (item, index) => this.#invoke(stage, [item, index], 0));
		}
		return current;
	}

	async #runPool<T>(items: T[], run: (item: T, index: number) => Promise<unknown>): Promise<unknown[]> {
		this.#ensureCollectionSize(items.length, "Workflow fan-out");
		if (items.length === 0) return [];
		const parentLane = this.#tokenLane.getStore();
		const availableTokens = parentLane
			? parentLane.limit - parentLane.used
			: this.#limits.tokenLimit - this.#tokensUsed;
		const laneLimit = Math.floor(availableTokens / items.length);
		if (laneLimit < 1) {
			throw this.#setFatal(
				"token_limit",
				`Workflow cannot allocate its remaining ${Math.max(0, availableTokens)} tokens across ${items.length} parallel branches`,
			);
		}
		const lanes = items.map((): TokenLane => ({ limit: laneLimit, used: 0 }));
		const results: unknown[] = new Array(items.length);
		const errors = new Map<number, unknown>();
		let nextIndex = 0;
		let stopped = false;
		const worker = async (): Promise<void> => {
			while (!stopped) {
				const index = nextIndex++;
				if (index >= items.length) return;
				try {
					results[index] = await this.#tokenLane.run(lanes[index]!, () => run(items[index], index));
				} catch (error) {
					errors.set(index, error);
					stopped = true;
				}
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(this.#limits.concurrency, items.length) }, () => worker()));
		} finally {
			if (parentLane) parentLane.used += lanes.reduce((sum, lane) => sum + lane.used, 0);
		}
		if (errors.size > 0) {
			const firstIndex = Math.min(...errors.keys());
			throw errors.get(firstIndex);
		}
		return results;
	}

	async #setPhase(args: unknown[]): Promise<undefined> {
		const title = String(args[0] ?? "").trim();
		if (!title) throw new WorkflowRuntimeError("script_error", "phase() requires a title");
		if (title.length > 1_000) throw new WorkflowRuntimeError("script_error", "phase() title is too long");
		this.#currentPhase = title;
		this.#ensureCollectionSize(this.#phases.length + 1, "Workflow phase history");
		this.#phases.push(title);
		this.#hooks.onPhase?.(title);
		return undefined;
	}

	async #recordLog(args: unknown[]): Promise<undefined> {
		const message = args.map(value => this.#displayValue(value)).join(" ");
		if (message.length > WORKFLOW_MAX_STRING_LENGTH) {
			throw new WorkflowRuntimeError("script_error", "Workflow log message is too long");
		}
		this.#ensureCollectionSize(this.#logs.length + 1, "Workflow log history");
		this.#logs.push(message);
		this.#hooks.onLog?.(message);
		return undefined;
	}

	#displayValue(value: unknown): string {
		if (value instanceof NativeCallable || value instanceof InterpretedCallable) return "[function]";
		if (isWorkflowJsonValue(value)) return typeof value === "string" ? value : JSON.stringify(value);
		return String(value);
	}

	#parseJson(value: unknown): WorkflowJsonValue {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(value));
		} catch (error) {
			throw new WorkflowRuntimeError(
				"script_error",
				`JSON.parse failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isWorkflowJsonValue(parsed))
			throw new WorkflowRuntimeError("script_error", "JSON.parse produced an unsupported value");
		return parsed;
	}

	#stringifyJson(value: unknown): string {
		if (!isWorkflowJsonValue(value))
			throw new WorkflowRuntimeError("script_error", "JSON.stringify only accepts JSON-compatible data");
		return JSON.stringify(value);
	}

	#ensureCollectionSize(size: number, context: string): void {
		if (size > this.#maxCollectionSize) {
			throw this.#setFatal("step_limit", `${context} exceeds the ${this.#maxCollectionSize}-item collection limit`);
		}
	}

	async #executeProgramItem(statement: ProgramItem, environment: Environment): Promise<void> {
		await this.#tick();
		if (statement.type === "ExportNamedDeclaration") {
			const declaration = statement.declaration;
			if (!declaration) {
				throw new WorkflowRuntimeError("unsupported_syntax", "Workflow re-exports are not supported");
			}
			if (declaration.type === "VariableDeclaration") {
				await this.#executeVariableDeclaration(declaration, environment, true);
				return;
			}
			if (declaration.type === "FunctionDeclaration") {
				this.#declareFunction(declaration, environment);
				return;
			}
			throw new WorkflowRuntimeError("unsupported_syntax", `Unsupported Workflow export: ${declaration.type}`);
		}
		if (statement.type === "ExportDefaultDeclaration" || statement.type === "ExportAllDeclaration") {
			throw new WorkflowRuntimeError("unsupported_syntax", `${statement.type} is not supported`);
		}
		await this.#executeStatement(statement, environment);
	}

	async #executeStatement(statement: Statement, environment: Environment): Promise<void> {
		await this.#tick();
		switch (statement.type) {
			case "VariableDeclaration":
				await this.#executeVariableDeclaration(statement, environment, false);
				return;
			case "FunctionDeclaration":
				this.#declareFunction(statement, environment);
				return;
			case "ExpressionStatement":
				await this.#evaluate(statement.expression, environment);
				return;
			case "ReturnStatement":
				throw new ReturnFlow(
					statement.argument ? await this.#evaluate(statement.argument, environment) : undefined,
				);
			case "BlockStatement":
				await this.#executeBlock(statement, new Environment(environment));
				return;
			case "IfStatement":
				if (await this.#evaluate(statement.test, environment)) {
					await this.#executeStatement(statement.consequent, environment);
				} else if (statement.alternate) {
					await this.#executeStatement(statement.alternate, environment);
				}
				return;
			case "ForStatement":
				await this.#executeFor(statement, environment);
				return;
			case "ForOfStatement":
				await this.#executeForOf(statement, environment);
				return;
			case "ForInStatement":
				await this.#executeForIn(statement, environment);
				return;
			case "WhileStatement":
				while (await this.#evaluate(statement.test, environment)) {
					if (await this.#executeLoopBody(statement.body, environment)) break;
				}
				return;
			case "DoWhileStatement":
				do {
					if (await this.#executeLoopBody(statement.body, environment)) break;
				} while (await this.#evaluate(statement.test, environment));
				return;
			case "BreakStatement":
				if (statement.label) throw new WorkflowRuntimeError("unsupported_syntax", "Labeled break is not supported");
				throw new BreakFlow();
			case "ContinueStatement":
				if (statement.label)
					throw new WorkflowRuntimeError("unsupported_syntax", "Labeled continue is not supported");
				throw new ContinueFlow();
			case "SwitchStatement":
				await this.#executeSwitch(statement, environment);
				return;
			case "ThrowStatement": {
				const thrown = await this.#evaluate(statement.argument, environment);
				throw new WorkflowRuntimeError("script_error", `Workflow script threw: ${this.#displayValue(thrown)}`);
			}
			case "TryStatement":
				await this.#executeTry(statement, environment);
				return;
			case "EmptyStatement":
				return;
			default:
				throw new WorkflowRuntimeError("unsupported_syntax", `Unsupported Workflow statement: ${statement.type}`);
		}
	}

	async #executeBlock(block: BlockStatement, environment: Environment): Promise<void> {
		for (const statement of block.body) await this.#executeStatement(statement, environment);
	}

	async #executeVariableDeclaration(
		declaration: VariableDeclaration,
		environment: Environment,
		skipMeta: boolean,
	): Promise<void> {
		for (const item of declaration.declarations) {
			if (skipMeta && item.id.type === "Identifier" && item.id.name === "meta") continue;
			const value = item.init ? await this.#evaluate(item.init, environment) : undefined;
			await this.#bindPattern(item.id, value, environment, true);
		}
	}

	#declareFunction(declaration: FunctionDeclaration, environment: Environment): void {
		if (!declaration.id)
			throw new WorkflowRuntimeError("script_error", "Workflow function declarations must have names");
		if (declaration.async && declaration.generator) {
			throw new WorkflowRuntimeError("unsupported_syntax", "Async generator functions are not supported");
		}
		if (declaration.generator)
			throw new WorkflowRuntimeError("unsupported_syntax", "Generator functions are not supported");
		environment.declare(
			declaration.id.name,
			new InterpretedCallable(declaration.params, declaration.body, environment),
		);
	}

	async #bindPattern(
		pattern: BindingPattern,
		value: unknown,
		environment: Environment,
		declare: boolean,
	): Promise<void> {
		switch (pattern.type) {
			case "Identifier":
				if (declare) environment.declare(pattern.name, value);
				else environment.assign(pattern.name, value);
				return;
			case "AssignmentPattern":
				await this.#bindPattern(
					pattern.left,
					value === undefined ? await this.#evaluate(pattern.right, environment) : value,
					environment,
					declare,
				);
				return;
			case "RestElement":
				await this.#bindPattern(pattern.argument, value, environment, declare);
				return;
			case "ArrayPattern": {
				const values = requireArray(value, "Array destructuring");
				for (let index = 0; index < pattern.elements.length; index++) {
					const element = pattern.elements[index];
					if (element) await this.#bindPattern(element, values[index], environment, declare);
				}
				return;
			}
			case "ObjectPattern": {
				if (!isPlainObject(value))
					throw new WorkflowRuntimeError("script_error", "Object destructuring expects an object");
				const used = new Set<string>();
				for (const property of pattern.properties) {
					if (property.type === "RestElement") {
						const rest: Record<string, unknown> = {};
						for (const [key, child] of Object.entries(value)) if (!used.has(key)) rest[key] = child;
						await this.#bindPattern(property.argument, rest, environment, declare);
						continue;
					}
					const key = await this.#objectPropertyKey(property, environment);
					used.add(key);
					await this.#bindPattern(property.value as PatternLike, value[key], environment, declare);
				}
				return;
			}
			default:
				throw new WorkflowRuntimeError("unsupported_syntax", `Unsupported binding pattern: ${pattern.type}`);
		}
	}

	async #executeFor(
		statement: Extract<ProgramItem, { type: "ForStatement" }>,
		environment: Environment,
	): Promise<void> {
		const loopEnvironment = new Environment(environment);
		if (statement.init?.type === "VariableDeclaration") {
			await this.#executeVariableDeclaration(statement.init, loopEnvironment, false);
		} else if (statement.init) {
			await this.#evaluate(statement.init, loopEnvironment);
		}
		let iterationEnvironment = loopEnvironment;
		while (!statement.test || (await this.#evaluate(statement.test, iterationEnvironment))) {
			const bodyEnvironment = iterationEnvironment.fork();
			const broken = await this.#executeLoopBody(statement.body, bodyEnvironment);
			if (broken) break;
			iterationEnvironment = bodyEnvironment.fork();
			if (statement.update) await this.#evaluate(statement.update, iterationEnvironment);
		}
	}

	async #executeForOf(
		statement: Extract<ProgramItem, { type: "ForOfStatement" }>,
		environment: Environment,
	): Promise<void> {
		if (statement.await) throw new WorkflowRuntimeError("unsupported_syntax", "for await is not supported");
		const right = await this.#evaluate(statement.right, environment);
		const values = Array.isArray(right) ? right : typeof right === "string" ? [...right] : undefined;
		if (!values) throw new WorkflowRuntimeError("script_error", "for...of expects an array or string");
		for (const value of values) {
			const loopEnvironment = new Environment(environment);
			await this.#assignLoopLeft(statement.left, value, loopEnvironment);
			if (await this.#executeLoopBody(statement.body, loopEnvironment)) break;
		}
	}

	async #executeForIn(
		statement: Extract<ProgramItem, { type: "ForInStatement" }>,
		environment: Environment,
	): Promise<void> {
		const right = await this.#evaluate(statement.right, environment);
		if (!isPlainObject(right) && !Array.isArray(right)) {
			throw new WorkflowRuntimeError("script_error", "for...in expects an object or array");
		}
		for (const key of Object.keys(right)) {
			const loopEnvironment = new Environment(environment);
			await this.#assignLoopLeft(statement.left, key, loopEnvironment);
			if (await this.#executeLoopBody(statement.body, loopEnvironment)) break;
		}
	}

	async #assignLoopLeft(
		left: Extract<ProgramItem, { type: "ForOfStatement" | "ForInStatement" }>["left"],
		value: unknown,
		environment: Environment,
	): Promise<void> {
		if (left.type === "VariableDeclaration") {
			const item = left.declarations[0];
			if (!item || left.declarations.length !== 1) {
				throw new WorkflowRuntimeError("script_error", "Loop declarations must contain one binding");
			}
			await this.#bindPattern(item.id, value, environment, true);
			return;
		}
		await this.#assignTarget(left, value, environment);
	}

	async #executeLoopBody(
		body: Extract<
			ProgramItem,
			{ type: "ForStatement" | "ForOfStatement" | "ForInStatement" | "WhileStatement" | "DoWhileStatement" }
		>["body"],
		environment: Environment,
	): Promise<boolean> {
		try {
			await this.#executeStatement(body, environment);
			return false;
		} catch (error) {
			if (error instanceof ContinueFlow) return false;
			if (error instanceof BreakFlow) return true;
			throw error;
		}
	}

	async #executeSwitch(
		statement: Extract<ProgramItem, { type: "SwitchStatement" }>,
		environment: Environment,
	): Promise<void> {
		const discriminant = await this.#evaluate(statement.discriminant, environment);
		let active = false;
		try {
			for (const branch of statement.cases) {
				const test = branch.test;
				if (
					!active &&
					(test === null || test === undefined || (await this.#evaluate(test, environment)) === discriminant)
				) {
					active = true;
				}
				if (!active) continue;
				for (const child of branch.consequent) await this.#executeStatement(child, environment);
			}
		} catch (error) {
			if (!(error instanceof BreakFlow)) throw error;
		}
	}

	async #executeTry(
		statement: Extract<ProgramItem, { type: "TryStatement" }>,
		environment: Environment,
	): Promise<void> {
		try {
			await this.#executeBlock(statement.block, new Environment(environment));
		} catch (error) {
			if (error instanceof ReturnFlow || error instanceof BreakFlow || error instanceof ContinueFlow) throw error;
			if (error instanceof WorkflowRuntimeError && error.code !== "script_error") throw error;
			if (!statement.handler) throw error;
			const catchEnvironment = new Environment(environment);
			if (statement.handler.param) {
				const message = error instanceof Error ? error.message : String(error);
				await this.#bindPattern(statement.handler.param, { message }, catchEnvironment, true);
			}
			await this.#executeBlock(statement.handler.body, catchEnvironment);
		} finally {
			if (statement.finalizer) await this.#executeBlock(statement.finalizer, new Environment(environment));
		}
	}

	async #evaluate(expression: Expression, environment: Environment): Promise<unknown> {
		await this.#tick();
		switch (expression.type) {
			case "StringLiteral":
			case "BooleanLiteral":
			case "NumericLiteral":
				return expression.value;
			case "NullLiteral":
				return null;
			case "Identifier":
				return environment.get(expression.name);
			case "ArrayExpression":
				return this.#evaluateArray(expression, environment);
			case "ObjectExpression":
				return this.#evaluateObject(expression, environment);
			case "TemplateLiteral": {
				let value = "";
				for (let index = 0; index < expression.quasis.length; index++) {
					value += expression.quasis[index]?.value.cooked ?? expression.quasis[index]?.value.raw ?? "";
					const child = expression.expressions[index];
					if (child) {
						if (!isExpression(child))
							throw new WorkflowRuntimeError("unsupported_syntax", "Type expressions are not supported");
						value += String(await this.#evaluate(child, environment));
					}
				}
				return value;
			}
			case "UnaryExpression":
				return this.#evaluateUnary(expression, environment);
			case "BinaryExpression":
				return this.#evaluateBinary(expression, environment);
			case "LogicalExpression":
				return this.#evaluateLogical(expression, environment);
			case "ConditionalExpression":
				return (await this.#evaluate(expression.test, environment))
					? this.#evaluate(expression.consequent, environment)
					: this.#evaluate(expression.alternate, environment);
			case "SequenceExpression": {
				let value: unknown;
				for (const child of expression.expressions) value = await this.#evaluate(child, environment);
				return value;
			}
			case "AwaitExpression":
				return this.#evaluate(expression.argument, environment);
			case "ArrowFunctionExpression":
			case "FunctionExpression":
				return this.#createInterpretedCallable(expression, environment);
			case "CallExpression":
			case "OptionalCallExpression":
				return this.#evaluateCall(expression, environment);
			case "MemberExpression":
			case "OptionalMemberExpression": {
				const target = await this.#memberTarget(expression, environment);
				if (!target) return undefined;
				return this.#getMember(target.object, target.key);
			}
			case "AssignmentExpression":
				return this.#evaluateAssignment(expression, environment);
			case "UpdateExpression":
				return this.#evaluateUpdate(expression, environment);
			case "ParenthesizedExpression":
				return this.#evaluate(expression.expression, environment);
			default:
				throw new WorkflowRuntimeError("unsupported_syntax", `Unsupported Workflow expression: ${expression.type}`);
		}
	}

	async #evaluateArray(expression: ArrayExpression, environment: Environment): Promise<unknown[]> {
		const result: unknown[] = [];
		for (const element of expression.elements) {
			if (!element) {
				result.push(undefined);
				continue;
			}
			if (element.type === "SpreadElement") {
				const spread = await this.#evaluate(element.argument, environment);
				if (Array.isArray(spread)) result.push(...spread);
				else if (typeof spread === "string") result.push(...spread);
				else throw new WorkflowRuntimeError("script_error", "Array spread expects an array or string");
			} else {
				result.push(await this.#evaluate(element, environment));
			}
			this.#ensureCollectionSize(result.length, "Workflow array");
		}
		return result;
	}

	async #evaluateObject(expression: ObjectExpression, environment: Environment): Promise<Record<string, unknown>> {
		const result: Record<string, unknown> = {};
		for (const property of expression.properties) {
			if (property.type === "SpreadElement") {
				const spread = await this.#evaluate(property.argument, environment);
				if (!isPlainObject(spread))
					throw new WorkflowRuntimeError("script_error", "Object spread expects a plain object");
				for (const [key, value] of Object.entries(spread)) {
					this.#assertSafeMemberKey(key);
					result[key] = value;
				}
				continue;
			}
			if (property.type !== "ObjectProperty") {
				throw new WorkflowRuntimeError("unsupported_syntax", "Object methods are not supported");
			}
			const key = await this.#objectPropertyKey(property, environment);
			const child = property.value;
			if (child.type === "AssignmentPattern") {
				throw new WorkflowRuntimeError("unsupported_syntax", "Object assignment properties are not supported");
			}
			result[key] = await this.#evaluate(child as Expression, environment);
			this.#ensureCollectionSize(Object.keys(result).length, "Workflow object");
		}
		return result;
	}

	async #objectPropertyKey(
		property: Extract<ObjectExpression["properties"][number], { type: "ObjectProperty" }>,
		environment: Environment,
	): Promise<string> {
		let key: string;
		if (property.computed) {
			key = String(await this.#evaluate(property.key as Expression, environment));
		} else if (property.key.type === "Identifier") {
			key = property.key.name;
		} else if (property.key.type === "StringLiteral" || property.key.type === "NumericLiteral") {
			key = String(property.key.value);
		} else {
			throw new WorkflowRuntimeError("unsupported_syntax", `Unsupported object property key: ${property.key.type}`);
		}
		this.#assertSafeMemberKey(key);
		return key;
	}

	#createInterpretedCallable(
		expression: ArrowFunctionExpression | FunctionExpression,
		environment: Environment,
	): InterpretedCallable {
		if (expression.generator)
			throw new WorkflowRuntimeError("unsupported_syntax", "Generator functions are not supported");
		return new InterpretedCallable(expression.params, expression.body, environment);
	}

	async #evaluateUnary(expression: UnaryExpression, environment: Environment): Promise<unknown> {
		if (
			expression.operator === "typeof" &&
			expression.argument.type === "Identifier" &&
			!environment.has(expression.argument.name)
		) {
			return "undefined";
		}
		const value = await this.#evaluate(expression.argument, environment);
		switch (expression.operator) {
			case "!":
				return !value;
			case "+":
				return toFiniteNumber(value, "Unary plus");
			case "-":
				return -toFiniteNumber(value, "Unary minus");
			case "~":
				return ~toFiniteNumber(value, "Bitwise not");
			case "typeof":
				return value instanceof NativeCallable || value instanceof InterpretedCallable ? "function" : typeof value;
			case "void":
				return undefined;
			default:
				throw new WorkflowRuntimeError(
					"unsupported_syntax",
					`Unary operator ${expression.operator} is not supported`,
				);
		}
	}

	async #evaluateBinary(expression: BinaryExpression, environment: Environment): Promise<unknown> {
		if (!isExpression(expression.left)) {
			throw new WorkflowRuntimeError("unsupported_syntax", "Private names are not supported");
		}
		const left = await this.#evaluate(expression.left, environment);
		const right = await this.#evaluate(expression.right, environment);
		switch (expression.operator) {
			case "+":
				return typeof left === "string" || typeof right === "string"
					? String(left) + String(right)
					: toFiniteNumber(left, "Addition") + toFiniteNumber(right, "Addition");
			case "-":
				return toFiniteNumber(left, "Subtraction") - toFiniteNumber(right, "Subtraction");
			case "*":
				return toFiniteNumber(left, "Multiplication") * toFiniteNumber(right, "Multiplication");
			case "/":
				return toFiniteNumber(left, "Division") / toFiniteNumber(right, "Division");
			case "%":
				return toFiniteNumber(left, "Remainder") % toFiniteNumber(right, "Remainder");
			case "**":
				return toFiniteNumber(left, "Exponentiation") ** toFiniteNumber(right, "Exponentiation");
			case "===":
				return left === right;
			case "!==":
				return left !== right;
			case "<":
				return this.#compareValues(left, right) < 0;
			case "<=":
				return this.#compareValues(left, right) <= 0;
			case ">":
				return this.#compareValues(left, right) > 0;
			case ">=":
				return this.#compareValues(left, right) >= 0;
			case "|":
				return toFiniteNumber(left, "Bitwise or") | toFiniteNumber(right, "Bitwise or");
			case "&":
				return toFiniteNumber(left, "Bitwise and") & toFiniteNumber(right, "Bitwise and");
			case "^":
				return toFiniteNumber(left, "Bitwise xor") ^ toFiniteNumber(right, "Bitwise xor");
			case "<<":
				return toFiniteNumber(left, "Left shift") << toFiniteNumber(right, "Left shift");
			case ">>":
				return toFiniteNumber(left, "Right shift") >> toFiniteNumber(right, "Right shift");
			case ">>>":
				return toFiniteNumber(left, "Unsigned right shift") >>> toFiniteNumber(right, "Unsigned right shift");
			case "in": {
				const key = String(left);
				this.#assertSafeMemberKey(key);
				return (isPlainObject(right) || Array.isArray(right)) && Object.hasOwn(right, key);
			}
			default:
				throw new WorkflowRuntimeError(
					"unsupported_syntax",
					`Binary operator ${expression.operator} is not supported`,
				);
		}
	}

	#compareValues(left: unknown, right: unknown): number {
		if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
		return toFiniteNumber(left, "Comparison") - toFiniteNumber(right, "Comparison");
	}

	async #evaluateLogical(expression: LogicalExpression, environment: Environment): Promise<unknown> {
		const left = await this.#evaluate(expression.left, environment);
		if (expression.operator === "&&") return left ? this.#evaluate(expression.right, environment) : left;
		if (expression.operator === "||") return left ? left : this.#evaluate(expression.right, environment);
		return left === null || left === undefined ? this.#evaluate(expression.right, environment) : left;
	}

	async #evaluateCall(
		expression: CallExpression | OptionalCallExpression,
		environment: Environment,
	): Promise<unknown> {
		const args = await this.#evaluateCallArguments(expression.arguments, environment);
		const callsite = expression.start ?? 0;
		if (expression.callee.type === "MemberExpression" || expression.callee.type === "OptionalMemberExpression") {
			const target = await this.#memberTarget(expression.callee, environment);
			if (!target) return undefined;
			return this.#invokeMember(target.object, target.key, args, callsite);
		}
		if (expression.callee.type === "Super" || expression.callee.type === "V8IntrinsicIdentifier") {
			throw new WorkflowRuntimeError("unsupported_syntax", "Unsupported Workflow call target");
		}
		const callable = requireCallable(await this.#evaluate(expression.callee, environment), "Function call");
		return this.#invoke(callable, args, callsite);
	}

	async #evaluateCallArguments(
		args: CallExpression["arguments"] | OptionalCallExpression["arguments"],
		environment: Environment,
	): Promise<unknown[]> {
		const values: unknown[] = [];
		for (const argument of args) {
			if (argument.type === "ArgumentPlaceholder") {
				throw new WorkflowRuntimeError("unsupported_syntax", "Unsupported Workflow call argument");
			}
			if (argument.type === "SpreadElement") {
				const spread = await this.#evaluate(argument.argument, environment);
				if (!Array.isArray(spread)) throw new WorkflowRuntimeError("script_error", "Call spread expects an array");
				values.push(...spread);
			} else {
				values.push(await this.#evaluate(argument, environment));
			}
			this.#ensureCollectionSize(values.length, "Workflow call arguments");
		}
		return values;
	}

	async #invoke(callable: NativeCallable | InterpretedCallable, args: unknown[], callsite: number): Promise<unknown> {
		if (callable instanceof NativeCallable) return callable.invoke(args, callsite);
		const environment = new Environment(callable.environment);
		for (let index = 0; index < callable.params.length; index++) {
			const parameter = callable.params[index];
			if (!parameter) continue;
			if (parameter.type === "RestElement") {
				await this.#bindPattern(parameter, args.slice(index), environment, true);
				break;
			}
			await this.#bindPattern(parameter, args[index], environment, true);
		}
		try {
			if (callable.body.type === "BlockStatement") {
				await this.#executeBlock(callable.body, environment);
				return undefined;
			}
			return await this.#evaluate(callable.body, environment);
		} catch (error) {
			if (error instanceof ReturnFlow) return error.value;
			throw error;
		}
	}

	async #memberTarget(
		expression: MemberExpression | OptionalMemberExpression,
		environment: Environment,
	): Promise<{ object: unknown; key: string } | undefined> {
		const object = await this.#evaluate(expression.object as Expression, environment);
		if (object === null || object === undefined) {
			if (expression.optional) return undefined;
			throw new WorkflowRuntimeError("script_error", "Cannot read a member of null or undefined");
		}
		let key: string;
		if (expression.computed) {
			if (expression.property.type === "PrivateName") {
				throw new WorkflowRuntimeError("unsupported_syntax", "Private members are not supported");
			}
			key = String(await this.#evaluate(expression.property as Expression, environment));
		} else if (expression.property.type === "Identifier") {
			key = expression.property.name;
		} else {
			throw new WorkflowRuntimeError("unsupported_syntax", "Unsupported Workflow member key");
		}
		this.#assertSafeMemberKey(key);
		return { object, key };
	}

	#assertSafeMemberKey(key: string): void {
		if (FORBIDDEN_MEMBER_KEYS.has(key)) {
			throw new WorkflowRuntimeError("permission_denied", `Workflow member ${key} is forbidden`);
		}
	}

	#getMember(object: unknown, key: string): unknown {
		this.#assertSafeMemberKey(key);
		if (Array.isArray(object)) {
			if (key === "length") return object.length;
			if (ARRAY_INDEX.test(key)) return object[Number(key)];
			return Object.hasOwn(object, key) ? object[Number(key)] : undefined;
		}
		if (typeof object === "string") {
			if (key === "length") return object.length;
			if (ARRAY_INDEX.test(key)) return object[Number(key)];
			return undefined;
		}
		if (object instanceof NativeCallable) {
			if (object.name === "Number" && key === "MAX_SAFE_INTEGER") return Number.MAX_SAFE_INTEGER;
			if (object.name === "Number" && key === "MIN_SAFE_INTEGER") return Number.MIN_SAFE_INTEGER;
			return undefined;
		}
		if (isPlainObject(object)) return Object.hasOwn(object, key) ? object[key] : undefined;
		if (typeof object === "number" || typeof object === "boolean") return undefined;
		throw new WorkflowRuntimeError("permission_denied", "Workflow cannot inspect host object members");
	}

	async #invokeMember(object: unknown, key: string, args: unknown[], callsite: number): Promise<unknown> {
		this.#assertSafeMemberKey(key);
		if (Array.isArray(object)) return this.#invokeArrayMethod(object, key, args, callsite);
		if (typeof object === "string") return this.#invokeStringMethod(object, key, args);
		if (object instanceof NativeCallable) return this.#invokeStaticMethod(object, key, args, callsite);
		if (isPlainObject(object)) {
			const callable = requireCallable(Object.hasOwn(object, key) ? object[key] : undefined, `Object member ${key}`);
			return this.#invoke(callable, args, callsite);
		}
		if ((typeof object === "number" || typeof object === "boolean") && key === "toString") return String(object);
		throw new WorkflowRuntimeError("permission_denied", `Workflow member call ${key} is unavailable`);
	}

	async #invokeArrayMethod(array: unknown[], key: string, args: unknown[], callsite: number): Promise<unknown> {
		switch (key) {
			case "at":
				return array.at(Math.trunc(toFiniteNumber(args[0], "Array.at")));
			case "concat": {
				const result = [...array];
				for (const value of args) Array.isArray(value) ? result.push(...value) : result.push(value);
				this.#ensureCollectionSize(result.length, "Array.concat result");
				return result;
			}
			case "entries":
				return array.map((value, index) => [index, value]);
			case "every": {
				const callback = requireCallable(args[0], "Array.every");
				for (let index = 0; index < array.length; index++) {
					if (!(await this.#invoke(callback, [array[index], index, array], callsite))) return false;
				}
				return true;
			}
			case "filter": {
				const callback = requireCallable(args[0], "Array.filter");
				const result: unknown[] = [];
				for (let index = 0; index < array.length; index++) {
					if (await this.#invoke(callback, [array[index], index, array], callsite)) result.push(array[index]);
				}
				return result;
			}
			case "find": {
				const callback = requireCallable(args[0], "Array.find");
				for (let index = 0; index < array.length; index++) {
					if (await this.#invoke(callback, [array[index], index, array], callsite)) return array[index];
				}
				return undefined;
			}
			case "findIndex": {
				const callback = requireCallable(args[0], "Array.findIndex");
				for (let index = 0; index < array.length; index++) {
					if (await this.#invoke(callback, [array[index], index, array], callsite)) return index;
				}
				return -1;
			}
			case "flat": {
				const result = array.flat(Math.max(0, Math.trunc(Number(args[0] ?? 1))));
				this.#ensureCollectionSize(result.length, "Array.flat result");
				return result;
			}
			case "flatMap": {
				const callback = requireCallable(args[0], "Array.flatMap");
				const mapped: unknown[] = [];
				for (let index = 0; index < array.length; index++) {
					const value = await this.#invoke(callback, [array[index], index, array], callsite);
					Array.isArray(value) ? mapped.push(...value) : mapped.push(value);
					this.#ensureCollectionSize(mapped.length, "Array.flatMap result");
				}
				return mapped;
			}
			case "forEach": {
				const callback = requireCallable(args[0], "Array.forEach");
				for (let index = 0; index < array.length; index++) {
					await this.#invoke(callback, [array[index], index, array], callsite);
				}
				return undefined;
			}
			case "includes":
				return array.includes(args[0], Math.trunc(Number(args[1] ?? 0)));
			case "indexOf":
				return array.indexOf(args[0], Math.trunc(Number(args[1] ?? 0)));
			case "join":
				return array
					.map(value => (value === null || value === undefined ? "" : String(value)))
					.join(String(args[0] ?? ","));
			case "keys":
				return array.map((_value, index) => index);
			case "map": {
				const callback = requireCallable(args[0], "Array.map");
				const result: unknown[] = [];
				for (let index = 0; index < array.length; index++) {
					result.push(await this.#invoke(callback, [array[index], index, array], callsite));
				}
				return result;
			}
			case "pop":
				return array.pop();
			case "push":
				this.#ensureCollectionSize(array.length + args.length, "Array.push result");
				return array.push(...args);
			case "reduce": {
				const callback = requireCallable(args[0], "Array.reduce");
				if (array.length === 0 && args.length < 2) {
					throw new WorkflowRuntimeError("script_error", "Array.reduce of empty array needs an initial value");
				}
				let index = args.length >= 2 ? 0 : 1;
				let accumulator = args.length >= 2 ? args[1] : array[0];
				for (; index < array.length; index++) {
					accumulator = await this.#invoke(callback, [accumulator, array[index], index, array], callsite);
				}
				return accumulator;
			}
			case "shift":
				return array.shift();
			case "slice":
				return array.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
			case "some": {
				const callback = requireCallable(args[0], "Array.some");
				for (let index = 0; index < array.length; index++) {
					if (await this.#invoke(callback, [array[index], index, array], callsite)) return true;
				}
				return false;
			}
			case "unshift":
				this.#ensureCollectionSize(array.length + args.length, "Array.unshift result");
				return array.unshift(...args);
			case "values":
				return [...array];
			default:
				throw new WorkflowRuntimeError("permission_denied", `Array method ${key} is not allowed`);
		}
	}

	#invokeStringMethod(value: string, key: string, args: unknown[]): unknown {
		switch (key) {
			case "at":
				return value.at(Math.trunc(Number(args[0] ?? 0)));
			case "charAt":
				return value.charAt(Math.trunc(Number(args[0] ?? 0)));
			case "endsWith":
				return value.endsWith(String(args[0] ?? ""), args[1] === undefined ? undefined : Number(args[1]));
			case "includes":
				return value.includes(String(args[0] ?? ""), Number(args[1] ?? 0));
			case "indexOf":
				return value.indexOf(String(args[0] ?? ""), Number(args[1] ?? 0));
			case "replace":
				return value.replace(String(args[0] ?? ""), String(args[1] ?? ""));
			case "slice":
				return value.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
			case "split": {
				const result =
					args[0] === undefined
						? [value]
						: value.split(String(args[0]), args[1] === undefined ? undefined : Number(args[1]));
				this.#ensureCollectionSize(result.length, "String.split result");
				return result;
			}
			case "startsWith":
				return value.startsWith(String(args[0] ?? ""), Number(args[1] ?? 0));
			case "substring":
				return value.substring(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
			case "toLowerCase":
				return value.toLowerCase();
			case "toUpperCase":
				return value.toUpperCase();
			case "trim":
				return value.trim();
			case "trimEnd":
				return value.trimEnd();
			case "trimStart":
				return value.trimStart();
			default:
				throw new WorkflowRuntimeError("permission_denied", `String method ${key} is not allowed`);
		}
	}

	async #invokeStaticMethod(object: NativeCallable, key: string, args: unknown[], callsite: number): Promise<unknown> {
		if (object.name === "Array" && key === "isArray") return Array.isArray(args[0]);
		if (object.name === "Array" && key === "from") {
			if (!Array.isArray(args[0]) && typeof args[0] !== "string") {
				throw new WorkflowRuntimeError("script_error", "Array.from expects an array or string");
			}
			const source = Array.isArray(args[0]) ? [...args[0]] : [...args[0]];
			if (args[1] === undefined) return source;
			const callback = requireCallable(args[1], "Array.from");
			return this.#runPool(source, (value, index) => this.#invoke(callback, [value, index], callsite));
		}
		if (object.name === "Number" && key === "isFinite")
			return typeof args[0] === "number" && Number.isFinite(args[0]);
		if (object.name === "Number" && key === "isInteger")
			return typeof args[0] === "number" && Number.isInteger(args[0]);
		if (object.name === "Object" && key === "keys") return isPlainObject(args[0]) ? Object.keys(args[0]) : [];
		if (object.name === "Object" && key === "values") return isPlainObject(args[0]) ? Object.values(args[0]) : [];
		if (object.name === "Object" && key === "entries") return isPlainObject(args[0]) ? Object.entries(args[0]) : [];
		if (object.name === "Object" && key === "hasOwn") {
			const member = String(args[1]);
			this.#assertSafeMemberKey(member);
			return (isPlainObject(args[0]) || Array.isArray(args[0])) && Object.hasOwn(args[0], member);
		}
		if (object.name === "Object" && key === "fromEntries") {
			const entries = requireArray(args[0], "Object.fromEntries");
			const result: Record<string, unknown> = {};
			for (const entry of entries) {
				const pair = requireArray(entry, "Object.fromEntries entry");
				const member = String(pair[0]);
				this.#assertSafeMemberKey(member);
				result[member] = pair[1];
			}
			return result;
		}
		throw new WorkflowRuntimeError("permission_denied", `${object.name}.${key} is not allowed`);
	}

	async #evaluateAssignment(expression: AssignmentExpression, environment: Environment): Promise<unknown> {
		const right = await this.#evaluate(expression.right, environment);
		if (expression.operator === "=") {
			await this.#assignTarget(expression.left, right, environment);
			return right;
		}
		const left = await this.#readTarget(expression.left, environment);
		let value: unknown;
		switch (expression.operator) {
			case "+=":
				value =
					typeof left === "string" || typeof right === "string"
						? String(left) + String(right)
						: toFiniteNumber(left, "Addition assignment") + toFiniteNumber(right, "Addition assignment");
				break;
			case "-=":
				value = toFiniteNumber(left, "Subtraction assignment") - toFiniteNumber(right, "Subtraction assignment");
				break;
			case "*=":
				value =
					toFiniteNumber(left, "Multiplication assignment") * toFiniteNumber(right, "Multiplication assignment");
				break;
			case "/=":
				value = toFiniteNumber(left, "Division assignment") / toFiniteNumber(right, "Division assignment");
				break;
			case "%=":
				value = toFiniteNumber(left, "Remainder assignment") % toFiniteNumber(right, "Remainder assignment");
				break;
			case "&&=":
				value = left ? right : left;
				break;
			case "||=":
				value = left ? left : right;
				break;
			case "??=":
				value = left === null || left === undefined ? right : left;
				break;
			default:
				throw new WorkflowRuntimeError(
					"unsupported_syntax",
					`Assignment operator ${expression.operator} is not supported`,
				);
		}
		await this.#assignTarget(expression.left, value, environment);
		return value;
	}

	async #evaluateUpdate(expression: UpdateExpression, environment: Environment): Promise<number> {
		const previous = toFiniteNumber(await this.#readTarget(expression.argument, environment), "Update expression");
		const next = expression.operator === "++" ? previous + 1 : previous - 1;
		await this.#assignTarget(expression.argument, next, environment);
		return expression.prefix ? next : previous;
	}

	async #readTarget(target: LVal | OptionalMemberExpression | Expression, environment: Environment): Promise<unknown> {
		if (target.type === "Identifier") return environment.get(target.name);
		if (target.type === "MemberExpression" || target.type === "OptionalMemberExpression") {
			const member = await this.#memberTarget(target, environment);
			if (!member) return undefined;
			return this.#getMember(member.object, member.key);
		}
		throw new WorkflowRuntimeError("unsupported_syntax", `Cannot read assignment target ${target.type}`);
	}

	async #assignTarget(
		target: LVal | OptionalMemberExpression | Expression,
		value: unknown,
		environment: Environment,
	): Promise<void> {
		if (target.type === "Identifier") {
			environment.assign(target.name, value);
			return;
		}
		if (target.type === "MemberExpression" || target.type === "OptionalMemberExpression") {
			const member = await this.#memberTarget(target, environment);
			if (!member) throw new WorkflowRuntimeError("script_error", "Cannot assign through an optional null member");
			this.#setMember(member.object, member.key, value);
			return;
		}
		if (target.type === "ArrayPattern" || target.type === "ObjectPattern") {
			await this.#bindPattern(target, value, environment, false);
			return;
		}
		throw new WorkflowRuntimeError("unsupported_syntax", `Cannot assign target ${target.type}`);
	}

	#setMember(object: unknown, key: string, value: unknown): void {
		this.#assertSafeMemberKey(key);
		if (Array.isArray(object)) {
			if (!ARRAY_INDEX.test(key))
				throw new WorkflowRuntimeError("permission_denied", "Only array indexes can be assigned");
			const index = Number(key);
			this.#ensureCollectionSize(index + 1, "Workflow array assignment");
			object[index] = value;
			return;
		}
		if (isPlainObject(object)) {
			if (!Object.hasOwn(object, key))
				this.#ensureCollectionSize(Object.keys(object).length + 1, "Workflow object assignment");
			object[key] = value;
			return;
		}
		throw new WorkflowRuntimeError("permission_denied", "Workflow cannot mutate host objects");
	}
}
