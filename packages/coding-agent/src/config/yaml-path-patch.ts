/**
 * Comment-preserving YAML path patch helpers.
 *
 * Uses the `yaml` Document AST so edits keep comments, key order, and
 * unrelated siblings intact. Callers must still take a file lock and write
 * atomically around {@link patchYamlFile}.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
import { Document, isMap, isNode, isScalar, parseDocument, type YAMLMap } from "yaml";

export type YamlPathSegment = string | number;
export type YamlPath = readonly YamlPathSegment[];

export type YamlPathPatch =
	| { op: "set"; path: YamlPath; value: unknown }
	| { op: "delete"; path: YamlPath }
	| { op: "mergeMap"; path: YamlPath; value: Record<string, unknown> };

export interface YamlPathPatchResult {
	/** True when the on-disk bytes would change. */
	changed: boolean;
	/** Full document text after applying patches. */
	text: string;
}

function parsePatchDocument(source: string): Document {
	const doc: Document = parseDocument(source.length > 0 ? source : "{}\n", {
		keepSourceTokens: true,
		prettyErrors: false,
	});
	if (doc.errors.length > 0) {
		// Parser diagnostics may quote the source line, which can contain legacy
		// inline credentials. Keep untrusted file content out of UI errors.
		throw new Error("Invalid YAML document");
	}
	return doc;
}

function sourceLineEnding(source: string): "\n" | "\r\n" {
	return source.includes("\r\n") ? "\r\n" : "\n";
}

function nestedValue(path: readonly YamlPathSegment[], value: unknown): unknown {
	let nested = value;
	for (let index = path.length - 1; index >= 0; index--) {
		const segment = path[index];
		if (typeof segment === "number") return undefined;
		nested = { [segment]: nested };
	}
	return nested;
}

function renderMapEntry(key: string, value: unknown, indent: number, lineEnding: "\n" | "\r\n"): string {
	const entry = new Document({ [key]: value }).toString().trimEnd();
	const prefix = " ".repeat(indent);
	return `${entry
		.split("\n")
		.map(line => `${prefix}${line}`)
		.join(lineEnding)}${lineEnding}`;
}

function insertIntoBlockMap(source: string, map: YAMLMap, key: string, value: unknown): string | undefined {
	if (map.srcToken?.type !== "block-map" || !map.range) return undefined;
	const offset = map.range[2];
	const indent = map.srcToken.indent;
	const lineEnding = sourceLineEnding(source);
	const before = source.slice(0, offset);
	const separator = before.length > 0 && !before.endsWith("\n") && !before.endsWith("\r") ? lineEnding : "";
	return `${before}${separator}${renderMapEntry(key, value, indent, lineEnding)}${source.slice(offset)}`;
}

function currentValue(doc: Document, pathKey: readonly YamlPathSegment[]): unknown {
	const current = pathKey.length === 0 ? doc.contents : doc.getIn(pathKey, true);
	return isNode(current) ? current.toJSON() : current;
}

function replaceNodeAfterSet(
	source: string,
	doc: Document,
	setPath: readonly YamlPathSegment[],
	value: unknown,
	nodePath: readonly YamlPathSegment[],
): string | undefined {
	const original = nodePath.length === 0 ? doc.contents : doc.getIn(nodePath, true);
	if (!isNode(original) || !original.range) return undefined;
	const changed = doc.clone();
	changed.setIn(setPath, value);
	const serialized = String(changed);
	const reparsed = parsePatchDocument(serialized);
	const replacement = nodePath.length === 0 ? reparsed.contents : reparsed.getIn(nodePath, true);
	if (!isNode(replacement) || !replacement.range) return undefined;
	const text = serialized.slice(replacement.range[0], replacement.range[1]).replaceAll("\n", sourceLineEnding(source));
	return `${source.slice(0, original.range[0])}${text}${source.slice(original.range[1])}`;
}

function replaceNodeAfterDelete(
	source: string,
	doc: Document,
	deletePath: readonly YamlPathSegment[],
	nodePath: readonly YamlPathSegment[],
): string | undefined {
	const original = nodePath.length === 0 ? doc.contents : doc.getIn(nodePath, true);
	if (!isNode(original) || !original.range) return undefined;
	const changed = doc.clone();
	changed.deleteIn(deletePath);
	const serialized = String(changed);
	const reparsed = parsePatchDocument(serialized);
	const replacement = nodePath.length === 0 ? reparsed.contents : reparsed.getIn(nodePath, true);
	if (!isNode(replacement) || !replacement.range) return undefined;
	const text = serialized.slice(replacement.range[0], replacement.range[1]).replaceAll("\n", sourceLineEnding(source));
	return `${source.slice(0, original.range[0])}${text}${source.slice(original.range[1])}`;
}

