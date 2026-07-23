<system-interrupt reason="tool_progress_saturated">
The current tool sequence is repeating without new evidence.

Observed pattern:
- tools: {{tools}}
- reason: {{reason}}
- repeated action/result count: {{actionRepeatCount}}
- no-evidence count after redirect: {{noEvidenceCount}}
- unique resources observed: {{uniqueResourceCount}}
- successful mutation evidence: {{mutationCount}}
- changed verification outcomes: {{verificationCount}}

Stop repeating equivalent reads, searches, or commands. Reassess the active user request using evidence already present. Continue only with an action that can produce a genuinely new resource, result, mutation, or verification outcome; otherwise answer with the current conclusion and identify any concrete missing evidence.
</system-interrupt>
