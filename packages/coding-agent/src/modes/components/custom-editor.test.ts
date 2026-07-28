import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CURSOR_MARKER } from "@san/tui";
import { setKittyProtocolActive } from "@san/tui/keys";
import { $ } from "bun";
import { getDefaultPasteImageKeys } from "../../config/keybindings";
import { getEditorTheme, initTheme, theme } from "../theme/theme";
import {
	CustomEditor,
	extractBracketedImagePastePaths,
	extractBracketedPastePaths,
	extractImagePathFromText,
	extractPastePathsFromText,
} from "./custom-editor";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function bracketedPaste(text: string): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function makeEditor(): { editor: CustomEditor } {
	return { editor: new CustomEditor(getEditorTheme()) };
}

async function decorateInFreshProcess(text: string, imageLinks?: readonly string[]): Promise<string> {
	const customEditorUrl = new URL("./custom-editor.ts", import.meta.url).href;
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
editor.imageLinks = ${JSON.stringify(imageLinks)};
process.stdout.write(editor.decorateText(${JSON.stringify(text)}));
`;
	const child = await $`bun -e ${script}`.quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0) throw new Error(stderr || stdout || `decorate subprocess exited with ${child.exitCode}`);
	return stdout;
}

describe("CustomEditor placeholder decoration", () => {
	it("renders paste placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Paste #1, +30 lines]");
		expect(output).toBe("[Paste #1, +30 lines]");
	});

	it("renders linked image placeholders before theme and settings initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]", ["/tmp/example.png"]);
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor queue shorthand decoration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reserves the first line as soon as either queue prefix is completed", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.handleInput(prefix[0] ?? "");
			expect(editor.getText()).toBe(prefix[0]);

			editor.handleInput(prefix[1] ?? "");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("\x7f");
			expect(editor.getText()).toBe(`${prefix}\n`);
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		}
	});

	it("renders the reserved line as a dim Queueing header", () => {
		for (const prefix of ["->", "=>"]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(`${prefix}\nqueue this`);

			expect(editor.decorateText(prefix)).toBe(theme.fg("dim", `Queueing ${theme.nav.selected}`));
			editor.focused = true;
			const rendered = editor.render(40).map(line => Bun.stripANSI(line.replace(CURSOR_MARKER, "")));
			expect(rendered.some(line => line.includes(`Queueing ${theme.nav.selected}`))).toBe(true);
			expect(rendered.every(line => Bun.stringWidth(line) === 40)).toBe(true);
			expect(rendered.some(line => line.includes("queue this"))).toBe(true);
		}
	});

	it("highlights dot and parenthesis markers only for detected queue lists", () => {
		for (const [input, marker] of [
			["=>\n1. first\n2. second", "1."],
			["=>\n1) first\n2) second", "1)"],
		]) {
			const editor = new CustomEditor(getEditorTheme());
			editor.setText(input);
			expect(editor.decorateText(`${marker} first`).startsWith(theme.fg("accent", marker))).toBe(true);
		}

		const unfinished = new CustomEditor(getEditorTheme());
		unfinished.setText("=>\n1. first\n2. second\n3. third\n4.");
		expect(unfinished.decorateText("1. first").startsWith(theme.fg("accent", "1."))).toBe(true);
		expect(unfinished.decorateText("4.").startsWith(theme.fg("accent", "4."))).toBe(true);

		const editor = new CustomEditor(getEditorTheme());
		editor.setText("=>\n1. first\n3. third");
		expect(editor.decorateText("1. first")).toBe("1. first");
	});
});

describe("CustomEditor bracketed path paste", () => {
	it("leaves a pasted bare .png filename on the normal text path", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("icon-photo-default.png"))).toBeUndefined();
	});

	it("extracts explicit local image paths for attachment", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/icon-photo-default.png"))).toEqual([
			"/tmp/icon-photo-default.png",
		]);
		expect(extractBracketedImagePastePaths(bracketedPaste("C:\\Users\\me\\icon-photo-default.png"))).toEqual([
			"C:\\Users\\me\\icon-photo-default.png",
		]);
	});

	it("strips `file://` URLs to the local filesystem path before loading the image", () => {
		// macOS / Ghostty / iTerm2 sometimes forward the pasteboard's
		// `public.file-url` representation when the user does Finder→Copy
		// then Cmd+V. Without decoding, `loadImageInput` would try to read a
		// literal `file:///…` path and fail.
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/Pictures/photo.png"))).toEqual([
			"/Users/me/Pictures/photo.png",
		]);
	});

	it("percent-decodes spaces inside `file://` URLs", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("file:///Users/me/My%20Pictures/photo.png"))).toEqual([
			"/Users/me/My Pictures/photo.png",
		]);
	});

	it("extracts explicit non-image paths without classifying them as image paths", () => {
		expect(extractBracketedPastePaths(bracketedPaste("/tmp/report.csv"))).toEqual(["/tmp/report.csv"]);
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/report.csv"))).toBeUndefined();
	});

	it("inserts non-image path pastes as literal text instead of attaching them", () => {
		const { editor } = makeEditor();
		let imagePathCalls = 0;
		editor.onPasteImagePath = () => {
			imagePathCalls++;
		};

		editor.handleInput(bracketedPaste("/tmp/report.csv"));

		expect(editor.getText()).toBe("/tmp/report.csv");
		expect(imagePathCalls).toBe(0);
	});
});
describe("CustomEditor configured paste image keys", () => {
	it("routes Ghostty Cmd+V kitty key events through the macOS image-paste default", () => {
		const { editor } = makeEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;
		editor.setActionKeys("app.clipboard.pasteImage", getDefaultPasteImageKeys("darwin"));
		setKittyProtocolActive(true);

		try {
			editor.handleInput("\x1b[118;9u");
		} finally {
			setKittyProtocolActive(false);
		}

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});
});

