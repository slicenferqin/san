import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@san/ai";
import * as ai from "@san/ai";
import { getBundledModel } from "@san/catalog/models";
import { getDefault, getEnumValues, getUi } from "@san/coding-agent/config/settings-schema";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "@san/coding-agent/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "@san/coding-agent/tiny/dtype";
import { generateSessionTitle } from "@san/coding-agent/utils/title-generator";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

function mockOnlineTitle(title: string | null) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: title ? [{ type: "text", text: `<title>${title}</title>` }] : [{ type: "text", text: "" }],
	} as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session title generation", () => {
	it("always uses the online title model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle("Investigate routing", createRegistry(model), createSettings(model));

		expect(title).toBe("Online Title");
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("passes TITLE_SYSTEM.md overrides through the online title path", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const online = mockOnlineTitle("fix:routing");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("fix:routing");
		expect(online.mock.calls[0]?.[1]).toMatchObject({
			systemPrompt: [customPrompt, expect.any(String)],
		});
	});
});

describe("tiny model acceleration schema", () => {
	it("keeps the device setting in sync with the device module constants", () => {
		expect(getEnumValues("providers.tinyModelDevice")).toEqual([...TINY_MODEL_DEVICE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDevice")?.options).toEqual(TINY_MODEL_DEVICE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDevice")).toBe(TINY_MODEL_DEVICE_DEFAULT);
	});

	it("keeps the precision setting in sync with the dtype module constants", () => {
		expect(getEnumValues("providers.tinyModelDtype")).toEqual([...TINY_MODEL_DTYPE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDtype")?.options).toEqual(TINY_MODEL_DTYPE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDtype")).toBe(TINY_MODEL_DTYPE_DEFAULT);
	});
});
