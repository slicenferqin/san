import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@san/ai/types";
import { buildModel } from "@san/catalog/build";
import { Effort } from "@san/catalog/effort";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import type { ModelRouteRejectionCode } from "@san/coding-agent/config/model-route-resolver";

interface RouteModelOptions {
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	contextWindow?: number | null;
	maxTokens?: number | null;
	reasoning?: boolean;
}

function routeModel(id: string, options: RouteModelOptions = {}): Model<Api> {
	const reasoning = options.reasoning ?? true;
	return buildModel({
		provider: "routes",
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://routes.example.invalid/v1",
		reasoning,
		...(reasoning && { thinking: { mode: "effort", efforts: [Effort.High] } }),
		input: options.input ?? ["text", "image"],
		supportsTools: options.supportsTools ?? true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow === undefined ? 4_096 : options.contextWindow,
		maxTokens: options.maxTokens === undefined ? 1_024 : options.maxTokens,
	});
}

function rejectionCodes(
	trace: readonly { routeId: string; rejections: readonly { code: ModelRouteRejectionCode }[] }[],
	routeId: string,
): ModelRouteRejectionCode[] {
	return trace.find(candidate => candidate.routeId === routeId)?.rejections.map(rejection => rejection.code) ?? [];
}

describe("deterministic model route resolver", () => {
	test("priority、config order、affinity 和 failover 排序保持稳定", () => {
		const models = [routeModel("first"), routeModel("second"), routeModel("preferred")];
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: [
						{ id: "first", model: "routes/first", priority: 20, equivalence: "exact" },
						{ id: "second", model: "routes/second", priority: 20, equivalence: "exact" },
						{ id: "preferred", model: "routes/preferred", priority: 10, equivalence: "exact" },
					],
				},
			},
			models,
		);

		for (let iteration = 0; iteration < 5; iteration += 1) {
			const primary = registry.resolve("logical");
			expect(primary?.route?.id).toBe("preferred");
			expect(primary?.trace.map(candidate => candidate.routeId)).toEqual(["preferred", "first", "second"]);
		}

		const affinity = registry.resolve("logical", { affinityRouteId: "second" });
		expect(affinity?.route?.id).toBe("second");
		expect(affinity?.reason).toBe("affinity");

		const failover = registry.resolve("logical", {
			excludedRouteIds: new Set(["preferred", "first"]),
			selectionReason: "failover",
		});
		expect(failover?.route?.id).toBe("second");
		expect(failover?.reason).toBe("failover");
	});

	test("manual route 可选择 unknown equivalence，未知 manual id 明确失败", () => {
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: [
						{ id: "automatic", model: "routes/automatic", priority: 10, equivalence: "exact" },
						{ id: "manual-only", model: "routes/manual-only", priority: 1, equivalence: "unknown" },
					],
				},
			},
			[routeModel("automatic"), routeModel("manual-only")],
		);

		expect(registry.resolve("logical")?.route?.id).toBe("automatic");
		expect(rejectionCodes(registry.resolve("logical")?.trace ?? [], "manual-only")).toContain("equivalence_unknown");
		expect(registry.resolve("logical", { manualRouteId: "manual-only" })?.route?.id).toBe("manual-only");
		expect(() => registry.resolve("logical", { manualRouteId: "missing" })).toThrow(
			'Unknown manual route "missing" for logical model "logical"',
		);
	});

	test("eligibility trace 逐项解释 enabled、availability、auth 与请求能力拒绝", () => {
		const models = [
			routeModel("disabled"),
			routeModel("unavailable"),
			routeModel("unauthenticated"),
			routeModel("suppressed"),
			routeModel("images", { input: ["text"] }),
			routeModel("tools", { supportsTools: false }),
			routeModel("context", { contextWindow: 64 }),
			routeModel("output", { maxTokens: 32 }),
			routeModel("effort", { reasoning: false }),
			routeModel("unknown"),
			routeModel("valid"),
		];
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: models.map((model, index) => ({
						id: model.id,
						model: `routes/${model.id}`,
						priority: index,
						enabled: model.id !== "disabled",
						equivalence: model.id === "unknown" ? ("unknown" as const) : ("exact" as const),
					})),
				},
			},
			models,
		);

		const resolution = registry.resolve("logical", {
			requiredContextTokens: 128,
			requiredOutputTokens: 64,
			requiresImages: true,
			requiresTools: true,
			thinkingLevel: Effort.High,
			suppressedRouteIds: new Set(["suppressed"]),
			isAvailable: route => route.id !== "unavailable",
			hasAuth: route => route.id !== "unauthenticated",
		});

		expect(resolution?.route?.id).toBe("valid");
		expect(rejectionCodes(resolution?.trace ?? [], "disabled")).toContain("disabled");
		expect(rejectionCodes(resolution?.trace ?? [], "unavailable")).toContain("unavailable");
		expect(rejectionCodes(resolution?.trace ?? [], "unauthenticated")).toContain("unauthenticated");
		expect(rejectionCodes(resolution?.trace ?? [], "suppressed")).toContain("suppressed");
		expect(rejectionCodes(resolution?.trace ?? [], "images")).toContain("images_unsupported");
		expect(rejectionCodes(resolution?.trace ?? [], "tools")).toContain("tools_unsupported");
		expect(rejectionCodes(resolution?.trace ?? [], "context")).toContain("context_window_too_small");
		expect(rejectionCodes(resolution?.trace ?? [], "output")).toContain("output_limit_too_small");
		expect(rejectionCodes(resolution?.trace ?? [], "effort")).toContain("effort_unsupported");
		expect(rejectionCodes(resolution?.trace ?? [], "unknown")).toContain("equivalence_unknown");
	});

	test("所有候选不可用时返回完整拒绝 trace 而不是静默选中", () => {
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: [
						{ id: "first", model: "routes/first", equivalence: "exact" },
						{ id: "second", model: "routes/second", equivalence: "exact" },
					],
				},
			},
			[routeModel("first"), routeModel("second")],
		);
		const resolution = registry.resolve("logical", { hasAuth: () => false });

		expect(resolution?.route).toBeUndefined();
		expect(resolution?.reason).toBeUndefined();
		expect(resolution?.trace).toHaveLength(2);
		expect(resolution?.trace.every(candidate => candidate.rejections[0]?.code === "unauthenticated")).toBe(true);
	});
});
