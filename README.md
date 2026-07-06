# San

**中文** | [English](README.en.md)

<p align="center">
  <img src="docs/assets/readme/hero-zh.svg" alt="San v0.2 Execution Loop" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Context%20Steady-v0.1-2563EB?style=flat&colorA=0B1020" alt="Context Steady v0.1" />
  <img src="https://img.shields.io/badge/Execution%20Loop-v0.2-16A34A?style=flat&colorA=0B1020" alt="Execution Loop v0.2" />
  <img src="https://img.shields.io/badge/Bun-%3E%3D1.3.14-F472B6?style=flat&colorA=0B1020" alt="Bun >= 1.3.14" />
  <img src="https://img.shields.io/badge/source--first-active-D97706?style=flat&colorA=0B1020" alt="Source first" />
</p>

San 是一个面向长期、可恢复工程任务的 coding agent。它源自 `omp` 的成熟工具化编码基础，现在作为独立项目推进一个更具体的问题：当对话、代码修改、验证和恢复跨越很多轮之后，agent 仍然应该保有稳定、可审计、可压缩的上下文状态，并且能在高风险任务里按明确角色分工执行、复验和收口。

San 当前对外版本是 **San v0.2 Execution Loop**。v0.1 Context Steady 解决长任务上下文稳态；v0.2 在这个底座上，把“计划、执行、复验、失败收口”推进成可审计的工程执行循环。

**一句话版本**：San 默认仍可以像普通 coding agent 一样用 `solo` 低开销完成日常任务；遇到架构变更、发布验收、复杂修复和容易误判的场景时，可以切到 `team` 或 `council`，让 Commander、Worker、Supervisor、Oracle 分工，并把证据写进 ledger。

## 现在能看到什么

| 结果 | 当前证据 | 意义 |
| --- | ---: | --- |
| v0.2 执行循环已可 dogfood | `/san-loop run`、role ledger、San Checks、`solo/team/council` | San 不只是聊天代理，而是有角色、有验收、有记录的工程执行系统 |
| GSAR benchmark 给出对照结论 | `solo` 5/10，同模型多角色 8/10，异构多角色 9/10 | 多角色能提升复杂任务通过率，但不应默认套到所有日常任务 |
| v0.1 上下文稳态已验证 | 第 10 轮 `598 tokens`，对照组 `198,340 tokens` | provider-bound context 不再随 raw transcript 线性膨胀 |
| 本地配置已切到 San 命名空间 | 默认 `~/.san`、项目 `.san`、优先 `SAN_*` | 本地安装和使用不再依赖 `.omp` 目录 |

**快速验收入口**：

- **v0.2 推荐配置**：`san --config packages/coding-agent/examples/config/san-execution-loop-recommended.yml`
- **v0.2 benchmark 对照报告**：`docs/research/san-gsar-controls-run-20260706-111813.html`
- **v0.2 异构多角色报告**：`docs/research/san-gsar-qwen-opus-run-20260706-100034.html`
- **v0.2 benchmark 任务集**：`packages/coding-agent/examples/san-gsar-benchmark-tasks.json`
- **v0.1 质量报告**：`docs/research/context-steady-v0.1-quality-acceptance-report.html`
- **本地校验**：`bun check` + `HOME=/private/tmp/san-test-home bun test packages/coding-agent/test/context-steady packages/coding-agent/test/san-loop`

## 为什么需要 San

多数 coding agent 在短任务里表现不错，但随着 transcript 增长，会逐渐暴露三个问题：

- **上下文膨胀**：历史对话、工具结果和中间判断不断堆叠，provider-bound context 越来越大。
- **连续性退化**：压缩或恢复后，agent 可能丢失真正重要的决策、文件触达、风险和验收口径。
- **状态不可审计**：历史被动堆在 raw transcript 里，难以判断哪些信息仍然应该影响下一轮。

San 的思路是把“上下文连续性”当成运行时系统问题处理，而不是继续依赖一个越来越长的 prompt。

