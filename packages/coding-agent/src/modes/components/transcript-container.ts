import type { Component, HistoryBatch } from "@san/tui";
import { Container } from "@san/tui";

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
}

type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
}

type OfferedBatch =
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay"; end: number };

const MAX_LIVE_BLOCKS = 256;
const EMPTY_ROWS: readonly string[] = [];
const NON_WHITESPACE = /\S/;

function isFinalized(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockFinalized?.() ?? true;
}

function trimPlainBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && !NON_WHITESPACE.test(rows[start]!)) start++;
	while (end > start && !NON_WHITESPACE.test(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

function appendBlock(rows: string[], block: readonly string[]): void {
	if (block.length === 0) return;
	if (rows.length > 0) rows.push("");
	rows.push(...block);
}

/**
 * Owns transcript order and the active → settled → committed lifecycle.
 * Settled blocks remain in the mutable viewport until a frame provider offers
 * them as an ordered history batch and the terminal acknowledges that batch.
 */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: OfferedBatch | undefined;
	#replayEnd = 0;
	#replayPending = false;
	#replayRequested = false;
	#flushMode = false;
	override addChild(component: Component): void {
		this.#syncEntries();
		super.addChild(component);
		this.#entries.push({ component, state: "active" });
	}

	override removeChild(component: Component): void {
		this.#syncEntries();
		const entry = this.#entry(component);
		// A settled/committed block may already have been offered to, or written
		// into, terminal history. Retraction would create an interior deletion.
		if (entry === undefined || entry.state !== "active") return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replayEnd = 0;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#flushMode = false;
	}

	/** Whether a transient block may be removed without retracting history. */
	isBlockUncommitted(component: Component): boolean {
		this.#syncEntries();
		return this.#entry(component)?.state === "active";
	}

	/** Explicit name for new callers; retained locally for session controllers. */
	canRemoveBlock(component: Component): boolean {
		return this.isBlockUncommitted(component);
	}

	/** Whether a block still belongs to the repaintable portion of the frame. */
	isBlockInLiveRegion(component: Component): boolean {
		this.#syncEntries();
		const entry = this.#entry(component);
		if (!entry || entry.state === "committed") return false;
		const index = this.#entries.indexOf(entry);
		return index >= this.#liveStart();
	}

	/** Whether active block count leaves room for another live block. */
	canAdmit(rows: number): boolean {
		this.#syncEntries();
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Reopen committed entries after an explicit destructive display reset. */
	resetRetirement(): void {
		this.#syncEntries();
		this.#replayEnd = Math.max(this.#replayEnd, this.#frontier, this.#offered?.end ?? 0);
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		for (const entry of this.#entries) {
			if (entry.state === "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}

	/** Re-offer the committed prefix as one complete history replay. */
	beginReplay(): void {
		this.#syncEntries();
		this.#replayEnd = Math.max(this.#replayEnd, this.#frontier);
		if (this.#offered !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#replayPending = this.#replayEnd > 0;
	}

	/** Make the next history offers drain every currently settled prefix. */
	beginFlush(): void {
		this.#flushMode = true;
	}

	/** Cancel an unoffered replay; an already offered batch remains acknowledgeable. */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
	}

	/** Number of rows currently required by the uncommitted transcript tail. */
	liveRowCount(width: number): number {
		this.#syncEntries();
		this.#settleFinalized();
		return this.#renderEntries(width, this.#liveStart()).length;
	}

	/** Render the mutable transcript tail within the provider's row budget. */
	renderViewport(width: number, capacity: number): readonly string[] {
		this.#syncEntries();
		this.#settleFinalized();
		const rows = Math.max(0, Math.trunc(capacity));
		if (rows === 0) return EMPTY_ROWS;
		const rendered = this.#renderEntries(width, this.#liveStart());
		return rendered.length > rows ? rendered.slice(rendered.length - rows) : rendered;
	}

	/**
	 * Offer the oldest settled prefix needed to keep the uncommitted tail within
	 * `capacity`. The returned rows and id remain stable until acknowledgement.
	 */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		if (this.#replayPending) return this.peekReplayBatch(width);
		if (this.#flushMode) return this.peekFlushBatch(width);

		const room = Math.max(0, Math.trunc(capacity));
		const start = this.#frontier;
		if (start >= this.#entries.length) return undefined;
		const liveEntries = this.#entries.slice(start);
		const blocks = liveEntries.map(entry => trimPlainBlankEdges(entry.component.render(width)));
		const total = this.#rowsForBlocks(blocks).length;
		if (total <= room && this.#liveCount() < MAX_LIVE_BLOCKS) return undefined;

		let end = start;
		let remaining = blocks;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			const next = remaining.slice(1);
			const nextRows = this.#rowsForBlocks(next).length;
			end++;
			remaining = next;
			if (nextRows <= room && this.#liveCount() - (end - start) < MAX_LIVE_BLOCKS) break;
		}
		if (end === start) return undefined;

		const prefixBlocks = blocks.slice(0, end - start);
		const rows = this.#rowsForBlocks(prefixBlocks);
		if (rows.length === 0) return undefined;
		if (remaining.some(block => block.length > 0)) rows.push("");
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
		this.#offered = { batch, kind: "commit", end };
		return batch;
	}

	/** Return the complete replay prepared by {@link beginReplay}. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		if (!this.#replayPending || this.#replayEnd <= 0) return undefined;
		const rows = this.#renderRange(0, this.#replayEnd, width, true);
		if (rows.length === 0) return undefined;
		this.#replayPending = false;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay", end: this.#replayEnd };
		return batch;
	}

	/** Return the complete currently settled prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.#offered.batch;
		let end = this.#frontier;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") end++;
		if (end === this.#frontier) return undefined;
		const rows = this.#renderRange(this.#frontier, end, width, end < this.#entries.length);
		if (rows.length === 0) return undefined;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "append" };
		this.#offered = { batch, kind: "commit", end };
		return batch;
	}

	/** Retire exactly the history batch most recently offered by this container. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "replay") {
			for (let index = 0; index < offered.end; index++) {
				const entry = this.#entries[index];
				if (entry) entry.state = "committed";
			}
			this.#frontier = offered.end;
			this.#replayEnd = 0;
			this.#replayPending = false;
		} else {
			for (let index = this.#frontier; index < offered.end; index++) {
				const entry = this.#entries[index];
				if (entry) entry.state = "committed";
			}
			this.#frontier = offered.end;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.beginReplay();
	}

	/** Full semantic render used by exports, commands, and destructive replay. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		this.#settleFinalized();
		return this.#renderEntries(width, 0);
	}

	#renderEntries(width: number, start: number): string[] {
		const rows: string[] = [];
		for (let index = Math.max(0, start); index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			appendBlock(rows, trimPlainBlankEdges(entry.component.render(Math.max(1, width))));
		}
		return rows;
	}

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): string[] {
		const rows: string[] = [];
		for (let index = Math.max(0, start); index < Math.min(end, this.#entries.length); index++) {
			const entry = this.#entries[index]!;
			appendBlock(rows, trimPlainBlankEdges(entry.component.render(Math.max(1, width))));
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return rows;
	}

	#rowsForBlocks(blocks: readonly (readonly string[])[]): string[] {
		const rows: string[] = [];
		for (const block of blocks) appendBlock(rows, block);
		return rows;
	}

	#settleFinalized(): void {
		for (const entry of this.#entries) {
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	#liveStart(): number {
		return this.#offered?.end ?? this.#frontier;
	}

	#liveCount(): number {
		return Math.max(0, this.#entries.length - this.#liveStart());
	}

	#entry(component: Component): TranscriptEntry | undefined {
		return this.#entries.find(entry => entry.component === component);
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const previousEntries = this.#entries;
		const offered = this.#offered;
		const offeredPrefixStable =
			offered !== undefined &&
			offered.end <= this.children.length &&
			offered.end <= previousEntries.length &&
			previousEntries.slice(0, offered.end).every((entry, index) => entry.component === this.children[index]);
		const existing = new Map(previousEntries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? { component, state: "active" });
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
		this.#offered = offeredPrefixStable ? offered : undefined;
		if (offered !== undefined && !offeredPrefixStable) {
			this.#replayPending = false;
			this.#replayRequested = false;
		}
	}
}

/** Groups sibling rows into one semantic transcript block. */
export class TranscriptBlock extends Container {}
