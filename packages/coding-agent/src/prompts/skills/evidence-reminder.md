[Evidence reminder — advisory, not a block]

You are modifying files, but the active skill declared evidence that should exist before changes begin and the host has not observed it yet:
{{#each reminders}}
- Skill `{{skillName}}`, evidence `{{spec.id}}` [{{spec.kind}}, expected outcome: {{spec.expect}}]: {{spec.description}}
{{/each}}

Recommended next step: collect the missing evidence first (e.g. run the minimal failing reproduction and capture its output), then continue with the change. If you already judged this unnecessary for the current situation, proceed — this reminder is shown once and will not repeat.
