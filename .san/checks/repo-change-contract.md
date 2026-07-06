---
name: san-repo-change-contract
description: San 仓库改动必须遵守的最小变更和现有约定。
scope:
  paths: ["packages/**", "scripts/**", "crates/**", "docs/**", "README.md", "README.en.md", ".san/**"]
severity: error
appliesTo: ["worker", "supervisor"]
---

- 开始修改前先读相关源码、测试、README 和当前目录适用的 `AGENTS.md`。
- 改动保持最小化，不做无关重排、顺手重构或 package scope 大迁移。
- 不撤销用户或其他工具留下的无关改动；发现冲突时先定位影响范围。
- 代码中继续遵守项目约定：不用 `any`、不用 `ReturnType<>`、不用 inline import，prompt 放静态 `.md` 文件。
- `packages/catalog/src/models.json` 是生成文件，不能手改；模型条目变更必须改生成源并重新生成。
