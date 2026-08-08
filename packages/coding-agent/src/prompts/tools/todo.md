**Tasks referenced by verbatim content string, NEVER an auto-generated ID — no "task-1"/"task-N" exists. Pass the content text in the `task` field.**
**Mutating operations require `operationRequired: true`; omit it for `view`. Missing or false confirmation is rejected without changing the list.**

On each completion the earliest still-open task (in phase order) auto-promotes to `in_progress`.
Completing tasks out of phase order can move this pointer **back** to an earlier phase — expected; completed tasks are never reverted.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`operationRequired: true`, `list: [{phase, items: string[]}]`|Initialize full list; only when empty or all tasks terminal|
|`init`|`operationRequired: true`, `items: string[]`|Flattened single-phase init; same guard|
|`reconcile`|`operationRequired: true`, `list` or `items`|Update an active plan while preserving task status|
|`start`|`operationRequired: true`, `task`|Mark in progress|
|`done`|`operationRequired: true`, `task` or `phase`|Mark completed|
|`drop`|`operationRequired: true`, `task` or `phase`|Mark abandoned|
|`rm`|`operationRequired: true`, `task` or `phase` (optional)|Remove task or phase; omit both to clear|
|`append`|`operationRequired: true`, `phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`view`|—|Read-only: echo list; omit `operationRequired`|

## Anatomy
- **Task content**: 5–10 words; what, not how. Unique identifier.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules
- Mark tasks done immediately after finishing. Complete phases in order.
- NEVER make a todo call your turn's only tool call — batch it with the real work: `init` with the first reads/edits, each `done`/`start` with the next action. Solo todo turns waste a round trip.
- Blocked? `append` a task to the active phase, or `drop`.
- Keep `task`/`phase` strings stable once introduced.
- Lost the exact task text? `view` echoes the list — NEVER guess from memory.
- `init` never replaces unfinished work. Use `reconcile`: matching task content keeps its status, new tasks are pending, and omitted unfinished/completed tasks remain until explicit `rm`/`drop`.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks
- New instructions arrive mid-task — capture before proceeding

<critical>
User hands you a multi-step plan — phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- You MUST `init` the list with EVERY item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
