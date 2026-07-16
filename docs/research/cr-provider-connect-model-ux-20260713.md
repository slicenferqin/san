# 标准化代码审查报告

- 仓库：`/Users/slicenfer/work/projects/self/san`
- 审查范围：`main..HEAD`
- 生成时间：`2026-07-13T13:55:46.923313+00:00`
- 审查者：`AI Reviewer`
- 审查策略：严格门禁（P0-P3）
- 门禁结论：`BLOCK`

## 1. 结论摘要

- 阻断项：`1`（P0=0，P1=1）
- 问题分布：`P0=0, P1=1, P2=4, P3=1`
- 最高风险：`Node tests (test) 执行失败`（P1）

## 2. 变更概览

- 变更文件数：`43`
- 新增/删除行：`+3271 / -219`
- 状态分布：`{'A': 8, 'M': 35}`
- 规范文件：`tsconfig.json, package.json, .github/workflows/ci.yml, .github/workflows/vouch-manage.yml, .github/workflows/vouch-pr.yml`
- 主要改动目录：`packages(42), <root>(1)`

## 3. 业务影响与牵连面

- entry_layer: `受影响`（packages/ai/test/auth-storage-api-key-login.test.ts, packages/coding-agent/src/modes/controllers/input-controller.ts, packages/coding-agent/src/modes/controllers/selector-controller.ts）
- core_flow: `无明显影响`（无）
- data_persistence: `受影响`（packages/ai/src/auth-broker/wire-schemas.ts, packages/catalog/src/model-cache.ts, packages/coding-agent/src/config/model-discovery.ts）
- downstream_dependency: `无明显影响`（无）
- monitoring_alerting: `受影响`（packages/ai/CHANGELOG.md, packages/ai/test/auth-storage-api-key-login.test.ts, packages/catalog/CHANGELOG.md）
- 风险提示：入口层与数据层同时改动，重点验证鉴权、事务与兼容性。
- 风险提示：影响链路覆盖 3 层及以上，建议执行端到端回归。
- 风险提示：检测到安全相关路径变更，建议提高审查等级并补充安全测试。

## 4. 证据与执行记录

| 层级 | 检查项 | 状态 | 耗时(s) | 命令 |
| --- | --- | --- | ---: | --- |
| static_and_type | Node lint (lint) | PASSED | 4.323 | `npm run lint` |
| static_and_type | Node type check | SKIPPED | 0.0 | `` |
| tests | Node tests (test) | FAILED | 128.007 | `npm run test` |
| build | Node build | PASSED | 38.798 | `npm run build` |
| security | Node security audit | SKIPPED | 0.0 | `` |

## 5. 问题清单（按 P0->P3）

### P1 (1)

- **[AUTO-FAIL-001] Node tests (test) 执行失败**
  - 类别：`自动化验证失败`
  - 位置：`N/A`
  - 证据：命令 `npm run test` 失败。 stderr: 
  - 影响：当前变更无法证明质量门禁通过，存在发布风险。
  - 修复建议：修复失败原因后重新运行对应检查，并更新审查结论。
  - 验证方式：重新执行 `npm run test` 并确认通过。
  - 置信度：`0.95`
  - 是否阻断：`是`
  - 状态：`未解决`

### P2 (4)

- **[AUTO-002] security 层未执行有效检查**
  - 类别：`验证覆盖不足`
  - 位置：`N/A`
  - 证据：该层检查统计: total=1 skipped=1。
  - 影响：该层风险未被验证，可能遗漏缺陷。
  - 修复建议：补齐工具链或脚本后重跑该层检查。
  - 验证方式：补齐后重新执行 security 层命令并确认结果。
  - 置信度：`0.80`
  - 是否阻断：`否`
  - 状态：`未解决`
- **[F-001] /logout 无参数被改道到 /connect，不再直接进入登出流程**
  - 类别：`UX/回归`
  - 位置：`packages/coding-agent/src/slash-commands/builtin-registry.ts:1756-1770`
  - 证据：handleTui 在 providerId 为空时调用 showConnectSelector()；仅当带 OAuth provider 参数时才走 showOAuthSelector('logout')。原先无参 /logout 会打开登出选择器。
  - 影响：用户执行 /logout 期望移除凭证，却进入连接管理界面；仍可通过 Manage → Remove stored credential 完成，但多步且语义偏移。
  - 修复建议：无参 /logout 恢复打开 logout/credential 选择器；或在 connect 首页提供明确的 'Remove credentials' 入口并更新命令描述。
  - 验证方式：TUI 执行 /logout（无参）应进入凭证移除流程；/logout anthropic 仍可指定 provider。
  - 置信度：`0.80`
  - 是否阻断：`否`
  - 状态：`未解决`
- **[F-002] 自定义 provider 写 models.yml 成功后密钥/加载失败不回滚，留下半成品配置**
  - 类别：`可靠性`
  - 位置：`packages/coding-agent/src/modes/controllers/selector-controller.ts:1127-1151`
  - 证据：writeCustomProviderConfig 成功后，upsertLoginApiKey 失败或 registry refresh 失败仅 showWarning 并 return，未 removeCustomProviderConfig 补偿。
  - 影响：models.yml 残留无密钥或无可用模型的 provider；用户下次需手动 Manage → Remove provider configuration。多会话并发下更易出现困惑状态。
  - 修复建议：在密钥持久化或首次 refresh 失败时补偿删除刚写入的 provider 配置，或把写 YAML 延后到密钥与 discovery 均成功之后。
  - 验证方式：模拟 upsertLoginApiKey 抛错后 models.yml 不应残留该 provider；refresh 失败同理。
  - 置信度：`0.80`
  - 是否阻断：`否`
  - 状态：`未解决`
