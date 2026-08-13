[Host progress watchdog — advisory, not a block]

The host observed repeated near-identical actions without new progress:

{{#each alerts}}
- {{reason}} (repeats: {{repeatCount}})
{{/each}}

Repeating the same action is unlikely to produce a different result. Recommended next step: change strategy — try a different command, file, or approach; or if you are genuinely blocked on missing information or an external dependency, say so explicitly instead of retrying. This notice is shown once per repeated action.
