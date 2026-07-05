San v0.2 ROI baseline run.

Execute as a single coding agent. Do not delegate to subagents and do not use the San execution loop.

Follow the objective exactly. If the objective is read-only, do not create or modify files.

At the end, include a compact verdict block using these exact labels:

VERDICT: PASS | NEEDS_FIX | FAIL
EVIDENCE: <scope and method>
RISKS: <remaining risks or none>

Objective: {{objective}}
