import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@san/coding-agent/modes/components/tree-selector";
import { initTheme } from "@san/coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@san/coding-agent/session/session-entries";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

const COOLDOWN_MS = 1_785_830_400_000;

interface RouteChangeOverrides {
	logicalModel?: string;
	fromRoute?: string;
	toRoute?: string;
	reason?: string;
	cooldownUntil?: number;
}

function makeRouteChangeNode(
	id: string,
	parentId: string,
	overrides: RouteChangeOverrides = {},
	label?: string,
): SessionTreeNode {
	const entry: SessionEntry = {
		type: "model_route_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		logicalModel: overrides.logicalModel ?? "logical-main",
		fromRoute: overrides.fromRoute ?? "route-a",
		toRoute: overrides.toRoute ?? "route-b",
		reason: (overrides.reason as "rate_limit" | "quota" | "timeout" | "recovery" | undefined) ?? "rate_limit",
		...(overrides.cooldownUntil !== undefined && { cooldownUntil: overrides.cooldownUntil }),
	};
	return { entry, children: [], label };
}

function makeUserNode(id: string): SessionTreeNode {
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hello", timestamp: 1 },
	};
	return { entry, children: [] };
}

function makeModelChangeNode(id: string, parentId: string): SessionTreeNode {
	const entry: SessionEntry = {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		model: "routes/some-model",
	};
	return { entry, children: [] };
}

/** Root user message + route change A (cooldown) + route change B (labeled, no cooldown) + model_change. */
function makeTree(): SessionTreeNode[] {
	const root = makeUserNode("u1");
	root.children.push(makeRouteChangeNode("r1", "u1", { cooldownUntil: COOLDOWN_MS }));
	root.children.push(
		makeRouteChangeNode(
			"r2",
			"u1",
			{ logicalModel: "logical-other", fromRoute: "route-c", toRoute: "route-d", reason: "quota" },
			"audit",
		),
	);
	root.children.push(makeModelChangeNode("m1", "u1"));
	return [root];
}

function renderWith(
	tree: SessionTreeNode[],
	filterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all",
	leafId = "u1",
): string {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
		undefined,
		filterMode,
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

function search(tree: SessionTreeNode[], query: string): string {
	const selector = new TreeSelectorComponent(
		tree,
		"u1",
		60,
		() => {},
		() => {},
	);
	for (const char of query) selector.handleInput(char);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("model_route_change audit entries in the tree selector (LMR-03)", () => {
	it("renders a non-empty single-line display with logical/from/to/reason/cooldown", () => {
		const rendered = renderWith(makeTree(), "default");
		expect(rendered).toContain(
			`[route: logical-main route-a → route-b · rate_limit · cooldown until ${new Date(COOLDOWN_MS).toISOString()}]`,
		);
		// No raw newline inside the row and no "undefined" placeholder.
		expect(rendered).not.toContain("undefined");
	});

	it("omits cooldown entirely when the entry has none", () => {
		const rendered = renderWith(makeTree(), "default");
		expect(rendered).toContain("[route: logical-other route-c → route-d · quota]");
		// Only the cooldown-bearing row mentions cooldown.
		expect(rendered.match(/cooldown until/g)).toHaveLength(1);
	});

	it("is visible in default, no-tools and all filters, hidden in user-only, labeled-only by label", () => {
		for (const mode of ["default", "no-tools", "all"] as const) {
			const rendered = renderWith(makeTree(), mode);
			expect(rendered).toContain("[route: logical-main");
		}

		const userOnly = renderWith(makeTree(), "user-only");
		expect(userOnly).not.toContain("[route:");
		expect(userOnly).toContain("user: hello");

		const labeledOnly = renderWith(makeTree(), "labeled-only");
		expect(labeledOnly).toContain("[audit]");
		expect(labeledOnly).toContain("[route: logical-other route-c → route-d · quota]");
		expect(labeledOnly).not.toContain("[route: logical-main");
	});

	it("is searchable by logical model, from route, to route and reason", () => {
		const base = makeTree();
		expect(search(base, "logical-other")).toContain("[route: logical-other route-c");
		expect(search(base, "route-a")).toContain("[route: logical-main");
		expect(search(base, "route-d")).toContain("[route: logical-other route-c");
		expect(search(base, "rate_limit")).toContain("[route: logical-main");
		expect(search(base, "quota")).toContain("[route: logical-other route-c");
		// A query matching nothing hides the audit rows (the current leaf stays).
		expect(search(base, "zzz-no-match")).not.toContain("[route:");
	});

	it("sanitizes tab/newline injection so the row stays single-line", () => {
		const tree = makeTree();
		tree[0]!.children.push(
			makeRouteChangeNode("r3", "u1", {
				logicalModel: "logical\n<script>alert(1)</script>\tmain",
				fromRoute: "from\nroute",
				toRoute: "to\ttabbed",
				reason: "recovery",
			}),
		);
		const rendered = renderWith(tree, "all");
		expect(rendered).toContain("<script>alert(1)</script>");
		expect(rendered).toContain("logical <script>alert(1)</script> main");
		expect(rendered).toContain("from route → to tabbed");
		// No embedded newlines inside the rendered row.
		expect(rendered).not.toMatch(/logical\n/);
		expect(rendered).not.toMatch(/from\nroute/);
	});

	it("does not alter other entry rendering in the default filter", () => {
		const rendered = renderWith(makeTree(), "default");
		expect(rendered).toContain("user: hello");
		expect(rendered).not.toContain("Switched to model");
	});
});
