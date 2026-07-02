<san_execution_loop_context role="{{role}}">
Run:
- id: {{run.runId}}
- status: {{run.status}}
- mode: {{run.mode}}
- objective: {{run.objective}}
- retries: {{run.retryCount}}/{{run.maxRetries}}

{{#if run.plan}}
Plan:
{{#each run.plan.acceptanceCriteria}}
- acceptance: {{this}}
{{/each}}
{{#each run.plan.riskRegister}}
- risk: {{this}}
{{/each}}
{{#each run.plan.taskGraph}}
- task {{id}} [{{status}}]: {{title}}
{{/each}}
{{else}}
Plan: not recorded yet
{{/if}}

{{#if assignment}}
Assignment:
- id: {{assignment.assignmentId}}
- status: {{assignment.status}}
- objective: {{assignment.objective}}
- instructions: {{assignment.instructions}}
{{#each assignment.acceptanceCriteria}}
- acceptance: {{this}}
{{/each}}
{{#each assignment.checkRefs}}
- check: {{this}}
{{/each}}
{{/if}}

{{#if latestReview}}
Latest review:
- report: {{latestReview.reportId}}
- verdict: {{latestReview.verdict}}
- reviewer: {{latestReview.reviewer}}
- retryable: {{latestReview.retryable}}
- confidence: {{latestReview.confidence}}
{{#each latestReview.defects}}
- defect {{defectId}} [{{severity}}]: {{title}}
{{#if suggestedFix}}  fix: {{suggestedFix}}{{/if}}
{{/each}}
{{#each latestReview.requiredNextActions}}
- required next action: {{this}}
{{/each}}
{{/if}}

Recent decisions:
{{#each decisions}}
- {{decision}} — {{rationale}}
{{else}}
- none
{{/each}}

Recent events:
{{#each events}}
- {{type}}: {{summary}}
{{else}}
- none
{{/each}}

Source ContextPacket refs:
{{#each sourceContextPacketRefs}}
- {{this}}
{{else}}
- none
{{/each}}
</san_execution_loop_context>
