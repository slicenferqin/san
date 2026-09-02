import type {
	TaskContractAdmission,
	TaskContractIdentity,
	TaskContractInput,
	TaskContractRegistry,
	TaskContractSnapshot,
} from "../execution-control/task-contract";

export interface TaskDispatchRequest {
	readonly ownerId: string;
	readonly rootSessionId?: string;
	readonly assignment: string;
	readonly agent: string;
	readonly contract?: TaskContractInput;
	readonly scopeId?: string;
}

/**
 * The normalized identity and admission decision for one dispatch request.
 * This plan deliberately stops before execution; TaskTool remains the only
 * execution adapter until its runner can be extracted without changing its
 * sync/background, isolation, or settlement behavior.
 */
export interface TaskDispatchPlan {
	readonly request: TaskDispatchRequest;
	readonly contract?: TaskContractIdentity;
	readonly admission?: TaskContractAdmission;
	readonly snapshot?: Readonly<TaskContractSnapshot>;
}

export interface TaskDispatchRegistrySource {
	readonly taskContractRegistry?: TaskContractRegistry;
	readonly executionScopeId?: string;
}

/**
 * Shared admission boundary for programmatic orchestrators.
 *
 * It owns identity derivation and duplicate admission only. It does not
 * execute agents, create jobs, render tool output, or settle results.
 */
export interface TaskDispatchService {
	preflight(request: TaskDispatchRequest): TaskDispatchPlan;
}

export class TaskAdmissionService implements TaskDispatchService {
	readonly #source: TaskDispatchRegistrySource;

	constructor(source: TaskDispatchRegistrySource) {
		this.#source = source;
	}

	preflight(request: TaskDispatchRequest): TaskDispatchPlan {
		const registry = this.#source.taskContractRegistry;
		if (!registry) return { request };

		const derivation = {
			...request.contract,
			scopeId: request.scopeId ?? this.#source.executionScopeId,
			rootSessionId: request.rootSessionId,
			task: request.assignment,
			agent: request.agent,
		};
		const contract = registry.derive(derivation);
		const admission = registry.admit(derivation);
		const snapshot = registry.get(contract) ?? admission.contract;
		return { request, contract, admission, snapshot };
	}
}
