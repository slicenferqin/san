# explore

> Explore code relationships and current source through CodeGraph or a local fallback.

## Source
- Entry: `packages/coding-agent/src/tools/explore.ts`
- Runtime: `packages/coding-agent/src/code-intelligence/runtime.ts`
- Providers:
  - `packages/coding-agent/src/code-intelligence/codegraph-provider.ts`
  - `packages/coding-agent/src/code-intelligence/fallback-provider.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/explore.md`
- Registration and gating: `packages/coding-agent/src/tools/index.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Question, symbol, file name, endpoint, or code flow. Whitespace-only input is rejected. |
| `path` | `string` | No | Existing project directory or file, resolved relative to the session cwd. Defaults to the workspace root. |
| `maxFiles` | `number` | No | Maximum source files to return. Defaults to `8`, floors fractional values, and caps at `20`. |

## Availability

`explore` is default-off. Set `san.codeIntelligence.enabled: true` to expose it. When enabled, the built-in remains top-level with `loadMode: "essential"`, and raw `codegraph_*` MCP tools plus their server instructions are hidden from model presentation.

## Outputs

The result contains one Markdown text block and structured `ExploreResultDetails`:

- `provider`: `codegraph`, `lsp-ast`, or `text-fallback`.
- `freshness`: `fresh`, `pending-files`, `stale-index`, or `unavailable`.
- `sourceWindows`: emitted file ranges with stable per-call evidence references.
- `relationships` and `blastRadius`: bounded, sanitized provider metadata.
- `backReferences`: unchanged ranges already emitted by an earlier call.
- `pendingFiles`: provider-reported files awaiting graph synchronization.
- `truncated`, `maxOutputChars`, and `outputChars`: hard-budget state.
- `displayContent`: width-bounded, home-shortened TUI text; model-facing output remains untruncated except for the tool's hard output budget.

In hashline edit mode, each mutable source file is emitted under `[path#TAG]` with `LINE:TEXT` rows. The runtime records the exact current file snapshot and exposed lines, so a subsequent `edit` can use the section directly without another `read`.

## Flow

1. `ExploreTool.execute()` validates the query, file limit, and path.
2. `CodeIntelligenceRuntime` tries CodeGraph first.
3. A configured CodeGraph MCP connection is reused when available.
4. Otherwise, an installed `codegraph` executable is used only when an ancestor `.codegraph/` index exists.
5. CodeGraph receives the index project root; the requested file or directory remains the source-window boundary.
6. Missing, unavailable, or empty graph results fall back to current-disk LSP workspace symbols, native AST matching, and native regex search.
7. Provider source pointers are never trusted as source bytes. The runtime resolves them inside the requested scope, rejects escaped paths, follows real paths, and re-reads each file from disk.
8. Ranges are normalized, merged, limited to `maxFiles`, and rendered under a hard character budget.
9. Unchanged ranges already emitted by this tool instance become evidence back-references instead of duplicate source.

## Freshness

- `fresh`: provider metadata and current source agree as far as the provider reports.
- `pending-files`: current source is authoritative; graph relationships and blast radius are hints until synchronization completes.
- `stale-index`: current source is authoritative; all graph metadata is advisory.
- `unavailable`: no current source evidence or relationship metadata matched.

Regardless of freshness, every emitted source line is read from disk during that call. Provider Markdown supplies only paths, ranges, and relationship hints.

## Limits

- Query length: `4,000` characters.
- File count: default `8`, maximum `20`.
- Local fallback query terms: maximum `8`, each at most `160` characters.
- Local AST/text search timeout: `20,000ms`.
- LSP workspace-symbol timeout request: `3s` before normal LSP clamping.
- CodeGraph MCP timeout: `60,000ms` for an internally started server.
- Metadata: maximum `80` unique items per section, each capped at `600` characters.
- Output budget: adaptive `12,000`, `18,000`, or `24,000` characters; `san.codeIntelligence.maxOutputChars` selects a bounded override.

When output truncates, the text ends with an explicit notice. Narrow `query` or `path`, or reduce `maxFiles`, to retrieve omitted evidence.

## Side Effects

- Reads the requested scope and matched source files.
- May start and disconnect an installed CodeGraph MCP subprocess for one call.
- May start or query configured language servers through the normal LSP runtime.
- Records eligible source snapshots and seen lines in the session snapshot store.
- Retains per-tool-instance evidence coverage for later back-references.

## Errors

- `` `query` must be non-empty `` for whitespace-only queries.
- `query exceeds the 4000-character limit` for oversized queries.
- `maxFiles must be a positive number` for non-finite or sub-one values.
- `Cannot explore path: ...` when the requested path cannot be statted.

Provider failures are non-fatal unless caused by cancellation: CodeGraph failures fall through to local search, and individual local LSP/AST/text failures do not discard successful sibling results.
