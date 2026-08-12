# 证据链 Skill 写作规范

本规范约束 San 的 SKILL.md 写法,尤其是携带 `evidence` frontmatter 的证据链 skill。内置的 `fix-bug`、`build-web`(`packages/coding-agent/src/extensibility/builtin-skills/`)是本规范的参考实现。

## 核心原则:证据链,不是步骤清单

专家处理模糊需求的方式不是追问用户,而是**从环境收集证据**:修 bug 先复现拿到失败输出,再定位,修完用同一条复现路径拿到通过输出。写 skill 时按这个逻辑组织正文:

- **每一环写清两件事:此环的产出物是什么、下一环拿它做什么。** 产出物必须是可检验的东西(一条命令与其输出、一段可确认的契约文本、一份说明),而不是"完成了某个动作"的声称。
- **禁止无证据依赖的仪式性步骤。** 如果删掉某一步,后续环节不缺任何输入,这一步就不该出现在 skill 里。"先阅读全部代码"、"制定详细计划"这类没有产出物衔接的步骤是仪式,不是链。
- **写明禁止事项。** 证据链的价值在于防跳环(没复现就改代码、换个命令声称修好)。把这些反模式写成显式禁令。

## 篇幅上限:150 行

单个 SKILL.md 不超过 150 行(含 frontmatter)。超出说明链太长或细节太多:

- 链太长 → 拆成多个 skill,各自覆盖一类需求。
- 细节太多 → 把细节拆进 skill 目录下的子文件(`skill://<name>/<file>` 可按需读取),正文只保留链本身。

## `evidence` frontmatter 段

`evidence` 是可选段,把正文里的证据环声明成宿主可读的结构化数据。当前(M2)唯一的消费者是 skill 注入模板:携带声明的 skill 注入时会附带一份按 phase 分组的"证据要求"清单。后续(M3)会把它编译成 execution-control 的 AcceptanceGate 硬约束,所以字段与 `AcceptanceVerifier` 类型体系对齐。

### 字段说明

| 字段 | 必填 | 取值 | 语义 |
| ------------- | ---- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id` | 是 | 链内唯一的字符串 | 证据环的标识,如 `repro`;供 `sameAs` 引用 |
| `phase` | 是 | `before-fix` \| `before-done` | 证据应当存在的阶段:动工(修改代码)前 / 报告完成前 |
| `kind` | 是 | `command` \| `browser` \| `api` \| `artifact` \| `review` \| `external` | 复用现有六种 evidence verifier kind |
| `expect` | 是 | `pass` \| `fail` | 此阶段期望的 outcome(修 bug 先要"失败"的复现,所以 `repro` 是 `fail`) |
| `sameAs` | 否 | 链内另一个 spec 的 `id` | 必须与被引用环使用同一条命令/路径,防"换个命令绿了" |
| `description` | 是 | 单行字符串 | 人类可读说明,会渲染进注入模板 |

注意:

- 只声明**证据**,不声明动作。"定位"、"修复"是动作,不进 `evidence`;"失败的复现输出"、"同路径的通过输出"是证据,进 `evidence`。
- `phase` 只有两个值。中间里程碑(如"骨架可启动")归入 `before-done`——它是"报告完成前必须存在"的证据,而不是新阶段。
- 键名支持 YAML 惯用的 kebab-case(`same-as` 会归一化为 `sameAs`)。

### 示例

```yaml
---
name: fix-bug
description: 修复缺陷。用户报告 bug、报错、行为不符合预期时使用。
evidence:
  - id: repro
    phase: before-fix
    kind: command
    expect: fail
    description: 可复现失败的最小命令及其失败输出
  - id: verify
    phase: before-done
    kind: command
    expect: pass
    sameAs: repro
    description: 同一条复现命令由失败转为通过
---
```

### 校验与失败行为

skill 加载时校验 `evidence` 段:`id` 链内唯一、`phase`/`kind`/`expect` 枚举合法、`sameAs` 引用存在且不指向自身、`description` 非空。**任何一环非法,整段丢弃**(`sameAs` 使链内声明互相依赖,残链会误导模型),按 SkillWarning 报告具体原因(带 skill 路径),skill 本体仍正常加载可用——作者的 YAML 失误不会炸掉 skill。

无 `evidence` 段的 skill 行为与该特性引入前完全一致。

## description 的写法

`description` 渲染进 system prompt 的 `<skills>` 列表,是模糊输入命中 skill 的唯一依据。写法:

- 第一句说明 skill 做什么;后面枚举**用户会怎么说**——覆盖口语化、模糊的表述("这里报错了"、"做个网站"),而不是只写术语。
- 中文用户为主时用中文并附英文关键词,提高两种语言输入的命中率。
- 不要塞入与命中无关的实现细节。
