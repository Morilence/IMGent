# IMGent 托管技能

IMGent skills 是由 IMGent 自己加载并注入会话的本地指令包。它与 Codex、
Claude Code 或其他 Agent 自带的技能体系相互独立：同一个 IMGent skill
可以分配给任意 `AgentProfile`，其名称、内容和 Host Tools 语义不会随 Driver
变化。

## 目录与覆盖

IMGent 在启动时读取两层目录：

```text
<imgent>/skills/          随版本发布的内置 skills
<dataDir>/skills/         本机部署者维护的 skills
```

每个 skill 使用 `skill-name/SKILL.md`。用户层存在同名 skill 时，整个用户包
覆盖内置包，不合并文件。两层都只在启动时读取；注册表会把正文和全部资源读入
不可变快照。运行中修改文件不会影响现有进程，必须重启 IMGent。

内置 skills：

- `imgent-conversation`：普通 IM turn 始终注入。
- `imgent-memory`：`memory.enabled` 时始终注入；同一技能按 Host 选择的模式
  同时指导普通会话中的记忆操作和后台 Curator 的保守策展。

定时任务没有单独的内置 skill。计划解析、持久化、到期 claim、主动投递能力检查、
幂等和 `fresh`/`series` session 隔离都由 IMGent 宿主实现；计划 turn 只接收宿主
生成的执行元数据，并继续使用当前 Profile 可见的普通 skills。未来如果开放聊天内
创建计划，必须先增加受权限约束的 schedule Host Tools，再评估是否需要指导 skill。

## 包格式

最小示例：

```text
data/skills/release-check/
├─ SKILL.md
├─ references/
│  └─ checklist.md
├─ scripts/
│  └─ verify.sh
└─ assets/
   └─ template.md
```

`SKILL.md`：

```markdown
---
name: release-check
description: Check a release candidate before publishing. Use when a user asks to prepare or verify a release.
---

# Release check

Read `references/checklist.md`, verify every applicable item, and report failures
before recommending release.
```

Frontmatter 必须且只能包含 `name` 与 `description`。名称必须与目录名一致，
使用最长 63 字符的小写 kebab-case。技能包最多 256 个普通文件、10 MiB，
其中 `SKILL.md` 最多 64 KiB。目录穿越式名称、符号链接、特殊文件、未知
frontmatter 字段和超限包都会让启动、`doctor` 或 `skills validate` 明确失败。

## Profile 分配

```json
{
  "id": "main",
  "driver": "codex",
  "skills": ["release-check", "project-conventions"],
  "memory": { "enabled": true }
}
```

`skills: ["*"]` 启用所有普通可见 skills，也是旧配置缺少 `skills` 时的默认值。
`"*"` 必须单独使用。具体名称可以给 Codex 与 Claude Code profile 使用，
IMGent 不读取、不映射也不同步厂商原生技能。

`memory.enabled: false` 会同时移除记忆 Host Tools、`imgent-memory` 指令和
catalog、自动召回与后台 Curator；它不影响其他 skills。

## 会话加载

IMGent 为每个新建或恢复的普通 turn 构造相同的 developer instructions：

1. 完整注入 `imgent-conversation`。
2. 记忆开启时完整注入 `imgent-memory`。
3. 仅列出其他可见 skill 的名称和描述。
4. 要求 Agent 在任务匹配描述或用户显式点名时先调用 `skills.load`。

Host Tools：

- `skills.list` 返回当前 profile 可见的名称与描述。
- `skills.load` 返回正文，并把启动快照中的完整包物化到该 turn 的临时只读
  目录，返回 `resourceRoot`。

turn 结束后临时目录被删除。IMGent 不执行 `scripts/` 中的文件；Agent 如需
执行脚本，必须使用自己的 Shell/工具，继续受 `AgentProfile` 权限上限、
Agent 沙箱和聊天审批约束。加载本机部署者指令不等于批准脚本、网络或文件
写入，也不能覆盖宿主的敏感数据校验和 Host Tool 白名单。

## 本机管理

```bash
imgent skills list
imgent skills validate
imgent skills init release-check \
  --description "Check a release before publishing"
```

`init` 只在 `<dataDir>/skills/` 创建模板。聊天用户没有创建、修改或删除
skills 的 Host Tool；只有能访问本机配置和数据目录的部署者可以管理它们。

修改后先运行 `imgent skills validate`，再重启 IMGent。若用户层覆盖
`imgent-conversation` 或 `imgent-memory`，覆盖内容也仍受相同 Host Tool
白名单、scope、敏感数据规则与权限上限约束。覆盖 `imgent-memory` 会同时
影响交互记忆和后台策展的语义指令，但不会扩大任一 turn 的工具权限。
`imgent backup` 会连同文件执行位一起备份用户层 skills，恢复时仍执行安全
路径与权限校验；内置层由 IMGent 版本本身提供。
