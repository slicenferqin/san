import type {
	ExecutionScopeReference,
	ExecutionScopeRegistryOptions,
	ResolveExecutionScopeRequest,
	ScopeContinuationKind,
	StartExecutionScopeRequest,
} from "./types";

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function freezeDeep<T>(value: T): T {
	if (!isObject(value) || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeDeep(child);
	return Object.freeze(value);
}

function cloneFrozen<T>(value: T): T {
	return freezeDeep(structuredClone(value));
}
function objectiveContractsEqual(
	left: ExecutionScopeReference["objectiveContract"],
	right: ExecutionScopeReference["objectiveContract"],
): boolean {
	return (
		left.source === right.source &&
		left.authoritativeUserTurnId === right.authoritativeUserTurnId &&
		left.ref.contractId === right.ref.contractId &&
		left.ref.revision === right.ref.revision &&
		left.ref.contractHash === right.ref.contractHash &&
		left.ref.clauseRefs.length === right.ref.clauseRefs.length &&
		left.ref.clauseRefs.every((clause, index) => clause === right.ref.clauseRefs[index])
	);
}

function keyFor(rootSessionId: string, logicalTurnId: string): string {
	return `${rootSessionId}\u0000${logicalTurnId}`;
}

const RETAINING_KINDS: readonly ScopeContinuationKind[] = [
	"steering",
	"compaction",
	"handoff",
	"request_recovery",
	"model_summary",
];

/**
 * Lifetime registry for root execution scopes.
 *
 * A scope is keyed by root session and logical turn. Steering, compaction,
 * handoff, recovery and model summaries resolve an existing scope only. An
 * authoritative user turn is the sole operation that can allocate a scope or
 * bind an objective contract.
 */
export class ExecutionScopeRegistry {
	readonly #now: () => string;
	readonly #scopesById = new Map<string, Readonly<ExecutionScopeReference>>();
	readonly #scopeIdByKey = new Map<string, string>();
	readonly #currentByRoot = new Map<string, string>();

	constructor(options: ExecutionScopeRegistryOptions = {}) {
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	startAuthoritativeTurn(request: StartExecutionScopeRequest): Readonly<ExecutionScopeReference> {
		if (!request.rootSessionId || !request.logicalTurnId)
			throw new Error("Execution scopes require rootSessionId and logicalTurnId.");
		if (request.objectiveContract.source !== "authoritative_user") {
			throw new Error("Only an authoritative user turn can start an execution scope.");
		}
		const key = keyFor(request.rootSessionId, request.logicalTurnId);
		const priorScopeId = this.#scopeIdByKey.get(key);
		if (priorScopeId) {
			const prior = this.#scopesById.get(priorScopeId);
			if (!prior) throw new Error(`Execution scope ${priorScopeId} is missing from the registry.`);
			if (!objectiveContractsEqual(prior.objectiveContract, request.objectiveContract)) {
				throw new Error(`Execution scope ${priorScopeId} already has a different immutable objective contract.`);
			}
			// 重入旧轮次：即使最新轮次已经 cutover，current 指针也必须重新指回该轮次的作用域。
			this.#currentByRoot.set(request.rootSessionId, priorScopeId);
			return prior;
		}
		const scopeId = `scope:${request.rootSessionId}:${request.logicalTurnId}`;
		const reference = cloneFrozen({
			scopeId,
			rootSessionId: request.rootSessionId,
			logicalTurnId: request.logicalTurnId,
			objectiveContract: request.objectiveContract,
			createdAt: this.#now(),
		});
		this.#scopesById.set(scopeId, reference);
		this.#scopeIdByKey.set(key, scopeId);
		this.#currentByRoot.set(request.rootSessionId, scopeId);
		return reference;
	}

	resolve(request: ResolveExecutionScopeRequest): Readonly<ExecutionScopeReference> | undefined {
		if (request.kind === "authoritative_user") {
			if (!request.logicalTurnId || !request.objectiveContract) {
				throw new Error("An authoritative user turn requires logicalTurnId and objectiveContract.");
			}
			return this.startAuthoritativeTurn({
				rootSessionId: request.rootSessionId,
				logicalTurnId: request.logicalTurnId,
				objectiveContract: request.objectiveContract,
			});
		}
		if (!RETAINING_KINDS.includes(request.kind)) return undefined;
		const scopeId =
			request.continuationOfScopeId ??
			(request.logicalTurnId
				? this.#scopeIdByKey.get(keyFor(request.rootSessionId, request.logicalTurnId))
				: this.#currentByRoot.get(request.rootSessionId));
		if (!scopeId) return undefined;
		const reference = this.#scopesById.get(scopeId);
		if (!reference || reference.rootSessionId !== request.rootSessionId) return undefined;
		// A continuation may carry stale/model-produced objective data. It is
		// intentionally ignored rather than mutating the host-owned reference.
		return reference;
	}

	retain(
		scopeId: string,
		kind: Exclude<ScopeContinuationKind, "authoritative_user">,
	): Readonly<ExecutionScopeReference> | undefined {
		if (!RETAINING_KINDS.includes(kind)) throw new Error(`Scope continuation kind ${kind} cannot retain a scope.`);
		return this.#scopesById.get(scopeId);
	}

	get(scopeId: string): Readonly<ExecutionScopeReference> | undefined {
		return this.#scopesById.get(scopeId);
	}

	getForTurn(rootSessionId: string, logicalTurnId: string): Readonly<ExecutionScopeReference> | undefined {
		const scopeId = this.#scopeIdByKey.get(keyFor(rootSessionId, logicalTurnId));
		return scopeId ? this.#scopesById.get(scopeId) : undefined;
	}

	current(rootSessionId: string): Readonly<ExecutionScopeReference> | undefined {
		const scopeId = this.#currentByRoot.get(rootSessionId);
		return scopeId ? this.#scopesById.get(scopeId) : undefined;
	}

	list(rootSessionId?: string): readonly Readonly<ExecutionScopeReference>[] {
		const values = [...this.#scopesById.values()];
		return values.filter(reference => rootSessionId === undefined || reference.rootSessionId === rootSessionId);
	}

	/**
	 * 替换整个分支状态：移除全部现有作用域与 current 指针，再恢复提供的引用。
	 * 每个 root session 以最后一个提供的引用作为 current 作用域，因此调用方应
	 * 按时间顺序提供引用。registry 对象身份保持不变；本类没有订阅者需要通知。
	 */
	reset(references: readonly ExecutionScopeReference[] = []): void {
		this.#scopesById.clear();
		this.#scopeIdByKey.clear();
		this.#currentByRoot.clear();
		for (const reference of references) {
			const installed = cloneFrozen(reference);
			this.#scopesById.set(installed.scopeId, installed);
			this.#scopeIdByKey.set(keyFor(installed.rootSessionId, installed.logicalTurnId), installed.scopeId);
			this.#currentByRoot.set(installed.rootSessionId, installed.scopeId);
		}
	}
}

export function createExecutionScopeRegistry(options?: ExecutionScopeRegistryOptions): ExecutionScopeRegistry {
	return new ExecutionScopeRegistry(options);
}
