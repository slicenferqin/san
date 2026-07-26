import { describe, expect, it } from "bun:test";
import { OAuthManualInputManager } from "@san/coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@san/coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext };
	getStatus: () => string | undefined;
	getWarning: () => string | undefined;
	getSelectorMode: () => "login" | "logout" | undefined;
	getSelectorProvider: () => string | undefined;
	getConnectCalls: () => number;
};

const createRuntimeHarness = (manualInput: OAuthManualInputManager): RuntimeHarness => {
	let statusMessage: string | undefined;
	let warningMessage: string | undefined;
	let selectorMode: "login" | "logout" | undefined;
	let selectorProvider: string | undefined;
	let connectCalls = 0;
	const ctx = {
		oauthManualInput: manualInput,
		editor: {
			setText: () => {},
		} as unknown as InteractiveModeContext["editor"],
		showStatus: (message: string) => {
			statusMessage = message;
		},
		showWarning: (message: string) => {
			warningMessage = message;
		},
		showOAuthSelector: async (mode: "login" | "logout", providerId?: string) => {
			selectorMode = mode;
			selectorProvider = providerId;
		},
		showConnectSelector: async () => {
			connectCalls += 1;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
		},
		getStatus: () => statusMessage,
		getWarning: () => warningMessage,
		getSelectorMode: () => selectorMode,
		getSelectorProvider: () => selectorProvider,
		getConnectCalls: () => connectCalls,
	};
};

describe("/login slash command", () => {
	it("submits manual callback URL without opening selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const callbackUrl = "http://localhost:1455/auth/callback?code=abc&state=xyz";
		const pending = manualInput.waitForInput("openai-codex");
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand(`/login ${callbackUrl}`, harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getStatus()).toBe("OAuth callback received; completing login…");
		expect(await pending).toBe(callbackUrl);
	});

	it("forwards no-argument login to the unified connect selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getConnectCalls()).toBe(1);
	});

	it("routes /login kagi to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});

	it("routes /login parallel to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login parallel", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("parallel");
	});

	it("warns when no pending login exists for manual callback", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login http://localhost/callback", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getWarning()).toBe("No OAuth login is waiting for a manual callback.");
	});
});

describe("/logout slash command", () => {
	it("forwards no-argument logout to the dedicated logout selector", async () => {
		const harness = createRuntimeHarness(new OAuthManualInputManager());
		const handled = await executeBuiltinSlashCommand("/logout", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("logout");
		expect(harness.getSelectorProvider()).toBeUndefined();
		expect(harness.getConnectCalls()).toBe(0);
	});
});
