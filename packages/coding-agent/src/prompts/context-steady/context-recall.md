<san_context_recall>
Retrieved context for the current request (query: {{query}}):
{{#if items.length}}
{{#each items}}
- {{content}}{{#if source}} [{{source}}]{{/if}}{{#if timestamp}} ({{timestamp}}){{/if}}{{#if score}} score={{score}}{{/if}}
{{/each}}
{{else}}
none
{{/if}}
</san_context_recall>
