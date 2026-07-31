import { describe, expect, it } from "bun:test";
import { resolveSanBrainRuntimePolicy } from "@san/coding-agent/brain/runtime-policy";
import { Settings } from "@san/coding-agent/config/settings";

describe("San Brain runtime policy", () => {
	it("keeps every Brain behavior off when the global switch is disabled", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": false,
			"san.brain.mode": "projection",
			"san.brain.capture.enabled": true,
			"san.brain.projections.enabled": true,
			"san.brain.compatibility.legacyAutoRetain": "block",
		});

		expect(resolveSanBrainRuntimePolicy(settings)).toEqual({
			enabled: false,
			mode: "projection",
			captureEnabled: false,
			autoDecisionEnabled: false,
			activationEnabled: false,
			projectionEnabled: false,
			legacyAutoRetainAllowed: true,
		});
	});

	it("enables capture without activation or projection in review-only mode", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "review-only",
			"san.brain.capture.enabled": true,
			"san.brain.projections.enabled": true,
			"san.brain.compatibility.legacyAutoRetain": "block",
		});

		expect(resolveSanBrainRuntimePolicy(settings)).toEqual({
			enabled: true,
			mode: "review-only",
			captureEnabled: true,
			autoDecisionEnabled: false,
			activationEnabled: false,
			projectionEnabled: false,
			legacyAutoRetainAllowed: false,
		});
	});

	it("enables activation without projection and preserves warn compatibility", () => {
		const settings = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "activation",
			"san.brain.capture.enabled": false,
			"san.brain.projections.enabled": true,
			"san.brain.compatibility.legacyAutoRetain": "warn",
		});

		expect(resolveSanBrainRuntimePolicy(settings)).toEqual({
			enabled: true,
			mode: "activation",
			captureEnabled: false,
			autoDecisionEnabled: true,
			activationEnabled: true,
			projectionEnabled: false,
			legacyAutoRetainAllowed: true,
		});
	});

	it("defaults enabled Brain sessions to low-authority activation", () => {
		const settings = Settings.isolated({ "san.brain.enabled": true });

		expect(resolveSanBrainRuntimePolicy(settings)).toMatchObject({
			mode: "activation",
			autoDecisionEnabled: true,
			activationEnabled: true,
			projectionEnabled: false,
		});
	});

	it("enables projection only when every projection gate is open", () => {
		const enabled = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "projection",
			"san.brain.capture.enabled": true,
			"san.brain.projections.enabled": true,
			"san.brain.compatibility.legacyAutoRetain": "allow",
		});
		const disabled = Settings.isolated({
			"san.brain.enabled": true,
			"san.brain.mode": "projection",
			"san.brain.projections.enabled": false,
			"san.brain.compatibility.legacyAutoRetain": "allow",
		});

		expect(resolveSanBrainRuntimePolicy(enabled)).toMatchObject({
			activationEnabled: true,
			projectionEnabled: true,
			legacyAutoRetainAllowed: false,
		});
		expect(resolveSanBrainRuntimePolicy(disabled)).toMatchObject({
			activationEnabled: true,
			projectionEnabled: false,
			legacyAutoRetainAllowed: false,
		});
	});
});
