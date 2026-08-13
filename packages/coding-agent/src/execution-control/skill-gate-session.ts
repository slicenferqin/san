/**
 * 会话级 skill gate 状态容器(M3 软层)。
 *
 * 证据链 skill 在交互会话中触发时,宿主把编译出的 gate 挂到这里,并在 bash
 * 工具完成时生成 host 回执、在文件修改类工具动工时给出一次性的 before-fix
 * 提醒。这一层**不阻断**任何执行(会话内用户在场,裁量权在人),也不复用
 * `verifyEvidenceGates` 的 assignment 绑定语义 — 那是 San Loop 终态硬判定的
 * 职责;这里只维护"哪些门已有满足语义的 host 观察"这一有界事实。
 *
 * 契约身份:交互会话没有 execution-control scope 时,从 skill 名 + 会话 id
 * 派生一份最小不可变契约(稳定指纹作 contractHash)。刻意不把
 * ExecutionScopeRegistry 接入会话生命周期 — 根会话闭环是另一项工程。
 */
import { createCommandEvidenceReceipt } from "./evidence-gates";
import { stableValueFingerprint } from "./progress-classifier";
import { compileSkillGates } from "./skill-gate-compiler";
import type { AcceptanceGate, CommandEvidenceReceipt, ObjectiveContractRef, SkillEvidenceSpec } from "./types";

/** 会话内跟踪的单个 gate:编译产物 + 声明 + host 观察状态。 */
export interface TrackedSkillGate {
	readonly gate: AcceptanceGate;
	readonly spec: SkillEvidenceSpec;
	/** 已存在满足此门语义的 host 回执。 */
	satisfied: boolean;
	/** before-fix 软提醒已发出(同一 gate 只提醒一次)。 */
	reminded: boolean;
	/** 解析出的命令规范化指纹;sameAs 引用者要求与被引用门的该值一致。 */
	resolvedCommandFingerprint?: string;
	readonly receipts: CommandEvidenceReceipt[];
}

export interface SkillGateChain {
	readonly skillName: string;
	readonly contractRef: ObjectiveContractRef;
	readonly gates: readonly TrackedSkillGate[];
	/** 契约回显文本与其稳定指纹;终态汇报可反引。 */
	contractEcho?: { text: string; hash: string };
}

export interface CommandObservation {
	readonly command: string;
	readonly exitCode: number;
	readonly timestamp?: string;
}

export interface SkillGateReminder {
	readonly skillName: string;
	readonly spec: SkillEvidenceSpec;
}

/** 命令文本的规范化指纹;回执 checkId 与 sameAs 校验共用。 */
export function commandEvidenceFingerprint(command: string): string {
	return stableValueFingerprint(command.trim());
}

/** 从 skill 名 + 会话 id 派生最小不可变契约引用(无 scope 的交互会话用)。 */
export function deriveSkillSessionContractRef(skillName: string, sessionId: string): ObjectiveContractRef {
	return {
		contractId: `contract:skill:${skillName}`,
		revision: 1,
		contractHash: stableValueFingerprint({ scope: "skill-gate-session", skillName, sessionId }),
		clauseRefs: [`clause:skill:${skillName}`],
	};
}

