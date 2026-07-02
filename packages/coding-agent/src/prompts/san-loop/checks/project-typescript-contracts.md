---
name: project-typescript-contracts
description: TypeScript implementation contracts for San coding-agent work.
scope:
  paths: ["packages/coding-agent/**"]
severity: error
appliesTo: ["worker", "supervisor"]
---

- Do not use `any` unless explicitly justified.
- Do not use `ReturnType<>`.
- Do not use inline imports.
- Keep prompts in static `.md` files and import them with `with { type: "text" }`.
- Prefer focused contract tests for user-visible behavior.

