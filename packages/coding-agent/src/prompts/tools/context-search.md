Search the original session history when the current context does not contain the exact detail you need.

Use a distinctive word, identifier, error message, file name, or short phrase. The search is read-only and searches original user/assistant/tool messages, not lossy digests or generated context notes.

Each match includes a stable `source:<entry-id>` ref and a bounded excerpt. Call `context_expand` with that ref to recover the original entry. If the expanded result reports a `nextOffset`, call `context_expand` again with the same ref and that offset; keep each page bounded.

The current user request remains authoritative. History is evidence for recovering prior wording and facts, not a replacement for the current request.