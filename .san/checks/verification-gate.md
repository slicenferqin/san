---
name: san-verification-gate
description: San 仓库任务完成前必须执行的验证门槛。
scope:
  paths: ["packages/**", "scripts/**", "crates/**", ".san/**", "package.json", "bun.lock"]
severity: blocker
appliesTo: ["supervisor"]
---

- 涉及代码、配置 schema、构建脚本或包元数据时，至少运行 `bun check`。
- 涉及 `packages/coding-agent/` 的行为变更时，优先补充或运行对应 focused tests。
- 纯文档改动至少运行 `git diff --check`；如果文档引用命令或路径，必须核对当前仓库实际存在。
- 验证失败不能标记通过；必须返回具体失败命令、关键错误和下一步修复建议。
