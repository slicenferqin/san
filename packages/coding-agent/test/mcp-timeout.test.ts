import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-pi/pi-utils";

const ORIGINAL_SAN_TIMEOUT = process.env.SAN_MCP_TIMEOUT_MS;
const ORIGINAL_OMP_TIMEOUT = process.env.OMP_MCP_TIMEOUT_MS;

function restoreTimeoutEnv(): void {
	if (ORIGINAL_SAN_TIMEOUT === undefined) delete process.env.SAN_MCP_TIMEOUT_MS;
	else process.env.SAN_MCP_TIMEOUT_MS = ORIGINAL_SAN_TIMEOUT;
	if (ORIGINAL_OMP_TIMEOUT === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
	else process.env.OMP_MCP_TIMEOUT_MS = ORIGINAL_OMP_TIMEOUT;
}

function clearTimeoutEnv(): void {
	delete process.env.SAN_MCP_TIMEOUT_MS;
	delete process.env.OMP_MCP_TIMEOUT_MS;
}

afterEach(() => {
	restoreTimeoutEnv();
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		clearTimeoutEnv();

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		clearTimeoutEnv();

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("allows SAN_MCP_TIMEOUT_MS to disable MCP client-side timeouts", () => {
		clearTimeoutEnv();
		process.env.SAN_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows SAN_MCP_TIMEOUT_MS to set one timeout for every server", () => {
		clearTimeoutEnv();
		process.env.SAN_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("prefers SAN_MCP_TIMEOUT_MS over legacy OMP_MCP_TIMEOUT_MS", () => {
		process.env.SAN_MCP_TIMEOUT_MS = "45000";
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(45_000);
	});

	test("keeps legacy OMP_MCP_TIMEOUT_MS as a fallback", () => {
		clearTimeoutEnv();
		process.env.OMP_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("rejects negative env values and warns, falling back to the default", () => {
		clearTimeoutEnv();
		process.env.SAN_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("SAN_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		clearTimeoutEnv();
		process.env.OMP_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
