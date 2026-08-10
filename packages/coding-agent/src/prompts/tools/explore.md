Explore a codebase through one provider-neutral query.

Use this first for architecture, flow, symbol, ownership, dependency, and change-impact questions. It prefers an existing CodeGraph index, then falls back to current-disk LSP, AST, and text search without installing anything.

Returned source windows are read from disk at call time. In hashline edit mode, `[path#TAG]` sections can be edited directly without another read. Treat `pending-files` and `stale-index` relationships as hints; the source windows remain current.

Repeat or narrow the query when the output budget truncates coverage. Repeated unchanged ranges return back-references instead of duplicating source.
