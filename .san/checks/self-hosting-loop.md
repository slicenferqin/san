---
name: san-self-hosting-loop
description: San 仓库 self-hosting 的执行模式约束。
severity: error
appliesTo: ["commander", "worker", "supervisor", "oracle"]
---

- 这是 San 优化 San 的 dogfood 仓库；优先让 San 自己暴露上下文、执行、复验和收口问题。
- 低风险文档、配置、小修默认使用 `solo`；源码、测试、runner、context steady、san-loop 相关改动使用 `team`；发布验收、架构决策、benchmark 结论使用 `council`。
- 不把 provider key、token、个人代理配置写进仓库；项目配置只允许保存 key-free selector 和执行策略。
- 如果 San 卡住、误判、漏检或上下文丢失，不要静默绕过；必须记录失败现象、根因假设和后续修复入口。
