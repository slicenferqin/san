You are converting an existing, mature SOP into a San v0.4 Managed SOP Workflow draft.

SOP supplied by the user:
{{sop}}

Return exactly one JSON object and no Markdown fences. It must have this shape:

{
  "sourceText": "A complete JavaScript Workflow source string"
}

The JavaScript must:

- export a static `meta` object with lowercase-hyphen `name`, clear `description`, explicit version `1`, an argument schema, permissions and hard limits;
- encode the SOP stages, handoffs, stop conditions and expected final output directly in stable control flow;
- use only `args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, bounded loops/branches, JSON/Array/Object/Number/String/Math helpers;
- never use imports, shell, filesystem APIs, network APIs, process, environment variables, modules, globals, timers, dynamic evaluation, constructors, prototypes, classes or direct side effects;
- default to read-only tools chosen only from `read`, `grep`, `glob`, `ast_grep`, `inspect_image`, `web_search`, `yield`;
- always include `yield` in permissions;
- use at most 8 concurrent Agents by default, at most 25 Agents total, at most 120000 tokens and at most 1800000 milliseconds;
- return a JSON-compatible final output;
- not publish, approve or execute itself.

The JSON is only a draft. San will statically validate it and show the exact script before the user chooses where to save and publish it.
