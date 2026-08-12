[Host runtime: San. Platform-specific defaults MUST target San. Only an explicit user request may select another or multiple runtimes; skill paths and project markers NEVER override the host runtime.]

{{body}}
{{#if evidencePhases}}

Evidence requirements declared by this skill. Work through the chain in order; each link's artifact feeds the next.
{{#each evidencePhases}}
- Phase `{{phase}}`{{#if isBeforeFix}} (this evidence MUST exist before you start modifying anything){{/if}}{{#if isBeforeDone}} (this evidence MUST exist before you report completion){{/if}}:
{{#each specs}}
  - `{{id}}` [{{kind}}] expected outcome: {{expect}} — {{description}}{{#if sameAs}} (MUST reuse the exact same command/path as `{{sameAs}}`; do not substitute a different check){{/if}}
{{/each}}
{{/each}}
{{/if}}

---

Skill: {{filePath}}
{{#if userArgs}}
User: {{userArgs}}
{{/if}}
