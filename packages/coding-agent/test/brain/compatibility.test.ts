import { describe, expect, it } from "bun:test";
import { resolveSanBrainLegacyAutoRetain } from "@oh-my-pi/pi-coding-agent/brain/compatibility";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("San Brain legacy auto-retain compatibility", () => {
	it("disables legacy direct writes whenever projection mode is active", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "projection",
			"san.brain.compatibility.legacyAutoRetain": "allow",
		});
		const result = resolveSanBrainLegacyAutoRetain(settings, "mnemopi", true);
		expect(result.effective).toBe(false);
		expect(result.warning).toContain("durable writes must use the Brain outbox");
	});

	it("keeps legacy writes in activation mode when policy is warn", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "activation",
			"san.brain.compatibility.legacyAutoRetain": "warn",
		});
		const result = resolveSanBrainLegacyAutoRetain(settings, "hindsight", true);
		expect(result.effective).toBe(true);
		expect(result.warning).toContain("Review-only/activation mode keeps it for compatibility");
	});

	it("honors an explicit block policy before projection rollout", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "review-only",
			"san.brain.compatibility.legacyAutoRetain": "block",
		});
		expect(resolveSanBrainLegacyAutoRetain(settings, "mnemopi", true)).toEqual({
			effective: false,
			warning: "San Brain compatibility policy blocked mnemopi.autoRetain for this session.",
		});
	});

	it("does not change legacy configuration while Brain is disabled", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": false,
			"san.brain.mode": "projection",
			"san.brain.compatibility.legacyAutoRetain": "block",
		});
		expect(resolveSanBrainLegacyAutoRetain(settings, "hindsight", true)).toEqual({ effective: true });
	});
});
