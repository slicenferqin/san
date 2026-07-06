# San coding agent

Core implementation package for the `san` coding agent. San is a fork of `omp` that keeps the original tool-rich coding-agent surface and now focuses on the San v0.2 execution loop: long-running context steady state, explicit `solo/team/council` execution modes, role-ledger evidence, San Checks, and benchmarked high-risk review paths.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/slicenferqin/san#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## San v0.2 execution loop

San v0.2 adds a selectable execution loop on top of the existing coding-agent runtime. The product stance is explicit: daily work should use `solo`; higher-risk work can switch to `team` or `council` when independent execution, review, and ledger evidence justify the extra overhead.

Execution modes:

- `solo` — single-agent daily mode for clear, low-risk tasks.
- `team` — Commander + Worker + Supervisor mode for complex implementation and review.
- `council` — Commander + Worker + Supervisor + Oracle mode for architecture, release gates, and ambiguous failure analysis.

The GSAR benchmark currently shows:

| Run shape | Pass rate | Total tokens | Wall time | Product conclusion |
| --- | ---: | ---: | ---: | --- |
| Single Agent Baseline | 5/10 | 4.84M | 32.25 min | right default for daily work |
| Multi-role Same Model | 8/10 | 5.90M | 65.47 min | useful quality switch, too expensive to keep always-on |
| Multi-role Heterogeneous | 9/10 | 4.48M | 57.96 min | strongest current high-risk review sample |

Useful v0.2 artifacts:

- `docs/research/san-gsar-controls-run-20260706-111813.html`
- `docs/research/san-gsar-qwen-opus-run-20260706-100034.html`
- `packages/coding-agent/examples/san-gsar-benchmark-tasks.json`
- `packages/coding-agent/examples/config/san-execution-loop-recommended.yml`
- `packages/coding-agent/test/san-loop/`

Recommended v0.2 dogfood config:

```sh
san --config packages/coding-agent/examples/config/san-execution-loop-recommended.yml
```

## San context steady v0.1

San v0.1 turns completed agent turns into durable state and feeds a compact, bounded ContextPacket back into later turns. It is designed for dogfooding real coding sessions where a raw transcript grows quickly, but the agent still needs stable continuity across 10+ turns.

The v0.1 surface includes:

- `san.turn_digest` entries for settled turns, capturing intent, actions, decisions, files touched, risks, next steps, memory candidates, and tool evidence.
- `san.context_checkpoint` entries that roll older digest history into stable checkpoint summaries.
- `san.context_packet` debug entries plus hidden `san.context_packet.injected` messages for layered packet injection.
- Provider-payload pruning for transcript spans already covered by ContextPacket evidence.
- Read-only recall integration that adds retrieved memory as a volatile ContextPacket layer instead of rewriting the stable system prompt.
- Optional LLM-backed TurnDigest generation controlled by `san.contextSteady.digest.llm.*`, with deterministic fallback preserved.

Recommended dogfood config:

```sh
san --config packages/coding-agent/examples/config/san-context-steady-recommended.yml
```

Useful verification artifacts:

- `docs/research/context-steady-v0.1-quality-acceptance-report.html`
- `docs/research/context-steady-v0.1-fix-plan.html`
- `docs/research/context-steady-dogfood-runs/`

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.san/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session is honoured on the next system-prompt rebuild and the next `/memory` slash command. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.
