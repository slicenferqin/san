import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@san/coding-agent/modes/components/transcript-container";
import type { Component } from "@san/tui";

class TestBlock implements Component {
	#lines: string[];
	#finalized: boolean;

	constructor(lines: string[], finalized = true) {
		this.#lines = lines;
		this.#finalized = finalized;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	finalize(lines?: string[]): void {
		if (lines) this.#lines = lines;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	render(_width: number): readonly string[] {
		return [...this.#lines];
	}
}

describe("TranscriptContainer explicit history lifecycle", () => {
	it("offers settled rows and commits them only after acknowledgement", () => {
		const container = new TranscriptContainer();
		const settled = new TestBlock(["history"]);
		const active = new TestBlock(["live"], false);
		container.addChild(settled);
		container.addChild(active);

		const offered = container.peekFinalizedBatch(80, 1);
		expect(offered?.rows).toEqual(["history", ""]);
		expect(container.renderViewport(80, 1)).toEqual(["live"]);
		expect(container.isBlockUncommitted(settled)).toBe(false);
		container.acknowledgeFinalizedBatch(offered!.id);
		expect(offered?.kind).toBe("append");
		expect(container.render(80)).toEqual(["history", "", "live"]);
		expect(container.isBlockUncommitted(settled)).toBe(false);
	});

	it("keeps an offered batch stable and rejects retraction before acknowledgement", () => {
		const container = new TranscriptContainer();
		const settled = new TestBlock(["before"]);
		const active = new TestBlock(["running"], false);
		container.addChild(settled);
		container.addChild(active);

		const first = container.peekFinalizedBatch(80, 1)!;
		settled.set(["after"]);
		const second = container.peekFinalizedBatch(80, 1)!;
		expect(second).toBe(first);
		expect(second.rows).toEqual(["before", ""]);
		container.removeChild(settled);
		expect(container.renderViewport(80, 1)).toEqual(["running"]);
	});

	it("keeps an offered batch while the live tail changes", () => {
		const container = new TranscriptContainer();
		const settled = new TestBlock(["history"]);
		const firstLive = new TestBlock(["first live"], false);
		container.addChild(settled);
		container.addChild(firstLive);

		const offered = container.peekFinalizedBatch(80, 1)!;
		const secondLive = new TestBlock(["second live"], false);
		container.addChild(secondLive);
		expect(container.peekFinalizedBatch(80, 1)).toBe(offered);
		container.removeChild(firstLive);
		expect(container.peekFinalizedBatch(80, 1)).toBe(offered);
	});

	it("moves an active block to settled when it finalizes", () => {
		const container = new TranscriptContainer();
		const block = new TestBlock(["partial"], false);
		container.addChild(block);
		expect(container.peekFinalizedBatch(80, 1)).toBeUndefined();
		block.finalize(["done"]);
		expect(container.peekFinalizedBatch(80, 0)?.rows).toEqual(["done"]);
	});

	it("renders only the uncommitted tail for the bounded viewport", () => {
		const container = new TranscriptContainer();
		const first = new TestBlock(["one"]);
		const second = new TestBlock(["two"]);
		const live = new TestBlock(["three"], false);
		container.addChild(first);
		container.addChild(second);
		container.addChild(live);
		const batch = container.peekFinalizedBatch(80, 1)!;
		expect(batch.rows).toEqual(["one", "", "two", ""]);
		expect(container.renderViewport(80, 1)).toEqual(["three"]);
		container.acknowledgeFinalizedBatch(batch.id);
		expect(container.renderViewport(80, 1)).toEqual(["three"]);
	});

	it("preserves semantic block spacing in history batches", () => {
		const container = new TranscriptContainer();
		container.addChild(new TestBlock(["a", "b"]));
		container.addChild(new TestBlock(["c"]));
		container.addChild(new TestBlock(["live"], false));
		const batch = container.peekFinalizedBatch(80, 1)!;
		expect(batch.rows).toEqual(["a", "b", "", "c", ""]);
	});

	it("flushes every settled prefix before shutdown", () => {
		const container = new TranscriptContainer();
		container.addChild(new TestBlock(["one"]));
		container.addChild(new TestBlock(["two"]));
		container.addChild(new TestBlock(["live"], false));

		container.beginFlush();
		const batch = container.peekFinalizedBatch(80, 0)!;
		expect(batch.kind).toBe("append");
		expect(batch.rows).toEqual(["one", "", "two", ""]);
		container.acknowledgeFinalizedBatch(batch.id);
		expect(container.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(container.renderViewport(80, 1)).toEqual(["live"]);
	});

	it("replays committed entries after an explicit destructive reset", () => {
		const container = new TranscriptContainer();
		const settled = new TestBlock(["history"]);
		const active = new TestBlock(["live"], false);
		container.addChild(settled);
		container.addChild(active);
		const batch = container.peekFinalizedBatch(80, 1)!;
		container.acknowledgeFinalizedBatch(batch.id);

		container.resetRetirement();
		container.beginReplay();
		const replay = container.peekFinalizedBatch(80, 1)!;
		expect(replay.kind).toBe("replay");
		expect(replay.rows).toEqual(["history", ""]);
		expect(container.renderViewport(80, 1)).toEqual(["live"]);
	});
	it("replays an offered append batch completely after a destructive reset", () => {
		const container = new TranscriptContainer();
		container.addChild(new TestBlock(["first"]));
		container.addChild(new TestBlock(["second"]));
		container.addChild(new TestBlock(["live"], false));

		const offered = container.peekFinalizedBatch(80, 0)!;
		container.resetRetirement();
		container.beginReplay();
		const replay = container.peekFinalizedBatch(80, 0)!;
		expect(replay.kind).toBe("replay");
		expect(replay.rows).toEqual(["first", "", "second", ""]);
		container.acknowledgeFinalizedBatch(replay.id);
		expect(container.peekFinalizedBatch(80, 0)).toBeUndefined();
		// The stale append offer must never be acknowledged after reset.
		expect(replay.id).not.toBe(offered.id);
	});
});
