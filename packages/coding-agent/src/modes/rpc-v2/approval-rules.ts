/**
 * San RPC v2 Approval Rule Store.
 *
 * Persists approval rules with stable fingerprints. Rules are scoped
 * to session/workspace/global and can be listed, created, and revoked.
 */
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { PermissionPolicySnapshot, PermissionRule } from "./dto/approval";
import type { ApprovalId } from "./protocol/ids";

/** Generate a canonical fingerprint for an approval request. */
export function generateFingerprint(params: {
	requestAction: string;
	toolName?: string;
	operationKind?: string;
	targetCanonical?: string;
	riskTier: string;
	workspaceRoot?: string;
}): string {
	const parts = [
		params.requestAction,
		params.toolName ?? "*",
		params.operationKind ?? "*",
		params.targetCanonical ?? "*",
		params.riskTier,
		params.workspaceRoot ?? "*",
	];
	return parts.join(":");
}

export class ApprovalRuleStore {
	#rules: PermissionRule[] = [];
	#revision = 0;

	get revision(): number {
		return this.#revision;
	}

	/** Add a rule from an approval decision. */
	addRule(params: {
		decision: "allow" | "deny";
		fingerprint: string;
		toolName?: string;
		operationKind?: string;
		targetPattern?: string;
		riskCeiling?: "low" | "medium" | "high";
		sourceApprovalId?: ApprovalId;
	}): PermissionRule {
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
		};
		this.#rules.push(rule);
		this.#revision++;
		return rule;
	}

	/** Revoke a mutable rule. */
	revoke(ruleId: string): boolean {
		const index = this.#rules.findIndex(r => r.ruleId === ruleId && r.mutable);
		if (index === -1) return false;
		this.#rules.splice(index, 1);
		this.#revision++;
		return true;
	}

	/** Check if a fingerprint matches an existing rule. */
	match(fingerprint: string): PermissionRule | undefined {
		// Last matching rule wins (most recent decision)
		for (let i = this.#rules.length - 1; i >= 0; i--) {
			if (this.#rules[i].fingerprint === fingerprint) return this.#rules[i];
		}
		return undefined;
	}

	/** Get the full policy snapshot. */
	getPolicy(scope: "session" | "workspace" | "global"): PermissionPolicySnapshot {
		return {
			schemaVersion: 1,
			scope,
			revision: this.#revision,
			defaults: { read: "allow", write: "ask", exec: "ask" },
			rules: [...this.#rules],
		};
	}

	/** List rules, optionally filtered. */
	list(options?: { toolName?: string }): PermissionRule[] {
		if (!options?.toolName) return [...this.#rules];
		return this.#rules.filter(r => r.toolName === options.toolName);
	}
}
