import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";
import { Marked } from "marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

const COOLDOWN_MS = 1_785_830_400_000;
const MALICIOUS_LOGICAL = "logical\n<script>alert(1)</script>\tother";

interface RouteChangeFixture {
	id: string;
	parentId: string;
	logicalModel: string;
	fromRoute: string;
	toRoute: string;
	reason: string;
	cooldownUntil?: number;
}

function routeChangeEntry(route: RouteChangeFixture, timestamp: string) {
	return {
		type: "model_route_change",
		id: route.id,
		parentId: route.parentId,
		timestamp,
		logicalModel: route.logicalModel,
		fromRoute: route.fromRoute,
		toRoute: route.toRoute,
		reason: route.reason,
		...(route.cooldownUntil !== undefined && { cooldownUntil: route.cooldownUntil }),
	};
}

function makeSession() {
	// Path u1 -> r1 -> r2 -> r3 -> m1 lands all four audits + the model change
	// in the transcript; the current leaf (m1) is a non-route entry so filter
	// and search assertions stay independent of the "current leaf always shown" rule.
	return {
		header: {
			type: "session",
			version: 3,
			id: "route-change-export",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		leafId: "m1",
		entries: [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: "hello", timestamp: 0 },
			},
			routeChangeEntry(
				{
					id: "r1",
					parentId: "u1",
					logicalModel: "logical-main",
					fromRoute: "route-a",
					toRoute: "route-b",
					reason: "rate_limit",
					cooldownUntil: COOLDOWN_MS,
				},
				"2026-08-01T00:01:00.000Z",
			),
			routeChangeEntry(
				{
					id: "r2",
					parentId: "r1",
					logicalModel: "logical-other",
					fromRoute: "route-c",
					toRoute: "route-d",
					reason: "quota",
				},
				"2026-08-01T00:02:00.000Z",
			),
			routeChangeEntry(
				{
					id: "r3",
					parentId: "r2",
					logicalModel: MALICIOUS_LOGICAL,
					fromRoute: "from\nroute",
					toRoute: "to\ttabbed",
					reason: "recovery",
				},
				"2026-08-01T00:03:00.000Z",
			),
			{
				type: "model_change",
				id: "m1",
				parentId: "r3",
				timestamp: "2026-08-01T00:04:00.000Z",
				model: "routes/some-model",
			},
		],
	};
}

function loadSession() {
	const { document, window } = parseHTML(templateHtml);
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(makeSession())).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);
	const treeRouteChangeNodes = () => [...document.querySelectorAll("#tree-container .tree-route-change")];
	const searchTree = (query: string) => {
		const input = document.getElementById("tree-search");
		if (!input) throw new Error("tree search input missing");
		Object.assign(input, { value: query });
		input.dispatchEvent(new window.Event("input"));
		return treeRouteChangeNodes();
	};
	const setFilter = (mode: string): void => {
		const button = [...document.querySelectorAll(".filter-btn")].find(
			candidate => candidate.getAttribute("data-filter") === mode,
		);
		if (!button) throw new Error(`filter button ${mode} missing`);
		(button as typeof button & { click(): void }).click();
	};
	return { document, searchTree, setFilter, treeRouteChangeNodes };
}

describe("HTML export model_route_change audit (LMR-03)", () => {
	test("transcript renders one route-change block per audit with timestamp, id and all fields", () => {
		const { document } = loadSession();
		const blocks = document.querySelectorAll("#messages .model-route-change");
		expect(blocks.length).toBe(3);

		const r1 = document.getElementById("entry-r1");
		expect(r1).not.toBeNull();
		expect(r1?.querySelector(".message-timestamp")).not.toBeNull();
		expect(r1?.textContent).toContain("Route change:");
		expect(r1?.textContent).toContain("logical-main");
		expect(r1?.textContent).toContain("route-a → route-b");
		expect(r1?.textContent).toContain("rate_limit");
		expect(r1?.textContent).toContain(`cooldown until ${new Date(COOLDOWN_MS).toISOString()}`);

		const r2 = document.getElementById("entry-r2");
		expect(r2?.textContent).toContain("logical-other");
		expect(r2?.textContent).toContain("route-c → route-d");
		expect(r2?.textContent).toContain("quota");
		expect(r2?.textContent).not.toContain("cooldown");
		expect(document.getElementById("messages")?.textContent).not.toContain("undefined");
	});

	test("all session values are HTML-escaped; tab/newline injection is neutralized", () => {
		const { document } = loadSession();
		const r3 = document.getElementById("entry-r3");
		expect(r3).not.toBeNull();
		// textContent is the decoded raw value; the markup itself must be inert.
		expect(r3?.querySelector(".route-change-logical")?.textContent).toBe(MALICIOUS_LOGICAL);
		const messagesHtml = document.getElementById("messages")?.innerHTML ?? "";
		expect(messagesHtml).toContain("&lt;script&gt;");
		expect(messagesHtml).not.toContain("<script>alert(1)</script>");
		expect(r3?.querySelector("script")).toBeNull();
	});

	test("tree labels render each audit independently with logical/from/to/reason/cooldown", () => {
		const { document, treeRouteChangeNodes } = loadSession();
		const nodes = treeRouteChangeNodes();
		expect(nodes.length).toBe(3);
		const labels = nodes.map(node => node.textContent ?? "");
		expect(labels.some(text => text.includes("logical-main route-a → route-b · rate_limit"))).toBe(true);
		expect(labels.some(text => text.includes("logical-other route-c → route-d · quota"))).toBe(true);
		expect(labels.some(text => text.includes(`cooldown until ${new Date(COOLDOWN_MS).toISOString()}`))).toBe(true);
		// Malicious label stays single-line and escaped.
		const malicious = labels.find(text => text.includes("<script>alert(1)</script>"));
		expect(malicious).toBeDefined();
		expect(malicious).toContain("logical <script>alert(1)</script> other");
		expect(malicious).not.toContain("\n");
		expect(document.getElementById("tree-container")?.innerHTML).not.toContain("<script>alert(1)</script>");
	});

	test("tree search matches logical model, from route, to route and reason", () => {
		const { searchTree } = loadSession();
		expect(searchTree("route-a").length).toBe(1);
		expect(searchTree("logical-other").length).toBe(1);
		expect(searchTree("route-d").length).toBe(1);
		expect(searchTree("quota").length).toBe(1);
		expect(searchTree("rate_limit").length).toBe(1);
		expect(searchTree("zzz-no-match").length).toBe(0);
	});

	test("filters: default/no-tools/all show route changes, user-only hides them", () => {
		const { document, setFilter, treeRouteChangeNodes } = loadSession();
		expect(treeRouteChangeNodes().length).toBe(3);
		setFilter("no-tools");
		expect(treeRouteChangeNodes().length).toBe(3);
		setFilter("all");
		expect(treeRouteChangeNodes().length).toBe(3);
		setFilter("user-only");
		expect(treeRouteChangeNodes().length).toBe(0);
		// Other entry types are unaffected: the user row survives user-only.
		expect(document.querySelectorAll("#tree-container .tree-role-user").length).toBe(1);
	});

	test("other entries do not regress in transcript or tree", () => {
		const { document } = loadSession();
		expect(document.querySelectorAll("#messages .user-message").length).toBe(1);
		expect(document.querySelectorAll("#messages .model-change").length).toBe(1);
		expect(document.querySelectorAll("#tree-container .tree-muted").length).toBeGreaterThanOrEqual(1);
	});
});