describe("extractImagePathFromText (issue #3506)", () => {
	it("returns the path when the text is a single image file path", () => {
		expect(extractImagePathFromText("/tmp/screenshot.png")).toBe("/tmp/screenshot.png");
		expect(extractImagePathFromText("/Users/me/Pictures/photo.jpeg")).toBe("/Users/me/Pictures/photo.jpeg");
		expect(extractImagePathFromText("C:\\Users\\me\\img.gif")).toBe("C:\\Users\\me\\img.gif");
	});

	it("ignores surrounding whitespace from a clipboard read", () => {
		expect(extractImagePathFromText("  /tmp/photo.webp\n")).toBe("/tmp/photo.webp");
	});

	it("returns undefined for a bare filename (no explicit directory)", () => {
		// Mirrors the bracketed-paste contract: a bare `.png` filename is
		// almost always a project-relative reference the user wants as text,
		// not a clipboard-anchored attachment.
		expect(extractImagePathFromText("icon.png")).toBeUndefined();
	});

	it("returns undefined for non-image extensions", () => {
		expect(extractImagePathFromText("/tmp/report.csv")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/notes.txt")).toBeUndefined();
	});

	it("returns undefined when the text contains anything beyond a single path", () => {
		expect(extractImagePathFromText("see /tmp/screenshot.png")).toBeUndefined();
		expect(extractImagePathFromText("/tmp/a.png /tmp/b.png")).toBeUndefined();
	});

	it("returns undefined for empty/whitespace-only input", () => {
		expect(extractImagePathFromText("")).toBeUndefined();
		expect(extractImagePathFromText("   ")).toBeUndefined();
	});

	it("decodes a `file://` URL to its filesystem path", () => {
		expect(extractImagePathFromText("file:///Users/me/Pictures/photo.png")).toBe("/Users/me/Pictures/photo.png");
	});

	it("recovers a single anchored image path containing unescaped spaces (macOS screenshot name)", () => {
		const macScreenshot = "/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png";
		expect(extractImagePathFromText(macScreenshot)).toBe(macScreenshot);
		expect(extractImagePathFromText("~/Pictures/Cleanshot 2026-06-25 at 12.00.png")).toBe(
			"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
		);
		expect(extractImagePathFromText("C:\\Users\\me\\My Pictures\\img with space.jpg")).toBe(
			"C:\\Users\\me\\My Pictures\\img with space.jpg",
		);
	});

	it("does not hijack prose that happens to contain a path-shaped fragment", () => {
		// The whole-text branch is gated on ABSOLUTE_PATH_PREFIX_REGEX, so a
		// non-anchored prefix ("see ...") never triggers it.
		expect(extractImagePathFromText("see /Users/me/Desktop/Screenshot 1.png")).toBeUndefined();
	});
});

describe("extractPastePathsFromText", () => {
	it("delegates to the same logic the bracketed variant uses for path detection", () => {
		expect(extractPastePathsFromText("/tmp/a.png /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
		expect(extractPastePathsFromText("just text")).toBeUndefined();
	});
});
