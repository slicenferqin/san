<san_context_packet>
This is San's context packet for the current turn. Use it as concise continuity from earlier settled turns. The user's current prompt remains authoritative.

{{#if digests.length}}
Recent turn digests:
{{#each digests}}
- Turn {{index}}:
  userIntent: {{userIntent}}
  actionsTaken:{{#if actionsTaken.length}}{{#each actionsTaken}} {{this}};{{/each}}{{else}} none{{/if}}
  decisions:{{#if decisions.length}}{{#each decisions}} {{this}};{{/each}}{{else}} none{{/if}}
  filesTouched:{{#if filesTouched.length}}{{#each filesTouched}} {{path}} ({{action}});{{/each}}{{else}} none{{/if}}
  risks:{{#if risks.length}}{{#each risks}} {{this}};{{/each}}{{else}} none{{/if}}
  nextSteps:{{#if nextSteps.length}}{{#each nextSteps}} {{this}};{{/each}}{{else}} none{{/if}}
{{/each}}
{{else}}
Recent turn digests: none
{{/if}}
</san_context_packet>
