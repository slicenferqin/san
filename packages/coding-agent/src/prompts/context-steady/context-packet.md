<san_context_packet>
This is San's context packet for the current turn. Use it as concise continuity from earlier settled turns. The user's current prompt remains authoritative.

{{#if checkpoint}}
Stable checkpoint:
  userIntents:{{#if checkpoint.userIntents.length}}{{#each checkpoint.userIntents}} {{this}};{{/each}}{{else}} none{{/if}}
  decisions:{{#if checkpoint.decisions.length}}{{#each checkpoint.decisions}} {{this}};{{/each}}{{else}} none{{/if}}
  filesTouched:{{#if checkpoint.filesTouched.length}}{{#each checkpoint.filesTouched}} {{path}} ({{action}});{{/each}}{{else}} none{{/if}}
  risks:{{#if checkpoint.risks.length}}{{#each checkpoint.risks}} {{this}};{{/each}}{{else}} none{{/if}}
  nextSteps:{{#if checkpoint.nextSteps.length}}{{#each checkpoint.nextSteps}} {{this}};{{/each}}{{else}} none{{/if}}

{{/if}}
{{#if digests.length}}
Recent turn digests (each is a summary of a settled span; pass its ref to the `context_expand` tool to re-read the original messages when the summary is not enough):
{{#each digests}}
- Turn {{index}} [ref: {{ref}}]:
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

{{#if recall}}
Retrieved context:
  query: {{recall.query}}
{{#if recall.items.length}}
{{#each recall.items}}
- {{content}}{{#if source}} [{{source}}]{{/if}}{{#if timestamp}} ({{timestamp}}){{/if}}{{#if score}} score={{score}}{{/if}}
{{/each}}
{{else}}
none
{{/if}}
Treat retrieved context as read-only background memory. The current user prompt and repository state take precedence.
{{/if}}
</san_context_packet>
