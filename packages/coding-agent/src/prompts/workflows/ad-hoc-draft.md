You are generating a San v0.4 Ad-hoc Dynamic Workflow draft for the current task.

Task requested by the user:
{{objective}}

Return exactly one JSON object and no Markdown fences. It must have this shape:

{
  "humanSummary": "Plain-language numbered steps, including stop conditions and final output",
  "sourceText": "A complete JavaScript Workflow source string",
  "args": null
}

The JavaScript must:

- export a static `meta` object with lowercase-hyphen `name`, clear `description`, version `1`, permissions and hard limits;
- use only `args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, bounded loops/branches, JSON/Array/Object/Number/String/Math helpers;
- never use imports, shell, filesystem APIs, network APIs, process, environment variables, modules, globals, timers, dynamic evaluation, constructors, prototypes, classes or direct side effects;
- default to read-only tools chosen only from `read`, `grep`, `glob`, `ast_grep`, `inspect_image`, `web_search`, `yield`;
- always include `yield` in permissions;
- use at most 8 concurrent Agents by default, at most 25 Agents total, at most 120000 tokens and at most 1800000 milliseconds;
- only schedule Agents needed for this one task;
- return JSON-compatible final output;
- not claim approval, not run itself, not save itself as Managed, and not ask the user to trust its name.

The plain-language summary must state purpose, stages, maximum Agent count, concurrency, tools, write mode, token/time budget, stop conditions and expected final result. The JSON will be parsed, statically validated and shown in full for separate human approval before any Agent can start.