export class SessionSkillGateState {
	readonly #sessionId: string;
	readonly #chains = new Map<string, SkillGateChain>();
	#receiptSequence = 0;

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	/**
	 * 编译并挂载一条证据链。同名 skill 已激活时保持既有状态(回执/提醒不重置),
	 * 返回 undefined;首次激活返回新链。无 evidence 的 skill 不建链。
	 */
	activate(skill: { name: string; evidence?: readonly SkillEvidenceSpec[] }): SkillGateChain | undefined {
		const evidence = skill.evidence;
		if (!evidence?.length) return undefined;
		if (this.#chains.has(skill.name)) return undefined;
		const contractRef = deriveSkillSessionContractRef(skill.name, this.#sessionId);
		const gates = compileSkillGates({
			skill: { name: skill.name, evidence },
			contractRef,
			contractRevision: contractRef.revision,
			contractHash: contractRef.contractHash,
		});
		const chain: SkillGateChain = {
			skillName: skill.name,
			contractRef,
			// compileSkillGates 按声明顺序逐 spec 产出,索引对齐。
			gates: gates.map((gate, index) => ({
				gate,
				spec: evidence[index],
				satisfied: false,
				reminded: false,
				receipts: [],
			})),
		};
		this.#chains.set(skill.name, chain);
		return chain;
	}

	get hasActiveChains(): boolean {
		return this.#chains.size > 0;
	}

	chains(): readonly SkillGateChain[] {
		return [...this.#chains.values()];
	}

	chain(skillName: string): SkillGateChain | undefined {
		return this.#chains.get(skillName);
	}

	/** 供 San Loop 接线:当前活跃链的 skill 声明(name + evidence)。 */
	activeSkillDeclarations(): Array<{ name: string; evidence: readonly SkillEvidenceSpec[] }> {
		return [...this.#chains.values()].map(chain => ({
			name: chain.skillName,
			evidence: chain.gates.map(tracked => tracked.spec),
		}));
	}

	/**
	 * bash 命令完成后的 host 观察。对每个尚未满足的 command 类 gate 判定:
	 * - exitCode 符合声明的 expect(fail → 非零;pass → 零);
	 * - 有 sameAs 时,命令指纹必须与被引用门已解析的指纹一致(防"换个命令绿了");
	 *   被引用门尚未解析时本次观察不满足该门。
	 * 满足则生成 host 回执(checkId = 命令指纹,exitCode 保留真实值)并把门置为
	 * satisfied。一条命令可同时满足多个门。返回新生成的回执。
	 */
	recordCommandObservation(observation: CommandObservation): CommandEvidenceReceipt[] {
		if (this.#chains.size === 0) return [];
		const fingerprint = commandEvidenceFingerprint(observation.command);
		const produced: CommandEvidenceReceipt[] = [];
		for (const chain of this.#chains.values()) {
			const byId = new Map(chain.gates.map(tracked => [tracked.spec.id, tracked]));
			for (const tracked of chain.gates) {
				if (tracked.satisfied || tracked.spec.kind !== "command") continue;
				const expectMatched =
					tracked.spec.expect === "fail" ? observation.exitCode !== 0 : observation.exitCode === 0;
				if (!expectMatched) continue;
				if (tracked.spec.sameAs !== undefined) {
					const referenced = byId.get(tracked.spec.sameAs);
					if (referenced?.resolvedCommandFingerprint !== fingerprint) continue;
				}
				this.#receiptSequence += 1;
				const receipt = createCommandEvidenceReceipt({
					receiptId: `receipt:skill:${chain.skillName}:${tracked.spec.id}:${this.#receiptSequence}`,
					scopeId: `session:${this.#sessionId}`,
					gateId: tracked.gate.gateId,
					contractRevision: chain.contractRef.revision,
					contractHash: chain.contractRef.contractHash,
					freshnessRevision: chain.contractRef.revision,
					outcome: "pass",
					timestamp: observation.timestamp ?? new Date().toISOString(),
					checkId: fingerprint,
					exitCode: observation.exitCode,
				});
				tracked.receipts.push(receipt);
				tracked.satisfied = true;
				tracked.resolvedCommandFingerprint = fingerprint;
				produced.push(receipt);
			}
		}
		return produced;
	}

	/**
	 * 文件修改类工具动工时调用:返回尚无满足回执、且未提醒过的 before-fix 门,
	 * 并原子地标记为已提醒 — 同一 gate 永远只提醒一次,即便证据始终缺失。
	 */
	takeBeforeFixReminders(): SkillGateReminder[] {
		const reminders: SkillGateReminder[] = [];
		for (const chain of this.#chains.values()) {
			for (const tracked of chain.gates) {
				if (tracked.spec.phase !== "before-fix" || tracked.satisfied || tracked.reminded) continue;
				tracked.reminded = true;
				reminders.push({ skillName: chain.skillName, spec: tracked.spec });
			}
		}
		return reminders;
	}

	/** 记录契约回显文本;返回其稳定指纹(终态汇报反引用)。 */
	recordContractEcho(skillName: string, text: string): string | undefined {
		const chain = this.#chains.get(skillName);
		if (!chain) return undefined;
		const hash = stableValueFingerprint(text);
		chain.contractEcho = { text, hash };
		return hash;
	}
}
