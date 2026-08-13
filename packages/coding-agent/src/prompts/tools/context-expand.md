Re-read the original messages behind a summarized turn digest.

The context packet lists recent turn digests, each tagged `[ref: <id>]`. Digests are lossy summaries — when you need exact details from an earlier settled turn (precise wording of a user request, an exact error message, the concrete diff or command output), call this tool with that ref to expand the digest back into the raw transcript span it replaced.

Use it when:
- A digest mentions a decision, file, or error you must act on, but omits the exact content.
- The user refers to something from an earlier part of the session that is no longer in your working context.

The output is bounded; very large spans are truncated from the oldest side. Everything returned is read-only history — the current user prompt remains authoritative.
