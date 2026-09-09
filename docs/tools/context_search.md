# context_search

> Find exact text in earlier session history and return stable source references.

## Source
- Entry: `packages/coding-agent/src/tools/context-search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/context-search.md`
- Key collaborators:
  - `packages/coding-agent/src/context-steady/history-search.ts` — indexes and searches original branch entries.
  - `packages/coding-agent/src/context-steady/session-runtime.ts` — owns the reusable per-session history index.
  - `packages/coding-agent/src/tools/context-expand.ts` — expands a returned `source:<entry-id>` reference.
  - `packages/coding-agent/src/session/agent-session.ts` — exposes root-session search capability.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Distinctive word, identifier, error, filename, or short phrase. |
| `limit` | number | no | Maximum returned matches. |
| `maxExcerptChars` | number | no | Maximum excerpt characters per match. |

## Output

Text output reports the match count, then each result's:

- `source:<entry-id>` reference
- role and optional tool name
- relevance score
- bounded original-message excerpt

`details` contains the normalized query, total match count, and structured hits.

## Behavior

- Read-only; it never appends search queries or results to the session.
- Searches original user, assistant, and tool-result text rather than generated digests or context notes.
- Hidden thinking and internal message metadata are excluded.
- Only available for root sessions with Context Steady enabled.
- Load mode is `discoverable`; it does not occupy the default active tool set.

## When the model should use it

- The current context lacks an exact earlier error, decision, path, or instruction.
- A continuation request depends on wording summarized out of the active context.
- The relevant digest is unknown; search first, then pass the returned ref to `context_expand`.
