# Findings: docs/implementation-plan.md

- status: fixed
  severity: medium
  role: 无标准角色(临时工作计划)
  issue: 实现已全部落地(src/ 全部模块、test/ 全部单测存在),但文档自带的"完成总定义"第 4 条要求"Spike 结果节已填写",而 L189–L190 两行仍是 `☐ 未验证`。文档与自身 DoD 矛盾,且作为已完成的工作计划,它不再是被取阅的对象(仅 README 文档地图 1 条入链)。
  standard: deletion question——"Delete or merge when it is never reached for… Preserve non-obvious rationale in a decision record before deleting"(project-doc-landscape);文档应反映当前状态而非停留在计划时态。
  action: split → delete(分两步)
  detail: 先补做并填写 Spike 结果(0.1 可由 extensions/index.ts 实际 import ../src 的现存代码与全部通过的测试佐证;0.2 需要一次真实 modelRegistry.complete 冒烟,不要空填 ✅)。填写后,该文的持久价值(各模块验收标准、依赖顺序)大部分已被 architecture.md、testing.md 与 ADR 覆盖,建议将 Spike 结果并入 api-verification.md 或 ADR,然后删除本文件并同步摘掉 README.md L120 文档地图的链接。删除是提议,由 project-doc-remediate 阶段执行。
  evidence: L189–L190 `☐ 未验证`;L181 完成总定义第 4 条;doc_landscape.py inventory — 1 inbound(README.md)。
