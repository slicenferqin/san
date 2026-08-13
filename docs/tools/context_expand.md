# context_expand

> Re-read the original journal messages behind a summarized turn digest — the agent-facing recall channel for context steady state.

## Source
- Entry: `packages/coding-agent/src/tools/context-expand.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/context-expand.md`
- Key collaborators:
  - `packages/coding-agent/src/context-steady/expand.ts` — pure span-extraction and rendering logic (`expandDigestSpan`).
  - `packages/coding-agent/src/context-steady/packet.ts` — renders the `[ref: <entryId>]` tag on every digest in the context packet.
  - `packages/coding-agent/src/session/agent-session.ts` — provides the narrow `expandContextDigest` session capability (root sessions with `san.contextSteady.enabled` only).
  - `packages/coding-agent/src/tools/index.ts` — registers the tool; `ContextExpandTool.createIf` returns `null` when the session lacks the capability.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | `string` | Yes | Digest ref from the context packet — the id inside `[ref: …]`. |

## Outputs
Text result:

- Header line: `Expanded digest <ref> (<n> messages, span <fromEntryId> … <toEntryId>[, truncated]):`
- Body: plain-text transcript of the original span. Each message is rendered as `── <role> ──` followed by its text; tool calls appear as `[tool call: <name> <args…>]` with arguments clamped.
- Oversized spans are truncated from the oldest side (default cap 30,000 chars) with an explicit truncation marker; the tail is kept because it sits closer to current work.

`details`:

- `ref: string`
- `fromEntryId` / `toEntryId: string` — the expanded journal span.
- `messageCount: number`
- `truncated: boolean`

## Behavior

- Read-only. The journal is append-only; digests are lossy summaries whose source spans stay recoverable — this tool opens the existing system-side re-read path to the model.
- Only created on root sessions with `san.contextSteady.enabled`; child (subagent) sessions and disabled sessions never see it (`createIf` returns `null`).
- Refs that do not resolve to a turn digest with a complete source span fail with an explanatory `ToolError` (use a ref listed in the current context packet).
- Load mode is `discoverable`: it does not occupy the default active tool set.

## When the model should use it

- A digest mentions a decision, file, or error it must act on, but omits the exact content (precise wording, exact error text, concrete diff).
- The user refers to earlier session content that has since been summarized out of the working set.