/** Add a map entry by splicing only the owning block map's source range. */
function tryMinimalSet(source: string, pathKey: readonly YamlPathSegment[], value: unknown): string | undefined {
	if (pathKey.length === 0) return undefined;
	const doc = parsePatchDocument(source);
	if (Bun.deepEquals(currentValue(doc, pathKey), value)) return source;
	const existing = doc.getIn(pathKey, true);
	if (isNode(existing)) return replaceNodeAfterSet(source, doc, pathKey, value, pathKey);

	for (let ancestorLength = pathKey.length - 1; ancestorLength >= 0; ancestorLength--) {
		const ancestorPath = pathKey.slice(0, ancestorLength);
		const ancestor = ancestorPath.length === 0 ? doc.contents : doc.getIn(ancestorPath, true);
		if (!isMap(ancestor)) continue;
		const missingPath = pathKey.slice(ancestorLength);
		const first = missingPath[0];
		if (typeof first !== "string" || ancestor.has(first)) return undefined;
		const childValue = nestedValue(missingPath.slice(1), value);
		if (childValue === undefined) return undefined;
		return (
			insertIntoBlockMap(source, ancestor, first, childValue) ??
			replaceNodeAfterSet(source, doc, pathKey, value, ancestorPath)
		);
	}
	return undefined;
}

function tryMinimalDelete(source: string, pathKey: readonly YamlPathSegment[]): string | undefined {
	if (pathKey.length === 0) return undefined;
	const doc = parsePatchDocument(source);
	const parentPath = pathKey.slice(0, -1);
	const key = pathKey[pathKey.length - 1];
	const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
	if (!isMap(parent) || typeof key !== "string") return undefined;
	const pair = parent.items.find(item => isScalar(item.key) && item.key.value === key);
	if (!pair) return source;
	if (parent.srcToken?.type !== "block-map") {
		return replaceNodeAfterDelete(source, doc, pathKey, parentPath);
	}
	if (parent.items.length === 1 && parent.range) {
		const suffix = source.slice(parent.range[1]);
		const trailingLineEnding =
			suffix.length === 0 && (source.endsWith("\n") || source.endsWith("\r")) ? sourceLineEnding(source) : "";
		return `${source.slice(0, parent.range[0])}{}${trailingLineEnding}${suffix}`;
	}
	const keyStart = isNode(pair.key) ? pair.key.range?.[0] : undefined;
	const start =
		pair.srcToken?.start[0]?.offset ??
		(keyStart === undefined ? undefined : source.lastIndexOf("\n", Math.max(0, keyStart - 1)) + 1);
	const end = isNode(pair.value) ? pair.value.range?.[2] : isNode(pair.key) ? pair.key.range?.[2] : undefined;
	if (start === undefined || end === undefined) return replaceNodeAfterDelete(source, doc, pathKey, parentPath);
	return `${source.slice(0, start)}${source.slice(end)}`;
}

function applyPatchWithSerialization(source: string, patch: YamlPathPatch): string {
	const doc = parsePatchDocument(source);
	const pathKey = [...patch.path] as Array<string | number>;
	if (patch.op === "delete") {
		if (pathKey.length > 0) doc.deleteIn(pathKey);
	} else if (patch.op === "set") {
		if (pathKey.length === 0) doc.contents = doc.createNode(patch.value);
		else doc.setIn(pathKey, patch.value);
	} else {
		const existing = pathKey.length === 0 ? doc.contents : doc.getIn(pathKey, true);
		let target: YAMLMap;
		if (isMap(existing)) {
			target = existing;
		} else {
			target = doc.createNode({}) as YAMLMap;
			if (pathKey.length === 0) doc.contents = target;
			else doc.setIn(pathKey, target);
		}
		for (const [entryKey, entryValue] of Object.entries(patch.value)) target.set(entryKey, entryValue);
	}
	const serialized = String(doc);
	return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

/**
 * Apply path patches to a YAML document string, preserving comments, key order,
 * and untouched source bytes for block-map additions.
 */
export function applyYamlPathPatches(source: string, patches: readonly YamlPathPatch[]): YamlPathPatchResult {
	let text = source;
	for (const patch of patches) {
		if (patch.op === "mergeMap") {
			for (const [key, value] of Object.entries(patch.value)) {
				const pathKey = [...patch.path, key];
				text =
					tryMinimalSet(text, pathKey, value) ??
					applyPatchWithSerialization(text, { op: "set", path: pathKey, value });
			}
			continue;
		}
		text =
			patch.op === "set"
				? (tryMinimalSet(text, patch.path, patch.value) ?? applyPatchWithSerialization(text, patch))
				: (tryMinimalDelete(text, patch.path) ?? applyPatchWithSerialization(text, patch));
	}
	return { changed: text !== source, text };
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	let mode = 0o600;
	try {
		mode = (await fs.stat(filePath)).mode & 0o777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(tempPath, "wx", mode);
		await handle.writeFile(text, "utf8");
		await handle.chmod(mode);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await handle?.close();
		try {
			await fs.unlink(tempPath);
		} catch {
			// ignore cleanup failure
		}
		throw error;
	}
}

/**
 * Read a YAML file (or empty document), apply path patches, and atomically
 * replace the file when content changes. Callers should wrap this in
 * {@link withFileLock} for multi-process safety.
 */
export async function patchYamlFile(
	filePath: string,
	patches: readonly YamlPathPatch[],
	options?: { createIfMissing?: boolean; validateSource?: (source: string) => void },
): Promise<YamlPathPatchResult> {
	let source = "";
	try {
		source = await Bun.file(filePath).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		if (!options?.createIfMissing) throw error;
		source = "";
	}
	options?.validateSource?.(source);
	const result = applyYamlPathPatches(source, patches);
	if (result.changed) {
		await atomicWriteText(filePath, result.text);
	}
	return result;
}
