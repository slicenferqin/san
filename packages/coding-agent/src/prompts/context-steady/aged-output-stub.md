{{#if preview}}[{{#if failed}}failed{{else}}completed{{/if}} {{tool}} — partial output]
{{preview}}

[Full original output: read artifact://{{artifactId}}:1-80; continue with line ranges.]
{{else}}[earlier {{#if failed}}failed {{/if}}{{tool}} output elided to save context] The exact original text is preserved byte-for-byte: read artifact://{{artifactId}}:1-80 to start recovering it.{{#if path}} Source: {{path}}.{{/if}}
{{/if}}