## Context Steady v0.1

San v0.1 引入一条 context steady pipeline：每个已完成的 agent turn 会沉淀成结构化状态，后续 turn 再通过有预算约束的 ContextPacket 读取这些状态。

当前 v0.1 已具备可对外说明的能力：

- **TurnDigest ledger**：每个 settled turn 可持久化为 `san.turn_digest`，记录用户意图、执行动作、关键决策、触达文件、风险、下一步、memory candidates 和 tool evidence。
- **Stable checkpoint**：较早的 digest 历史会滚动沉淀为 `san.context_checkpoint`，保留长期项目状态，避免重复发送完整 raw transcript。
- **Bounded ContextPacket**：下一轮真实用户 prompt 前可注入 `san.context_packet`，按显式 token budget 组合 stable checkpoint、recent digest tail 和可选 recall 结果。
- **Provider payload pruning**：已被 ContextPacket 覆盖的历史 raw transcript span 可在发送 provider 前被剪掉，降低 active context 线性膨胀。
- **可选 LLM digest**：默认 deterministic fallback 仍然可用；开启 `san.contextSteady.digest.llm.*` 后，可用侧路 LLM 提升摘要质量，不把主流程变成硬依赖。
- **Dogfood 验收基线**：仓库包含 deterministic verifier 和真实 10 轮 dogfood 产物，用于判断系统是否真的稳住，而不只是额外注入了一段摘要。

### v0.1 验收证据

San v0.1 的验收不是只看“有没有注入摘要”，而是看 provider-bound context 是否真的停止携带等量旧 transcript，同时后续 turn 是否仍能维持任务连续性。

当前公开报告基于两组真实 10 轮对话：

<p align="center">
  <img src="docs/assets/readme/evidence-dashboard-zh.svg" alt="San Context Steady v0.1 验收仪表盘" />
</p>

<p align="center">
  <img src="docs/assets/readme/input-curve-zh.svg" alt="San 与无稳态对照的 10 轮 input tokens 曲线" />
</p>

| 指标 | San Context Steady v0.1 | 无 San 稳态对照 |
| --- | ---: | ---: |
| 第 10 轮 input | 598 tokens | 198,340 tokens |
| 10 轮累计 input | 小窗口 + ContextPacket 承接连续性 | 1,035,270 tokens |
| 第 10 轮连续性载体 | 1,612-token ContextPacket | 继续携带大段历史上下文 |
| 长期状态 | 1 个 checkpoint 覆盖前 6 个 digest | raw transcript 继续堆叠 |
| 验收结论 | provider-bound 层具备稳态机制 | 依赖长窗口承压，不是工程稳态 |

更具体地说：San 的第 10 轮只需要 598 input tokens 加一个 1,612-token ContextPacket 承接上下文；对照组在同样 10 轮主题下，第 10 轮 input 达到 198,340 tokens。这个对比说明 v0.1 已经把“长上下文能力”转成了“可审计、可预算、可裁剪的上下文稳态机制”。

这不是为某个固定 prompt 写规则。验收关注的是通用运行时性质：旧状态是否结构化、进入模型的历史是否可裁剪、下一轮是否仍能拿到文件、决策、风险和验收口径。换句话说，San v0.1 稳住的是 agent 在长任务里的上下文供给方式。

<p align="center">
  <img src="docs/assets/readme/packet-layers-zh.svg" alt="ContextPacket 稳态层结构" />
</p>

ContextPacket 的核心不是“摘要文本更短”，而是把旧状态拆到稳定层，把新变化留在短尾层，再把可选 recall 放进低缓存层。这样后续 turn 能继续使用历史结论，但 provider-bound payload 不需要重复携带同一段 raw transcript。

证据来源：

