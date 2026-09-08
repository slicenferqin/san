Re-read bounded original session history.

The context packet lists recent turn digests, each tagged `[ref: <id>]`. Pass that digest ref to recover the raw transcript span it replaced when you need exact wording, an exact error, a concrete diff, or command output.

`context_search` returns direct source refs such as `source:<entry-id>` when you do not know which digest contains the detail. Pass those refs here to read the matching journal entry exactly.

Use it when:
- A digest or search result mentions a decision, file, or error you must act on, but omits the exact content.
- The user refers to something from an earlier part of the session that is no longer in your working context.

Results are bounded. For a large source entry, use the returned `nextOffset` as `offset` in a follow-up call; keep `maxChars` bounded. Legacy digest refs without `offset` keep their tail-preserving behavior. Everything returned is read-only history — the current user prompt remains authoritative.
