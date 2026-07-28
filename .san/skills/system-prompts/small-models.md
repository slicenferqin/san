# Prompting Small Models (≤2B)

Tiny models (Qwen 1.5B, Gemma 1B, LFM2 1.2B) are pattern-completers, not instruction-followers. A prompt carries roughly 3–5 constraints before rules start displacing each other. Spend that budget on output shape; enforce everything else in code.

Shared prompts MUST be written for the smallest model that consumes them — big models tolerate simple prompts; tiny models die on complex ones.

## Core Rules

- **One task per prompt.** Multi-step asks derail.
- **Examples ARE the spec.** Input→output pairs teach more than any rule sentence.
- **Positive framing only.** Tiny models drop the "not" and do X anyway: `Never include quotes` → quotes appear. State what TO do; ban via post-processing.
- **≤5 constraint sentences.** Every extra rule dilutes the rest.
- **Executable vocabulary.** "sentence case" is meta-knowledge; "Capitalize only the first word" is an action.
- **Front-load.** Task, then format, then style. Middle loss is worse than in big models.
- **NEVER request CoT.** Reasoning-out-loud degrades sub-1B output.
- **AVOID contrast examples.** A labeled "Bad:" sample gets copied, not avoided. Show only correct pairs.

## Scaffold, Don't Instruct

The strongest format control never enters the prompt:

| Lever | Effect |
| --- | --- |
| Assistant prefill (`<title>`, `{"name": `) | Commits the model into the format; kills preamble failures |
| Stop strings + token caps | Bound runaway output better than "be brief" |
| Greedy decoding / temp ≤0.3 | Removes the format lottery (LFM2: temp 0.3, min_p 0.15, rep. penalty 1.05) |
| Post-processing in code | Strips quotes/punctuation/stray tags regardless of what the model emits |

Code already neutralizes a failure mode? DELETE its rule. Each dropped rule buys headroom for the rules that matter.

## Few-Shot Shape

- 2–4 pairs, formatted exactly as the runtime input — same wrapper tags, same roles.
- The edge case (empty / refusal output) gets its own pair.
- Keep example content boring: distinctive tokens get parroted into real outputs verbatim.
- Canonical shape LAST — the model anchors on the most recent example.
