---
name: supervisor-gate
description: Supervisor gate expectations for San execution-loop review.
severity: error
appliesTo: ["supervisor"]
---

- Verify implementation against the assignment and acceptance criteria.
- Inspect changed files and relevant surrounding code before passing.
- Treat missing focused validation as a defect unless the Worker explains why it is unnecessary.
- Return `needs_fix` with concrete defects when retry can repair the issue.
- Return `blocked` only for missing user input or external dependencies.

