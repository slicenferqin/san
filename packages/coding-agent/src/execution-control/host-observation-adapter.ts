/**
 * 根会话工具完成事实 → HostObservation 适配器(根会话 watchdog 闭环)。
 *
 * 纯函数、无 IO:把 after-tool-call 的宿主事实(工具名、参数、退出码)规范化
 * 为 progress classifier 能理解的观察。身份约定:
 * - `workKey` 是 scope 的 objective contract id — 同一权威 turn 内的所有工具
 *   动作属于同一份工作;
 * - `strategyKey` 是"动作指纹"(工具名 + 关键参数),同一动作反复执行会推高
 *   watchdog 的 repeatCount,这正是重复轮询/同命令反复失败的活锁信号;
 * - bash 失败带稳定 `failureSignature`(命令指纹 + 退出码),同签名反复失败
 *   触发 suspicious 判定。
 *
 * 判定层不在此处:决策永远由 Watchdog(经 runtime.recordHostObservation)给出。
 */
import type { HostObservation } from "./progress-classifier";
import { stableValueFingerprint } from "./progress-classifier";

export interface ToolCompletionFact {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly isError: boolean;
	/** 工具结果 details(bash 的 exitCode/timedOut 从这里取)。 */
	readonly details?: unknown;
	/** scope 的 objective contract id,作 workKey。 */
	readonly workKey: string;
}

const MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_edit"]);
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "find", "explore"]);

function pathArg(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath", "pattern"]) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/**
 * 把一次完成的工具调用转成宿主观察。返回 undefined 表示该调用不构成可分类
 * 的完成事实(如 bash 超时/取消、无命令文本)。
 */
export function toolCompletionObservation(fact: ToolCompletionFact): HostObservation | undefined {
	const { toolName, args, workKey } = fact;

	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (!command) return undefined;
		const details = fact.details as { exitCode?: unknown; timedOut?: unknown } | undefined;
		if (details?.timedOut === true) return undefined;
		// bash 仅在非零退出时写 details.exitCode;isError 且无退出码是取消/中断。
		const exitCode = typeof details?.exitCode === "number" ? details.exitCode : fact.isError ? undefined : 0;
		if (exitCode === undefined) return undefined;
		const commandFingerprint = stableValueFingerprint(command);
		const strategyKey = `tool:bash:${commandFingerprint}`;
		if (exitCode !== 0) {
			return {
				type: "failure",
				workKey,
				strategyKey,
				failureSignature: `bash:${commandFingerprint}:exit:${exitCode}`,
				cursor: `exit:${exitCode}`,
			};
		}
		return { type: "activity", workKey, strategyKey, cursor: `exit:0:${commandFingerprint}` };
	}

	if (MUTATION_TOOLS.has(toolName)) {
		if (fact.isError) {
			// 失败的编辑(patch 不匹配等)同样是宿主事实:同一文件反复失败编辑
			// 是典型活锁形态。
			return {
				type: "failure",
				workKey,
				strategyKey: `tool:${toolName}:${stableValueFingerprint(pathArg(args) ?? args)}`,
				failureSignature: `${toolName}:${stableValueFingerprint(args)}`,
			};
		}
		return {
			type: "mutation",
			workKey,
			strategyKey: `tool:${toolName}:${stableValueFingerprint(pathArg(args) ?? args)}`,
			path: pathArg(args),
			operation: toolName,
			contentFingerprint: stableValueFingerprint(args),
			changed: true,
		};
	}

	if (READ_TOOLS.has(toolName)) {
		return {
			type: "read",
			workKey,
			strategyKey: `tool:${toolName}:${stableValueFingerprint(args)}`,
			path: pathArg(args),
			resourceKey: stableValueFingerprint(args),
			cursor: stableValueFingerprint(args),
		};
	}

	// 其余工具一律计为 activity;同参重复调用仍可被 unchanged-poll 检测捕获。
	return {
		type: "activity",
		workKey,
		strategyKey: `tool:${toolName}:${stableValueFingerprint(args)}`,
		resourceKey: stableValueFingerprint(args),
		cursor: stableValueFingerprint(args),
	};
}
