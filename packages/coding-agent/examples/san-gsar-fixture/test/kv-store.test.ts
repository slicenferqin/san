import { describe, expect, test } from "bun:test";
import { createKVStore } from "../src/kv-store";

describe("KVStore", () => {
	test("set and get returns entry", () => {
		const store = createKVStore();
		const entry = store.set("foo", "bar");
		expect(store.get("foo")).toBeDefined();
		expect(entry.key).toBe("foo");
	});

	test("set increments version", () => {
		const store = createKVStore();
		store.set("a", "1");
		const second = store.set("a", "2");
		expect(second.version).toBeGreaterThan(0);
	});

	test("delete removes key", () => {
		const store = createKVStore();
		store.set("x", "y");
		expect(store.delete("x")).toBe(true);
		expect(store.get("x")).toBeUndefined();
	});

	test("list returns keys", () => {
		const store = createKVStore();
		store.set("b", "1");
		store.set("a", "2");
		expect(store.list().length).toBeGreaterThan(0);
	});

	test("cas succeeds with correct version", () => {
		const store = createKVStore();
		const first = store.set("k", "v1");
		const updated = store.cas("k", first.version, "v2");
		expect(updated).not.toBeNull();
	});

	test("cas fails with wrong version", () => {
		const store = createKVStore();
		store.set("k", "v1");
		const result = store.cas("k", 999, "v2");
		expect(result).toBeNull();
	});
});
