import type { SessionEntry } from "../session/session-entries";
import { type ContextExpandResult, expandDigestSpan } from "./expand";
import {
	ContextHistoryIndex,
	type ContextHistorySearchOptions,
	type ContextHistorySearchResult,
} from "./history-search";
import { type ContextSteadyLocalRecallOptions, recallFromContextSearch } from "./recall";
import type { ContextRecallItem } from "./types";
import {
	type ContextWorkNoteProjection,
	type ContextWorkNoteStateRecord,
	projectActiveContextWorkNotes,
} from "./working-notes";

export class ContextSteadySessionRuntime {
	readonly #getBranch: () => readonly SessionEntry[];
	readonly #history = new ContextHistoryIndex();

	constructor(getBranch: () => readonly SessionEntry[]) {
		this.#getBranch = getBranch;
	}

	#syncHistory(): void {
		this.#history.update(this.#getBranch());
	}

	expand(ref: string, options?: { maxChars?: number; offset?: number }): ContextExpandResult | undefined {
		return expandDigestSpan(this.#getBranch(), ref, options);
	}

	search(query: string, options?: ContextHistorySearchOptions): ContextHistorySearchResult {
		this.#syncHistory();
		return this.#history.search(query, options);
	}

	recall(currentPrompt: string, options: ContextSteadyLocalRecallOptions): ContextRecallItem[] {
		this.#syncHistory();
		return recallFromContextSearch(
			(query, searchOptions) => this.#history.search(query, searchOptions),
			currentPrompt,
			options,
		);
	}

	workingNotes(
		currentPrompt?: string,
		stateRecords?: readonly ContextWorkNoteStateRecord[],
	): ContextWorkNoteProjection[] {
		return projectActiveContextWorkNotes(this.#getBranch(), { currentPrompt, stateRecords });
	}
}
