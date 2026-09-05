import { AsyncJobManager } from "../async";
import { AgentRegistry } from "../registry/agent-registry";
import { rebuildSanLoopLedger } from "../san-loop/ledger";
import type { AgentSession } from "../session/agent-session";
import type { CoordinationActivitySources, CoordinationTaskSource } from "./activity-projector";
import { getWorkflowManager } from "./workflow-registry";

/** Build the read-only authority snapshots consumed by the coordination projector. */
export function getCoordinationActivitySources(session: AgentSession): CoordinationActivitySources {
	const contractRegistry = session.getTaskContractRegistry();
	const activeScopeId = session.getActiveExecutionScopeId();
	const contracts = contractRegistry?.list(activeScopeId) ?? [];
	const jobs = AsyncJobManager.instance();
	const agents = AgentRegistry.global();
	const tasks: CoordinationTaskSource[] = contracts.map(contract => {
		const job = contract.jobId ? jobs?.getJob(contract.jobId) : undefined;
		const agent = job?.agentId ? agents.get(job.agentId) : undefined;
		return {
			contract,
			...(job
				? {
						job: {
							id: job.id,
							status: job.status,
							label: job.label,
							...(job.agentId ? { agentId: job.agentId } : {}),
						},
					}
				: {}),
			...(agent
				? {
						agent: {
							id: agent.id,
							status: agent.status,
							...(agent.activity ? { activity: agent.activity } : {}),
						},
					}
				: {}),
		};
	});

	const workflowManager = getWorkflowManager(session.sessionManager);
	const workflows = workflowManager?.listRuns().map(run => ({ run })) ?? [];
	const sanLoops = rebuildSanLoopLedger(session.sessionManager.getBranch()).runs.map(({ data: run }) => ({ run }));
	return {
		tasks,
		workflows,
		sanLoops,
	};
}
