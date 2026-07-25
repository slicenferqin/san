import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showModelSelector = vi.fn();
	const showModelRoleSelector = vi.fn();
	const showConnectSelector = vi.fn(async () => {});
	const showWarning = vi.fn();
	const setText = vi.fn();
	return {
		showModelSelector,
		showModelRoleSelector,
		showConnectSelector,
		showWarning,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
				showModelRoleSelector,
				showConnectSelector,
				showWarning,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model session-only picker", () => {
	it("opens direct session select without role mode", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith();
		expect(harness.showModelRoleSelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("routes /model roles to the expert role selector", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/model roles", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showModelRoleSelector).toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});

	it("rejects extra arguments after /model roles", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/model roles extra", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showModelRoleSelector).not.toHaveBeenCalled();
		expect(harness.showWarning).toHaveBeenCalledWith("Usage: /model [roles]");
	});

	it("keeps /models as an alias of /model", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/models", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith();
	});
});

describe("/switch compatibility", () => {
	it("opens the same session-only picker as /model", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
	});
});

describe("/connect", () => {
	it("opens the provider connect surface", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/connect", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showConnectSelector).toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
