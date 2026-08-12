import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@san/coding-agent/config/settings";
import { SETTING_TABS } from "@san/coding-agent/config/settings-schema";
import { getSettingsForTab, tabHasExpertSettings } from "@san/coding-agent/modes/components/settings-defs";

/**
 * Contracts for the M1 novice-first audience split (plan §3): the default
 * settings view only exposes the daily layer, the expert layer stays
 * reachable behind an explicit opt-in, and unmarked definitions keep their
 * pre-M1 (daily) visibility.
 */
describe("settings audience layering", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("default tab views exclude expert settings and stay within the daily budget", () => {
		let dailyTotal = 0;
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
			expect(defs.filter(def => def.audience === "expert")).toEqual([]);
			dailyTotal += defs.length;
		}
		// M1 DoD: the daily layer fits on one screen. A new UI setting without
		// an explicit audience lands in the daily layer and will trip this.
		expect(dailyTotal).toBeLessThanOrEqual(30);
		expect(dailyTotal).toBeGreaterThan(0);
	});

	it("includeExpert restores the full definition set", () => {
		for (const tab of SETTING_TABS) {
			const daily = getSettingsForTab(tab);
			const all = getSettingsForTab(tab, { includeExpert: true });
			const dailyPaths = new Set(daily.map(def => def.path));
			// Daily view is a strict subset of the full view.
			for (const path of dailyPaths) {
				expect(all.some(def => def.path === path)).toBe(true);
			}
			// Everything hidden from the daily view carries the expert marker.
			for (const def of all) {
				if (!dailyPaths.has(def.path)) expect(def.audience).toBe("expert");
			}
		}
		const contextAll = getSettingsForTab("context", { includeExpert: true });
		expect(contextAll.some(def => def.path === "compaction.enabled" && def.audience === "expert")).toBe(true);
	});

	it("definitions without an audience marker stay visible by default", () => {
		const appearance = getSettingsForTab("appearance");
		const themeDark = appearance.find(def => def.path === "theme.dark");
		expect(themeDark).toBeDefined();
		expect(themeDark?.audience).toBeUndefined();
	});

	it("keeps prerequisites for reaching the destination in the daily layer", () => {
		const dailyPaths = new Set(SETTING_TABS.flatMap(tab => getSettingsForTab(tab).map(def => def.path)));
		// Theme, thinking depth, and approval posture are Q3 items from the
		// adjudication table — they must never silently move to expert.
		expect(dailyPaths.has("theme.dark")).toBe(true);
		expect(dailyPaths.has("theme.light")).toBe(true);
		expect(dailyPaths.has("defaultThinkingLevel")).toBe(true);
		expect(dailyPaths.has("tools.approvalMode")).toBe(true);
	});

	it("reports expert availability per tab for the toggle row", () => {
		// Every tab currently owns at least one expert setting, so the
		// "Show expert settings" toggle renders everywhere.
		for (const tab of SETTING_TABS) {
			expect(tabHasExpertSettings(tab)).toBe(true);
		}
	});
});