- 质量验收报告：`docs/research/context-steady-v0.1-quality-acceptance-report.html`
- 真实 10 轮 dogfood 摘要：`docs/research/context-steady-dogfood-runs/`
- 关键测试：`packages/coding-agent/test/context-steady/agent-session-m2.test.ts`
- 稳态裁剪实现：`packages/coding-agent/src/context-steady/prune.ts`
- ContextPacket 构建：`packages/coding-agent/src/context-steady/packet.ts`

当前边界也很明确：v0.1 稳住的是 **provider-bound context**，不是物理删除 session journal。raw transcript 仍然 append-only 保留，用于审计、resume 和 debug；进入模型的上下文则由 packet、checkpoint、quality window 和 prune 共同控制。

推荐 v0.1 dogfood 配置：

```sh
san --config packages/coding-agent/examples/config/san-context-steady-recommended.yml
```

v0.1 的对外 claim 可以概括为三点：

- **稳住输入规模**：第 10 轮 provider-bound input 没有随 raw transcript 线性膨胀。
- **稳住任务连续性**：ContextPacket 保留用户目标、关键改动、证据来源、风险和下一步。
- **稳住审计链路**：raw session journal 仍保留，digest/checkpoint/packet 负责模型侧上下文预算。

## San v0.2 执行循环

San v0.2 是当前准备对外发布的主版本：它不是把所有任务都升级成多 agent，而是给 coding agent 加上一套可选择的执行档位。日常任务保持 `solo` 低开销；复杂任务打开 `team` 或 `council`，用角色分工、独立复验和 append-only ledger 降低误判风险。

### 执行档位

| 模式 | 使用场景 | 角色形态 | 产品判断 |
| --- | --- | --- | --- |
| `solo` | 日常修复、小改动、明确需求 | 单 agent 单角色 | 默认路径，速度和成本最低 |
| `team` | 中高风险改动、测试集修复、需要独立 review 的任务 | Commander + Worker + Supervisor | 推荐作为 smart 档，质量收益明确但有额外开销 |
| `council` | 架构判断、发布验收、跨模块取舍、容易误判的任务 | Commander + Worker + Supervisor + Oracle | 推荐作为 deep 档，用于少数高风险决策 |

旧的 `rush/smart/deep` 命名已经收敛为 `solo/team/council`。产品口径也随之更清楚：San v0.2 的价值不是“更多 agent 永远更好”，而是在风险足够高时提供可审计的执行循环。

### GSAR benchmark 结论

GSAR benchmark 用同一组 10 个任务对比三种运行形态，覆盖目标保持、干扰抵抗、隐藏 blocker、回归检测、错误继续执行拦截和 ROI 约束等场景。

| 运行形态 | 通过率 | 总 token | 墙钟时间 | 结论 |
| --- | ---: | ---: | ---: | --- |
| Single Agent Baseline | 5/10 | 4.84M | 32.25 min | 适合日常默认；在隐藏 blocker、回归和错误继续执行场景漏检明显 |
| Multi-role Same Model | 8/10 | 5.90M | 65.47 min | 比单 agent 多通过 3 个任务，但耗时约 2.03x，不适合作为默认常开 |
| Multi-role Heterogeneous | 9/10 | 4.48M | 57.96 min | 当前最强质量样本，适合 `team/council` 高风险档 |

这组结果给出的产品判断很直接：

- **日常使用默认 `solo`**：低风险任务不值得为多角色支付额外时间和 token。
- **`team` 是质量开关**：同模型多角色从 5/10 提升到 8/10，说明独立 Worker/Supervisor 复验能真实捕捉单 agent 漏掉的问题。
- **`council` 是深度判断开关**：异构多角色单轮达到 9/10，更适合发布前验收、架构取舍和复杂 failure analysis。
- **当前证据不支持默认全量开启多角色**：benchmark 仍是单轮样本，下一步需要 3 轮以上均值和方差；README 对外只声明“可选高风险档位有效”，不声明“所有任务都应该多角色”。
- **成本口径先看 token 和时间**：当前 benchmark provider 成本没有完整计价，因此报告使用 token、non-cache token、通过率和墙钟时间作为可复查指标。

