import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../../utils/src/temp";
import { withFileLock } from "../src/config/file-lock";
import {
	addCustomModelConfig,
	listCustomProviderConfigSummaries,
	previewCustomProviderConfig,
	removeCustomProviderConfig,
	validateCustomProviderConfigDestination,
	writeCustomProviderConfig,
} from "../src/config/models-config-writer";
import { applyYamlPathPatches, patchYamlFile } from "../src/config/yaml-path-patch";

describe("yaml path patch", () => {
	let tempDir = "";

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("preserves comments and sibling keys when setting a nested path", () => {
		const source = `# top comment
providers:
  # keep me
  existing:
    baseUrl: https://old.example/v1
    auth: none
other: value
`;
		const result = applyYamlPathPatches(source, [
			{
				op: "set",
				path: ["providers", "new-proxy"],
				value: { baseUrl: "https://new.example/v1", auth: "apiKey" },
			},
		]);
		expect(result.changed).toBe(true);
		expect(result.text).toContain("# top comment");
		expect(result.text).toContain("# keep me");
		expect(result.text).toContain("existing:");
		expect(result.text).toContain("other: value");
		expect(result.text).toContain("new-proxy:");
		expect(result.text).toContain("https://new.example/v1");
		expect(result.text).not.toContain("sk-");
	});

	it("leaves unrelated YAML bytes unchanged when adding a block-map entry", () => {
		const source = `# keep spacing
providers:
  existing:
    baseUrl: https://old.example/v1
other: {a: 1,b: [2, 3]}
`;
		const result = applyYamlPathPatches(source, [
			{
				op: "set",
				path: ["providers", "new-proxy"],
				value: { baseUrl: "https://new.example/v1", auth: "apiKey" },
			},
		]);
		expect(result.text).toBe(`# keep spacing
providers:
  existing:
    baseUrl: https://old.example/v1
  new-proxy:
    baseUrl: https://new.example/v1
    auth: apiKey
other: {a: 1,b: [2, 3]}
`);
	});

	it("limits flow-map normalization to the modified provider map", () => {
		const source = "providers: {}\nother: {a: 1,b: [2, 3]}\n";
		const result = applyYamlPathPatches(source, [{ op: "set", path: ["providers", "new"], value: { auth: "none" } }]);
		expect(result.text).toContain("providers: { new: { auth: none } }");
		expect(result.text).toContain("other: {a: 1,b: [2, 3]}");
	});

	it("does not quote malformed YAML source lines in errors", () => {
		const legacySecret = "sk-old-secret-value";
		const source = `providers:\n  broken:\n    apiKey: "${legacySecret}\n`;
		let message = "";
		try {
			applyYamlPathPatches(source, [{ op: "set", path: ["providers", "new"], value: { auth: "none" } }]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("Invalid YAML document");
		expect(message).not.toContain(legacySecret);
	});

	it("preflights malformed destinations before persistence", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-preflight-"));
		const modelsPath = path.join(tempDir, "models.yml");
		const legacySecret = "sk-existing-secret";
		await Bun.write(modelsPath, `providers:\n  broken:\n    apiKey: "${legacySecret}\n`);

		let message = "";
		try {
			await validateCustomProviderConfigDestination(
				{ name: "new", baseUrl: "https://new.example/v1", auth: "apiKey" },
				{ modelsPath },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("Invalid models.yml document");
		expect(message).not.toContain(legacySecret);
	});

	it("writes atomically under lock without embedding secrets", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-patch-"));
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			`# dogfood
providers:
  local:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
`,
		);
		await fs.chmod(modelsPath, 0o600);

		const writeResult = await writeCustomProviderConfig(
			{
				name: "my-proxy",
				baseUrl: "https://proxy.example/v1",
				api: "openai-completions",
				auth: "apiKey",
				discovery: { type: "openai-models-list" },
			},
			{ modelsPath },
		);
		expect(writeResult.persisted).toBe(true);
		expect(writeResult.changed).toBe(true);

		const text = await Bun.file(modelsPath).text();
		expect(text).toContain("# dogfood");
		expect(text).toContain("local:");
		expect(text).toContain("my-proxy:");
		expect(text).toContain("auth: apiKey");
		expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
		expect(text).not.toContain("apiKey:");
		expect((await fs.stat(modelsPath)).mode & 0o777).toBe(0o600);
	});

	it("removes only the selected custom provider", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-remove-"));
		const modelsPath = path.join(tempDir, "models.yml");
		const source = `# keep
providers:
  remove-me:
    auth: none
  # keep sibling
  keep-me:
    auth: none
other: {a: 1,b: 2}
`;
		await Bun.write(modelsPath, source);

		const result = await removeCustomProviderConfig("remove-me", { modelsPath });
		const text = await Bun.file(modelsPath).text();
		expect(result.removed).toBe(true);
		expect(text).not.toContain("remove-me");
		expect(text).toContain("# keep sibling");
		expect(text).toContain("keep-me:");
		expect(text).toContain("other: {a: 1,b: 2}");
	});

	it("removes a bundled provider override without treating its id as an add collision", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-remove-override-"));
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(modelsPath, "providers:\n  openai:\n    baseUrl: https://proxy.example/v1\n");

		const result = await removeCustomProviderConfig("openai", { modelsPath });

		expect(result.removed).toBe(true);
		expect(await Bun.file(modelsPath).text()).toBe("providers:\n  {}\n");
	});

	it("previewCustomProviderConfig writes only non-secret provider metadata", () => {
		const preview = previewCustomProviderConfig("providers: {}\n", {
			name: "x",
			baseUrl: "https://x.example/v1",
			auth: "apiKey",
		});
		expect(preview.text).toContain("x:");
		expect(preview.text).not.toContain("apiKey:");
	});

	it("rejects bundled and existing provider ids without changing the document", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-collision-"));
		const modelsPath = path.join(tempDir, "models.yml");
		const original = `providers:\n  existing:\n    # preserve nested comment\n    baseUrl: https://old.example/v1\n    auth: none\n    headers:\n      X-Custom: keep\n`;
		await Bun.write(modelsPath, original);

		await expect(
			writeCustomProviderConfig(
				{ name: "existing", baseUrl: "https://new.example/v1", auth: "apiKey" },
				{ modelsPath },
			),
		).rejects.toThrow('Provider id "existing" already exists');
		expect(await Bun.file(modelsPath).text()).toBe(original);
		expect(() =>
			previewCustomProviderConfig("providers: {}\n", {
				name: "openai",
				baseUrl: "https://proxy.example/v1",
				auth: "apiKey",
			}),
		).toThrow('Provider id "openai" is reserved');
	});

	it("rejects URLs that could persist credentials outside AuthStorage", () => {
		expect(() =>
			previewCustomProviderConfig("providers: {}\n", {
				name: "proxy",
				baseUrl: "https://user:secret@proxy.example/v1",
				auth: "apiKey",
			}),
		).toThrow("must not contain credentials");
	});

	it("patchYamlFile is a no-op when patches do not change content", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-yaml-noop-"));
		const filePath = path.join(tempDir, "config.yml");
		const original = "a: 1\n";
		await Bun.write(filePath, original);
		const result = await withFileLock(filePath, () =>
			patchYamlFile(filePath, [{ op: "set", path: ["a"], value: 1 }]),
		);
		expect(result.changed).toBe(false);
		expect(await Bun.file(filePath).text()).toBe(original);
	});

	it("lists configured providers without secrets and preserves OAuth auth", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-provider-summary-"));
		const modelsPath = path.join(tempDir, "models.yml");
		const legacySecret = "sk-legacy-secret";
		await Bun.write(
			modelsPath,
			`providers:
  oauth-proxy:
    baseUrl: https://proxy.example/v1
    api: openai-completions
    auth: oauth
    apiKey: ${legacySecret}
    discovery:
      type: openai-models-list
    models:
      - id: proxy-model
`,
		);

		const summaries = await listCustomProviderConfigSummaries({ modelsPath });

		expect(summaries).toEqual([
			{
				providerId: "oauth-proxy",
				baseUrl: "https://proxy.example/v1",
				api: "openai-completions",
				auth: "oauth",
				discoveryType: "openai-models-list",
				modelCount: 1,
			},
		]);
		expect(JSON.stringify(summaries)).not.toContain(legacySecret);
	});

	it("adds an explicit custom model without rewriting the provider", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-model-add-"));
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			`providers:
  local-proxy:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
`,
		);

		const result = await addCustomModelConfig(
			{
				provider: "local-proxy",
				id: "local-model",
				name: "Local Model",
				api: "openai-completions",
				contextWindow: 128000,
				maxTokens: 8192,
				reasoning: true,
				input: ["text", "image"],
				supportsTools: true,
			},
			{ modelsPath },
		);

		expect(result.persisted).toBe(true);
		const text = await Bun.file(modelsPath).text();
		expect(text).toContain("local-proxy:");
		expect(text).toContain("id: local-model");
		expect(text).toContain("contextWindow: 128000");
		await expect(
			addCustomModelConfig({ provider: "local-proxy", id: "local-model" }, { modelsPath }),
		).rejects.toThrow('Model id "local-model" already exists');
	});
});