- **[F-003] 全量 npm test 仍有 4 个 AuthStorage SQLite/OAuth race 超时失败**
  - 类别：`测试`
  - 位置：`packages/ai/test/auth-storage-block-persistence.test.ts:1-50`
  - 证据：npm run test: 114 chunks passed, 1 failed；失败为 auth-storage-block-persistence 与 auth-storage-oauth-refresh-race 共 4 fail，5s timeout + SQLITE_IOERR/finalized statement。本分支改动了 auth-storage.ts（upsertLoginApiKey/validateApiKey），但失败模式与历史 flaky 一致；相关 focused 测试全绿。
  - 影响：合并门禁若跑全量 test 会被噪声拦截；也可能掩盖本分支引入的真实 auth 回归。
  - 修复建议：合并前在干净环境复跑这两个文件并与 main 基线对比；若仍 flaky，单独 issue 隔离，勿与本 PR 混修 unless 可证明由本改动引起。
  - 验证方式：单独 bun test packages/ai/test/auth-storage-*.test.ts；对比 main 同文件结果。
  - 置信度：`0.80`
  - 是否阻断：`否`
  - 状态：`未解决`

### P3 (1)

- **[F-004] tips.txt 仍提示 Alt+P 用于 switch provider**
  - 类别：`文档一致性`
  - 位置：`packages/coding-agent/src/modes/components/tips.txt:15`
  - 证据：文案：'Press alt+p (or /switch) to switch provider'；本分支 Alt+P/Alt+M//switch 均改为 session model picker，provider 连接已迁到 /connect。
  - 影响：新手提示误导，增加对 breaking UX 的困惑。
  - 修复建议：改为 session model /connect 相关文案。
  - 验证方式：搜索 tips/hotkeys 中 model/provider 相关提示与实现一致。
  - 置信度：`0.80`
  - 是否阻断：`否`
  - 状态：`未解决`

## 6. 修复优先级与回归建议

1. [P1] Node tests (test) 执行失败 -> 修复失败原因后重新运行对应检查，并更新审查结论。
2. [P2] security 层未执行有效检查 -> 补齐工具链或脚本后重跑该层检查。
3. [P2] /logout 无参数被改道到 /connect，不再直接进入登出流程 -> 无参 /logout 恢复打开 logout/credential 选择器；或在 connect 首页提供明确的 'Remove credentials' 入口并更新命令描述。
4. [P2] 自定义 provider 写 models.yml 成功后密钥/加载失败不回滚，留下半成品配置 -> 在密钥持久化或首次 refresh 失败时补偿删除刚写入的 provider 配置，或把写 YAML 延后到密钥与 discovery 均成功之后。
5. [P2] 全量 npm test 仍有 4 个 AuthStorage SQLite/OAuth race 超时失败 -> 合并前在干净环境复跑这两个文件并与 main 基线对比；若仍 flaky，单独 issue 隔离，勿与本 PR 混修 unless 可证明由本改动引起。
6. [P3] tips.txt 仍提示 Alt+P 用于 switch provider -> 改为 session model /connect 相关文案。

1. 执行接口契约回归，覆盖鉴权、参数校验、错误码兼容。
2. 验证读写一致性与迁移回滚路径，执行关键数据校验。
3. 确认监控指标和告警阈值生效，并检查日志可追踪性。

## 7. 未验证风险与假设

- security 层未执行有效检查：该层风险未被验证，可能遗漏缺陷。
- 默认假设：
  - 使用用户指定 base: main

## 8. 附录：失败检查输出摘要

### Node tests (test)

- 命令：`npm run test`
- 状态：`FAILED`
- 原因：None

```text
53; 10 files) [3.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 25/53; 10 files) [5.0s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 22/53; 10 files) [6.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 23/53; 10 files) [7.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 18/53; 10 files) [13.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 28/53; 10 files) [11.4s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 29/53; 10 files) [10.6s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 21/53; 10 files) [17.1s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 33/53; 10 files) [10.7s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 30/53; 10 files) [13.5s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 27/53; 10 files) [17.4s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 32/53; 10 files) [12.2s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 26/53; 10 files) [20.6s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 31/53; 10 files) [16.1s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 36/53; 10 files) [7.1s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 38/53; 10 files) [6.5s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 34/53; 10 files) [12.6s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 39/53; 10 files) [7.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 37/53; 10 files) [8.9s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 40/53; 10 files) [8.2s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 46/53; 10 files) [1.2s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 47/53; 10 files) [1.2s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 42/53; 10 files) [7.7s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 43/53; 10 files) [7.7s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 48/53; 10 files) [3.5s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 41/53; 10 files) [10.7s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 49/53; 10 files) [3.8s]
✓ rust (cargo nextest; skipped if no Rust changes) [160ms]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 44/53; 10 files) [8.2s]
✓ scripts [828ms]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 50/53; 10 files) [5.1s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 51/53; 10 files) [4.5s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 45/53; 10 files) [7.8s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 53/53; 6 files) [3.1s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 52/53; 10 files) [6.0s]
✓ packages/coding-agent (native/tooling/browser/unit bucket; 526 files; parallel=1 chunk 35/53; 10 files) [23.4s]
✓ packages/coding-agent (singleton/global-state bucket; 62 files; parallel=1; 62 files) [126.2s]

 114 chunks passed
 1 failed
Ran 115 test command(s) in 127.8s.
```
