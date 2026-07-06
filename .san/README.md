# San Self-hosting

这个目录是 San 仓库自己的 dogfood 配置，用来让 San 优先用 San v0.2 execution loop 优化 San。

- `.san/config.yml` 是项目级运行配置，只保存模型 selector 和执行策略。
- `.san/checks/` 是项目级 San Checks，会进入 `/san-loop run` 的角色上下文。
- 不在这里保存 provider key、token 或个人环境配置。
- 不放 `.san/AGENTS.md`，避免覆盖仓库根目录的 `AGENTS.md`。

默认使用 `solo` 处理日常任务；涉及源码、测试、发布、benchmark 或跨模块判断时切到 `team` 或 `council`。

新 San 会话接手本仓库时，可以直接使用：

```text
接手当前 San 仓库，先读 AGENTS.md、README.md、docs/research/san-v0.2-self-hosting-handoff-20260706.html 和 .san/ 配置。
重点核对 .san/config.yml 的 modelRoles、contextSteady、executionLoop、checks 和 solo/team/council 语义。
不要提交，不要引入密钥、token、个人路径或代理配置；只做与当前任务相关的最小改动。
完成前至少运行 git diff --check 和 bun check；如果改了 packages/coding-agent/ 行为，再运行对应 focused tests。
```