报告入口：

- 对照 benchmark：`docs/research/san-gsar-controls-run-20260706-111813.html`
- 异构多角色 benchmark：`docs/research/san-gsar-qwen-opus-run-20260706-100034.html`
- 任务集：`packages/coding-agent/examples/san-gsar-benchmark-tasks.json`

### v0.2 已包含

- Commander / Worker / Supervisor / Oracle 角色基础设施
- append-only loop ledger entries
- San Checks 发现与渲染
- `/san-loop run`、`/san-loop stop`、`/san-loop status`
- solo / team / council 模式
- 默认使用 `~/.san` 和项目 `.san` 配置目录，优先读取 `SAN_*` 环境变量并兼容旧变量
- deterministic dogfood verifier

推荐 v0.2 dogfood 配置：

```sh
san --config packages/coding-agent/examples/config/san-execution-loop-recommended.yml
```

典型运行方式：

```sh
/san-loop run --mode solo "<objective>"
/san-loop run --mode team "<objective>"
/san-loop run --mode council "<objective>"
```

## 从源码安装

当前仓库仍以源码使用为主。

```sh
git clone git@github.com:slicenferqin/san.git
cd san
bun install
bun run setup
```

源码方式启动：

```sh
bun run dev
```

执行 `bun run setup` 后，本地 `san` 命令会链接到 Bun bin 目录：

```sh
san
```

环境要求：

- Bun `>= 1.3.14`
- macOS、Linux，或可正常运行 Bun 的 Windows 环境

## 验证

常用验证命令：

```sh
bun check
HOME=/private/tmp/san-test-home bun test packages/coding-agent/test/context-steady packages/coding-agent/test/san-loop
git diff --check
```

Context steady dogfood verifier 当前覆盖 digest 持久化、ContextPacket 注入、checkpoint 分层、token budget 约束、recall layer、provider-payload pruning、resume/replay 安全性等核心契约。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `packages/coding-agent/` | `san` CLI 主实现 |
| `packages/coding-agent/src/context-steady/` | Context steady 的 TurnDigest、checkpoint、packet、recall、relevance 和 pruning 逻辑 |
| `packages/coding-agent/src/san-loop/` | San v0.2 execution loop 的 ledger、checks、runner 和 role context |
| `packages/coding-agent/examples/config/` | 推荐 dogfood 配置 |
| `packages/coding-agent/test/context-steady/` | Context steady 合同测试 |
| `packages/coding-agent/test/san-loop/` | Execution loop 合同测试 |
| `docs/research/` | 设计文档、验收报告和 dogfood 产物 |

## 对外材料

- `docs/research/context-steady-v0.1-quality-acceptance-report.html`
- `docs/research/context-steady-v0.1-fix-plan.html`
- `docs/research/context-steady-dogfood-runs/`
- `docs/research/san-v0.2-technical-design.html`
- `docs/research/san-v0.2-validation-readiness.html`
- `docs/research/san-gsar-controls-run-20260706-111813.html`
- `docs/research/san-gsar-qwen-opus-run-20260706-100034.html`
- `packages/coding-agent/examples/san-gsar-benchmark-tasks.json`

## 来源与致谢

San 现在是独立仓库：[`slicenferqin/san`](https://github.com/slicenferqin/san)。早期代码源自 [`oh-my-pi`](https://github.com/can1357/oh-my-pi)，而 `oh-my-pi` 又源自 Mario Zechner 的 Pi 工作。San 继承了原有的工具化编码能力，包括文件工具、shell、LSP、debugger、subagents、browser、web search、collaboration 和 memory backends。

这个 README 聚焦 San 自身新增的方向和当前可验收能力。仓库内仍保留部分内部 `@oh-my-pi/*` 包名作为兼容实现细节；对外仓库、配置目录、命令和发布叙事已经切到 San。

## License

MIT. See [LICENSE](LICENSE).
