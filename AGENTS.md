# AGENTS.md

本文件只放每 session 必须遵守的硬规则,理由与细节链接到对应文档,不复述。

## 架构边界

- `src/advisor/` 禁止 import 任何 pi / pi-ai 包,全部 pi 依赖通过 `src/pi/` 胶水层注入(理由:[ADR-001](docs/design-decisions.md))。
- turn_end 等事件 handler 必须 fire-and-forget,advisor 失败不能传染主会话([ADR-003](docs/design-decisions.md))。

## 注释与文档

- 模块头注释写契约(行为、归属、失败模式),并引用[架构文档](docs/architecture.md)的 § 节号或 [ADR](docs/design-decisions.md) 编号;不写控制流叙述和变更历史。
- Markdown 一段一个物理行,不硬换行。
- 文档只描述当前状态;变更叙述归 ADR。

## 提交前检查

```bash
npm test            # 全部单测
npx tsc --noEmit    # 类型检查
npm run lint:tokens # prompt ≤ 5000 字符预算
npm run docs:check  # README 布局块 ↔ 文件系统、api-verification 版本、ADR 编号连续
```
