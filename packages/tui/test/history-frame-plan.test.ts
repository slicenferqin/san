import { describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@san/tui";
import { Image } from "@san/tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@san/tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyDeletePlacement,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
} from "@san/tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;
	resizeRows: readonly string[] | undefined;
	acknowledged: number[] = [];

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}

	renderResizeFrame(_viewport: ViewportSize): readonly string[] {
		return this.resizeRows ?? this.plan.viewport;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.plan = { viewport: this.plan.viewport };
	}
}

class StickyProvider implements TerminalFrameProvider {
	acknowledged = 0;

	renderFrame(): TerminalFramePlan {
		return { history: { id: 1, rows: ["history"] }, viewport: ["live"] };
	}

	acknowledgeHistory(): void {
		this.acknowledged++;
	}
}

class FlushProvider extends Provider {
	replayBegun = 0;
	flushBegun = 0;

	beginHistoryReplay(): void {
		this.replayBegun++;
	}

	beginHistoryFlush(): void {
		this.flushBegun++;
	}
}

const scheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	},
	scheduleRender(callback: () => void, _delayMs: number) {
		callback();
		return { cancel() {} };
	},
};

function deferredScheduler() {
	const pending: Array<() => void> = [];
	return {
		pending,
		now: () => 0,
		scheduleImmediate(callback: () => void) {
			pending.push(callback);
		},
		scheduleRender(callback: () => void, _delayMs: number) {
			pending.push(callback);
			return { cancel() {} };
		},
	};
}

class ResizeScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class ImageProvider implements TerminalFrameProvider {
	#image: Image;
	history: TerminalFramePlan["history"];
	acknowledged: number[] = [];

	constructor(image: Image) {
		this.#image = image;
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return { history: this.history, viewport: this.#image.render(viewport.columns) };
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.history = undefined;
	}
}

class WidthReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	resetCount = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = viewport.columns;
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: [`history-one@${width}`, `history-two@${width}`] },
			viewport: [`editor@${width}`],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

