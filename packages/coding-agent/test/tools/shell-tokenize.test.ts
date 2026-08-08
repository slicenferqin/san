import { describe, expect, it } from "bun:test";
import { extractLeadingCdTarget } from "@san/coding-agent/tools/shell-tokenize";

describe("extractLeadingCdTarget", () => {
	it("extracts a bare cd target and returns the remainder", () => {
		expect(extractLeadingCdTarget("cd /some/dir && echo ok")).toEqual({
			path: "/some/dir",
			rest: "echo ok",
		});
	});

	it("resolves quoted and escaped path tokens", () => {
		expect(extractLeadingCdTarget('cd "/my dir" && ls')).toEqual({ path: "/my dir", rest: "ls" });
		expect(extractLeadingCdTarget("cd '/a b' && ls")).toEqual({ path: "/a b", rest: "ls" });
		expect(extractLeadingCdTarget("cd /a\\ b && ls")).toEqual({ path: "/a b", rest: "ls" });
	});

	it("leaves escaped newlines to the shell", () => {
		expect(extractLeadingCdTarget("cd /tmp\\\n&& echo ok")).toBeNull();
		expect(extractLeadingCdTarget('cd "/tmp\\\n" && echo ok')).toBeNull();
	});

	it("preserves ~ so resolveToCwd can expand it", () => {
		expect(extractLeadingCdTarget("cd ~/proj && make")).toEqual({ path: "~/proj", rest: "make" });
	});

	it("accepts an adjacent && separator", () => {
		expect(extractLeadingCdTarget("cd /tmp&& echo ok")).toEqual({ path: "/tmp", rest: "echo ok" });
	});

	it("rejects redirects and extra arguments after the path", () => {
		expect(extractLeadingCdTarget("cd /tmp 2>/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp >/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp extra && echo ok")).toBeNull();
	});

	it("rejects targets that require shell expansion", () => {
		expect(extractLeadingCdTarget("cd $HOME && ls")).toBeNull();
		expect(extractLeadingCdTarget('cd "$(git rev-parse --show-toplevel)" && make')).toBeNull();
		expect(extractLeadingCdTarget("cd `pwd` && ls")).toBeNull();
	});

	it("requires a top-level && separator and a target", () => {
		expect(extractLeadingCdTarget("cd /tmp; echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /foo || echo fail")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp &echo")).toBeNull();
		expect(extractLeadingCdTarget("cd  && echo")).toBeNull();
		expect(extractLeadingCdTarget("ls -la")).toBeNull();
		expect(extractLeadingCdTarget("cdx /tmp && ls")).toBeNull();
	});
});
