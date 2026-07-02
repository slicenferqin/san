# San

[中文](README.md) | **English**

San is a coding agent for long-running, resumable engineering work. It started as a fork of `omp`, keeps the mature tool-driven coding surface, and focuses on a narrower systems problem: after many turns of discussion, code changes, verification, and resume, the agent should still preserve stable, auditable, and compact context state.

San's first public milestone is **San Context Steady v0.1**.

## Why San

Most coding agents work well on short tasks, then degrade as the transcript grows. Three failure modes show up quickly:

- **Context growth**: prior dialogue, tool results, and intermediate reasoning keep accumulating in provider-bound context.
- **Continuity loss**: after compression or resume, the agent can lose important decisions, touched files, risks, and acceptance criteria.
- **Weak auditability**: important state remains buried in raw transcript instead of becoming explicit runtime state.

San treats continuity as a runtime-system problem, not as an ever-longer prompt.

## Context Steady v0.1

San v0.1 introduces a context steady pipeline: each completed agent turn can be distilled into structured state, and later turns can read that state through a bounded ContextPacket.

The v0.1 surface is ready to describe publicly:

- **TurnDigest ledger**: each settled turn can persist a `san.turn_digest` entry with user intent, actions taken, decisions, files touched, risks, next steps, memory candidates, and tool evidence.
- **Stable checkpoints**: older digest history rolls into `san.context_checkpoint` entries so long-lived project state remains available without replaying the full raw transcript.
- **Bounded ContextPackets**: before the next real user prompt, San can inject a `san.context_packet` assembled from stable checkpoints, recent digest tail, and optional recall results under an explicit token budget.
- **Provider payload pruning**: raw transcript spans already covered by ContextPacket evidence can be removed before provider send, reducing linear active-context growth.
- **Optional LLM digesting**: deterministic fallback digests remain available; `san.contextSteady.digest.llm.*` can enable a side LLM to improve semantic digest quality without becoming a hard dependency.
- **Dogfood acceptance baseline**: deterministic verifiers and real 10-turn dogfood artifacts are included to validate whether the system is actually steady, not merely injecting another summary.

Recommended v0.1 dogfood config:

```sh
san --config packages/coding-agent/examples/config/san-context-steady-recommended.yml
```

## San v0.2 Execution Loop

The `main` branch also includes the San v0.2 execution loop foundation. v0.2 does not replace v0.1; it builds on context steady state and moves toward a more complete engineering execution loop.

Current v0.2 capabilities include:

- Commander / Worker / Supervisor / Oracle role infrastructure
- append-only loop ledger entries
- San Checks discovery and rendering
- `/san-loop run`, `/san-loop stop`, and `/san-loop status`
- rush / smart / deep modes
- deterministic dogfood verifier

Recommended v0.2 dogfood config:

```sh
san --config packages/coding-agent/examples/config/san-execution-loop-recommended.yml
```

## Install from Source

This repository is currently source-first.

```sh
git clone git@github.com:slicenferqin/san.git
cd san
bun install
bun run setup
```

Run the CLI from source:

```sh
bun run dev
```

After `bun run setup`, the local `san` command is linked into your Bun bin directory:

```sh
san
```

Requirements:

- Bun `>= 1.3.14`
- macOS, Linux, or Windows with a working Bun environment

## Verification

Common verification commands:

```sh
bun check
HOME=/private/tmp/san-test-home bun test packages/coding-agent/test/context-steady packages/coding-agent/test/san-loop
git diff --check
```

The context steady dogfood verifier currently covers digest persistence, ContextPacket injection, checkpoint layering, token-budget bounds, recall-layer behavior, provider-payload pruning, and resume/replay safety.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `packages/coding-agent/` | Main `san` CLI implementation |
| `packages/coding-agent/src/context-steady/` | Context steady TurnDigest, checkpoint, packet, recall, relevance, and pruning logic |
| `packages/coding-agent/src/san-loop/` | San v0.2 execution-loop ledger, checks, runner, and role context |
| `packages/coding-agent/examples/config/` | Recommended dogfood config overlays |
| `packages/coding-agent/test/context-steady/` | Context steady contract tests |
| `packages/coding-agent/test/san-loop/` | Execution-loop contract tests |
| `docs/research/` | Design notes, acceptance reports, and dogfood artifacts |

## Public Materials

- `docs/research/context-steady-v0.1-quality-acceptance-report.html`
- `docs/research/context-steady-v0.1-fix-plan.html`
- `docs/research/context-steady-dogfood-runs/`
- `docs/research/san-v0.2-technical-design.html`
- `docs/research/san-v0.2-validation-readiness.html`

## Upstream Heritage

San is forked from [`oh-my-pi`](https://github.com/can1357/oh-my-pi), which itself builds on Mario Zechner's Pi work. San inherits the original tool-rich coding-agent surface: file tools, shell execution, LSP, debugger integration, subagents, browser, web search, collaboration, and memory backends.

This README focuses on San-specific work and current acceptance-ready capabilities. Some upstream documentation and package references still exist in the repository and will be cleaned up as the fork is productized.

## License

MIT. See [LICENSE](LICENSE).
