/**
 * SkillEvidenceSpec → AcceptanceGate 编译器(M3)。
 *
 * 纯函数、无 IO:输入 skill 的证据链声明与一份不可变契约身份,输出可直接并入
 * `RunSanLoopOptions.acceptanceGates`(或会话级 gate 容器)的 gate 模板。
 * 判定层不在此处 — 回执校验永远走 `verifyEvidenceGates`。
 *
 * 身份映射约定:
 * - `gateId` 为 `gate:skill:<skill>:<specId>`,同一 skill 重复编译产出相同 id,
 *   调用方可按 id 去重。
 * - `sameAs` 编译为"共享 verifier 主标识":sameAs 链上的所有 spec 解析到链根,
 *   command 的 `checkId`、browser 的 `scenarioId`、api 的 `requestId`、artifact 的
 *   `artifactKind`、external 的 `dependencyId` 均取链根派生值。host 回执必须与
 *   verifier 主标识精确匹配(见 evidence-gates.ts 的 `verifierIdentityMatches`),
 *   因此"复验必须与被引用 spec 同一条命令/路径"就落在了这份约束数据上。
 * - `expect` 对 command 编译为 `expectedExitCode`(pass→0;fail→1,host 适配层
 *   为 fail 期望的门规范非零退出为该值);对其余 kind 编进 assertion/schema/rubric
 *   标识,host 回执按同一标识回填。
 * - `phase` 决定 `required`:`before-done` 是硬门(终态判定拦截),`before-fix`
 *   是软门(`required: false`,`verifyEvidenceGates` 跳过,仅供会话内提醒)。
 */
import type { AcceptanceGate, AcceptanceVerifier, ObjectiveContractRef, SkillEvidenceSpec } from "./types";

export interface CompileSkillGatesInput {
	skill: { name: string; evidence: readonly SkillEvidenceSpec[] };
	contractRef: ObjectiveContractRef;
	contractRevision: number;
	contractHash: string;
}

/** 稳定 gate id;同一 skill+spec 永远得到同一 id,供并入方去重。 */
export function skillGateId(skillName: string, specId: string): string {
	return `gate:skill:${skillName}:${specId}`;
}

/** verifier 主标识(checkId/scenarioId/...)的稳定派生;sameAs 链共享链根的值。 */
export function skillEvidenceCheckId(skillName: string, rootSpecId: string): string {
	return `skill-check:${skillName}:${rootSpecId}`;
}

/**
 * 解析 sameAs 链的根 spec id。M2 校验保证引用存在且不指向自身,但允许
 * 互相引用成环;遇到环时停在首个重复节点,保证终止且确定。
 */
function resolveSameAsRoot(spec: SkillEvidenceSpec, byId: ReadonlyMap<string, SkillEvidenceSpec>): string {
	let current = spec;
	const visited = new Set<string>([current.id]);
	while (current.sameAs !== undefined) {
		const next = byId.get(current.sameAs);
		if (!next || visited.has(next.id)) break;
		visited.add(next.id);
		current = next;
	}
	return current.id;
}

function buildVerifier(skillName: string, spec: SkillEvidenceSpec, rootSpecId: string): AcceptanceVerifier {
	const checkId = skillEvidenceCheckId(skillName, rootSpecId);
	// expect 的编码位置因 kind 而异:command 有原生退出码语义;browser/api 编进
	// assertion id;artifact 编进 schema id。review/external 的回执结构没有
	// per-assertion 槽位,expect 编进其主标识,host 适配层按标识回填。
	const expectTag = `expect-${spec.expect}`;
	switch (spec.kind) {
		case "command":
			return {
				kind: "command",
				checkId,
				expectedExitCode: spec.expect === "pass" ? 0 : 1,
			};
		case "browser":
			return {
				kind: "browser",
				scenarioId: checkId,
				assertionIds: [`${skillEvidenceCheckId(skillName, spec.id)}:${expectTag}`],
			};
		case "api":
			return {
				kind: "api",
				requestId: checkId,
				assertionIds: [`${skillEvidenceCheckId(skillName, spec.id)}:${expectTag}`],
			};
		case "artifact":
			return {
				kind: "artifact",
				artifactKind: checkId,
				schemaId: `skill-evidence:${expectTag}`,
			};
		case "review":
			return {
				kind: "review",
				rubricId: `${checkId}:${expectTag}`,
				requiredEvidenceKinds: [],
			};
		case "external":
			return {
				kind: "external",
				dependencyId: `${checkId}:${expectTag}`,
			};
	}
}

/**
 * 把 skill 的证据链声明编译为 acceptance gate 模板。空 evidence 返回空数组。
 * 产出的 gate 未绑定 assignment/freshness — 那是物化方(San Loop runner 或
 * 会话容器)的职责。
 */
export function compileSkillGates(input: CompileSkillGatesInput): AcceptanceGate[] {
	const { skill, contractRef, contractRevision, contractHash } = input;
	if (skill.evidence.length === 0) return [];
	const byId = new Map(skill.evidence.map(spec => [spec.id, spec]));
	return skill.evidence.map(spec => ({
		gateId: skillGateId(skill.name, spec.id),
		contractRef,
		contractRevision,
		contractHash,
		objectiveClauseRefs: [...contractRef.clauseRefs],
		verifier: buildVerifier(skill.name, spec, resolveSameAsRoot(spec, byId)),
		status: "unknown" as const,
		evidenceRefs: [],
		required: spec.phase === "before-done",
	}));
}
