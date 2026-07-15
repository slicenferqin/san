import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { runSanBrainBackendDogfood } from "@oh-my-pi/pi-coding-agent/brain/backend-dogfood";
import { runSanBrainDogfood } from "@oh-my-pi/pi-coding-agent/brain/dogfood";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("San Brain M6 dogfood", () => {
	test("passes the deterministic 14-turn acceptance contract", async () => {
		const summary = await runSanBrainDogfood();

		expect(summary.ok).toBe(true);
		expect(summary.turns).toBe(14);
		expect(summary.scenarios).toHaveLength(14);
		expect(summary.scenarios.every(scenario => scenario.ok)).toBe(true);
		expect(summary.metrics).toMatchObject({
			happyPathFrontendExposure: 0,
			unrelatedActivations: 0,
			unrelatedRecalls: 0,
			duplicateExternalWrites: 0,
			unsafeOverwrites: 0,
			maxNotificationsPerProjection: 1,
			projectionOrphans: 0,
			maxProjectionAttempts: 1,
			secretLeaks: 0,
		});
		expect(summary.metrics.maxCandidatesPerTurn).toBeLessThanOrEqual(5);
		expect(summary.metrics.maxActivationTokens).toBeLessThanOrEqual(1200);
		expect(summary.metrics.latency.maxMs).toBeLessThanOrEqual(10_000);
		expect(summary.reportText).toContain("turns=14");
		expect(summary.reportText).toContain("duplicateWrites=0 unsafeOverwrites=0");
	});

	test("proves the off, local, Mnemopi, and Hindsight capability matrix", async () => {
		const summary = await runSanBrainBackendDogfood();

		expect(summary.ok).toBe(true);
		expect(summary.cases.map(item => item.backend)).toEqual(["off", "local", "mnemopi", "hindsight"]);
		expect(summary.cases.every(item => item.ok)).toBe(true);
		expect(summary.cases[0]?.projection).toBe("blocked:backend_unavailable");
		expect(summary.cases[1]?.compensation).toBe("blocked:unsafe_undo");
		expect(summary.cases[2]?.recall).toContain("alpha=1, beta=1");
		expect(summary.cases[2]?.projection).toContain("missing=missing");
		expect(summary.cases[3]?.recall).toContain("controlled-unavailable=continued");
	});

	test("loads the checked-in M6 overlay through the real Settings loader", async () => {
		await using tempDir = await TempDir.create("@san-brain-m6-overlay-");
		const overlay = path.resolve(import.meta.dir, "..", "..", "examples", "config", "san-brain-m6-dogfood.yml");
		const settings = await Settings.loadReadOnly({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});

		expect(settings.get("mnemopi.autoRetain")).toBe(false);
		expect(settings.get("hindsight.autoRetain")).toBe(false);
		expect(settings.get("san.contextSteady.enabled")).toBe(true);
		expect(settings.get("san.contextSteady.digest.enabled")).toBe(true);
		expect(settings.get("san.contextSteady.digest.persistFallback")).toBe(true);
		expect(settings.get("san.contextSteady.contextPacket.enabled")).toBe(true);
		expect(settings.get("san.contextSteady.recall.enabled")).toBe(true);
		expect(settings.get("san.contextSteady.recall.maxItems")).toBe(3);
		expect(settings.get("san.contextSteady.recall.maxTokens")).toBe(1000);
		expect(settings.get("san.contextSteady.recall.maxQueryChars")).toBe(2000);
		expect(settings.get("san.brain.enabled")).toBe(true);
		expect(settings.get("san.brain.mode")).toBe("projection");
		expect(settings.get("san.brain.capture.enabled")).toBe(true);
		expect(settings.get("san.brain.capture.maxCandidatesPerTurn")).toBe(5);
		expect(settings.get("san.brain.capture.minConfidence")).toBe(0.72);
		expect(settings.get("san.brain.activation.maxItems")).toBe(8);
		expect(settings.get("san.brain.activation.maxTokens")).toBe(1200);
		expect(settings.get("san.brain.activation.minConfidence")).toBe(0.75);
		expect(settings.get("san.brain.activation.globalMaxTokens")).toBe(6000);
		expect(settings.get("san.brain.projections.enabled")).toBe(true);
		expect(settings.get("san.brain.projections.maxAttempts")).toBe(3);
		expect(settings.get("san.brain.projections.attemptTimeoutMs")).toBe(10_000);
		expect(settings.get("san.brain.projections.maxPerTurn")).toBe(4);
		expect(settings.get("san.brain.compatibility.legacyAutoRetain")).toBe("block");
	});
});
