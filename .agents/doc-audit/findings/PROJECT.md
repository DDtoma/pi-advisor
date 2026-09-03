# Findings: PROJECT(跨文件,不归属单一文档)

- status: fixed
  severity: informational
  role: standing orders(缺失)
  issue: 仓库无任何 standing-orders 文件(AGENTS.md / CLAUDE.md)。本项目是 agent 辅助开发(pi extension,模块注释普遍引用 architecture § 与 ADR 编号),但没有文件告诉 agent/贡献者"每 session 必须遵守什么"——例如 src/advisor 禁止 import pi(ADR-001)、注释引用规范、一段一行排版。
  standard: missing-role 启发式——"agent-assisted development but no standing-orders file"(project-doc-audit Phase 2);placement decision tree 第 1 条:规则类内容 → AGENTS.md。
  action: none(建议新增,属结构性提议)
  detail: 根目录新建 AGENTS.md,只放硬规则并链接到 ADR/architecture 而非复述:ADR-001 import 边界、注释须引 architecture §/ADR 的惯例、一段一行、npm run docs:check / lint:tokens 两个 CI 闸。
  evidence: doc_landscape.py inventory — "Standing-order files: none found"。
