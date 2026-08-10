Cross-session handoff: proactively summarize the CURRENT session and push the document to a target `san:*` session (another San runtime on this machine) so work continues there — this session is NOT switched or changed.

- Discover the exact target FIRST with `hub op:"list"`; address ONLY the precise `san:<12 lowercase hex>` id it returns. NEVER invent, guess, or reuse a stale id.
- The tool generates the handoff document from this session's own context; the optional `focus` only steers what the summary emphasizes. There is no body/message parameter — never hand-write a summary.
- Use ONLY when the user wants this session's work to continue in another San session (跨会话继续 / 交接). For ordinary peer coordination, use hub `send` instead.
- hub stays the transport/discovery base: this tool pushes one generated document; follow-ups continue through hub messaging.
- Delivery is fire-and-forget: the result reports the target and the delivery receipt immediately; a failed receipt marks the result as an error.