function placements(output: string): Array<{ imageId: number; placementId: number }> {
	const result: Array<{ imageId: number; placementId: number }> = [];
	for (const match of output.matchAll(/\x1b_Ga=p[^\x1b\\]*i=(\d+),p=(\d+)/g)) {
		result.push({ imageId: Number(match[1]), placementId: Number(match[2]) });
	}
	return result;
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

describe("terminal frame plans", () => {
	it("appends finalized history once and leaves the mutable viewport intact", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new Provider({
			history: { id: 1, rows: ["history one", "history two"] },
			viewport: ["editor", "status"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.getBufferPosition().baseY).toBe(1);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["history two", "editor", "status"]);
		tui.stop();
	});

	it("resets history ids when installing a provider after fallback rendering", () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.addChild({ render: () => ["fallback history", "fallback live"] });
		tui.requestRender(true);

		const provider = new Provider({ history: { id: 1, rows: ["provider history"] }, viewport: ["live"] });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(plainBuffer(terminal)).toEqual(["provider history", "live"]);
		tui.stop();
	});

	it("acknowledges a stale history offer at most once", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new StickyProvider();
		const renderScheduler = deferredScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		while (renderScheduler.pending.length > 0) renderScheduler.pending.shift()!();

		expect(provider.acknowledged).toBe(1);
		tui.stop();
	});

	it("bottom-splits a complete replay while keeping the live tail mutable", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({
			history: { id: 1, kind: "replay", rows: ["old one", "old two", "old three", "old four", "old five"] },
			viewport: ["live"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.getScrollBuffer().map(row => row.trimEnd())).toEqual([
			"old one",
			"old two",
			"old three",
			"old four",
			"old five",
			"live",
		]);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["old three", "old four", "old five", "live"]);
		tui.stop();
	});

	it("flushes pending history before stop without replaying a destructive latch", () => {
		const terminal = new RecordingTerminal(20, 3);
		const provider = new FlushProvider({ history: { id: 1, rows: ["history"] }, viewport: ["live"] });
		const renderScheduler = deferredScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.requestRender(true, { clearScrollback: true });
		tui.stop();

		expect(provider.replayBegun).toBe(1);
		expect(provider.flushBegun).toBe(1);
		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.writes.join("")).not.toContain("\x1b[3J");
	});

	it("rejects a non-advancing history batch during shutdown", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider: TerminalFrameProvider = {
			renderFrame: () => ({ history: { id: 1, rows: ["history"] }, viewport: ["live"] }),
			acknowledgeHistory: () => {},
			beginHistoryFlush: () => {},
		};
		const renderScheduler = deferredScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);

		expect(() => tui.stop()).toThrow("History flush did not accept a new batch");
	});

	it("repaints a viewport-only frame in place without scrolling", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ viewport: ["spinner one", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { viewport: ["spinner two", "editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["spinner two", "editor", "", ""]);
		tui.stop();
	});

	it("keeps visible history above the anchored viewport while room remains", () => {
		const terminal = new VirtualTerminal(20, 6);
		const provider = new Provider({ history: { id: 1, rows: ["block one"] }, viewport: ["editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { history: { id: 2, rows: ["block two"] }, viewport: ["editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"block one",
			"block two",
			"editor",
			"",
			"",
			"",
		]);
		tui.stop();
	});

	it("uses the resize frame and restores anchored history", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ history: { id: 1, rows: ["welcome"] }, viewport: ["editor"] });
		provider.resizeRows = ["welcome", "editor"];
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(24, 5);
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);
		tui.stop();
	});

	it("appends a current-width replay after a settled resize", () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();

		expect(plainBuffer(terminal)).toContain("history-one@20");
		terminal.resize(30, 2);
		for (let index = 0; index < 3; index++) renderScheduler.settle();

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized).toContain("history-one@20");
		expect(resized).toContain("history-one@30");
		expect(resized.slice(-2)).toEqual(["history-two@30", "editor@30"]);
		tui.stop();
	});

	it("rebuilds current-width history without retaining stale rows", () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(30, 2);
		for (let index = 0; index < 3; index++) renderScheduler.settle();

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		tui.stop();
	});

	it("preserves existing history while repainting the resized viewport", () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("preserve");
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(30, 2);
		for (let index = 0; index < 3; index++) renderScheduler.settle();

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(0);
		expect(resized).toEqual(["history-one@20", "history-two@20", "editor@30"]);
		tui.stop();
	});

	it("advances image placements after history scrolls and resets them safely", () => {
		const terminalInfo = TERMINAL as unknown as { id: string; imageProtocol: ImageProtocol | null };
		const originalTerminalId = terminalInfo.id;
		const originalImageProtocol = terminalInfo.imageProtocol;
		const originalCellDimensions: CellDimensions = { ...getCellDimensions() };
		const originalGraphics = { ...getKittyGraphics() };
		const originalTmux = Bun.env.TMUX;
		let tui: TUI | undefined;

		try {
			delete Bun.env.TMUX;
			terminalInfo.id = "frame-plan-test";
			terminalInfo.imageProtocol = ImageProtocol.Kitty;
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			setKittyGraphics({ unicodePlaceholders: false });

			const terminal = new RecordingTerminal(20, 4);
			tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			const image = new Image(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "frame-plan-image" },
				{ widthPx: 40, heightPx: 40 },
			);
			const provider = new ImageProvider(image);
			tui.setFrameProvider(provider);

			const initial = placements(terminal.writes.join(""));
			expect(initial).toHaveLength(1);
			const imageId = initial[0]?.imageId;
			expect(imageId).toBeDefined();
			expect(initial[0]?.placementId).toBe(1);

			provider.history = { id: 1, rows: ["committed"] };
			terminal.writes.length = 0;
			tui.requestRender(true);
			const scrolled = placements(terminal.writes.join(""));
			expect(provider.acknowledged).toEqual([1]);
			expect(scrolled.some(placement => placement.imageId === imageId && placement.placementId === 2)).toBe(true);

			terminal.writes.length = 0;
			tui.resetDisplay();
			const reset = terminal.writes.join("");
			expect(reset).toContain(encodeKittyDeletePlacement(imageId!, 1));
			expect(reset).toContain(encodeKittyDeletePlacement(imageId!, 2));
			expect(placements(reset).some(placement => placement.imageId === imageId && placement.placementId === 1)).toBe(
				true,
			);
		} finally {
			tui?.stop();
			terminalInfo.id = originalTerminalId;
			terminalInfo.imageProtocol = originalImageProtocol;
			setCellDimensions(originalCellDimensions);
			setKittyGraphics(originalGraphics);
			if (originalTmux === undefined) delete Bun.env.TMUX;
			else Bun.env.TMUX = originalTmux;
		}
	});
});
