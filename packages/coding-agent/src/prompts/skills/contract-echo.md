Working agreement for skill `{{skillName}}`:

{{#if objective}}
Goal: {{objective}}
{{else}}
Goal: {{skillDescription}}
{{/if}}

Done means the host has observed:
{{#each doneGates}}
- `{{id}}` [{{kind}}]: {{description}}{{#if sameAs}} (must reuse the exact same command/path as `{{sameAs}}`){{/if}}
{{/each}}

Verification is host-backed: completion claims count only when the evidence above is observed from actual command runs, not from text assertions. Reply to adjust this agreement; continuing without objection confirms it.
