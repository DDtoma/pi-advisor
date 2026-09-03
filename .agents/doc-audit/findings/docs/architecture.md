# Findings: docs/architecture.md

- status: fixed
  severity: low
  role: architecture map
  issue: (a) L178–179 一个自然段跨两个物理行,违反一段一行的排版约定;(b) 同一段含变更叙述"原先的 followUp 与 nit 攒批通道被废弃,原因是延迟:实测 followUp…攒批约 9 分钟",与 ADR-013 的理由(含同一份 9 分钟实测)重复。
  standard: (a) doc_landscape.py wrap — 一段一个物理行;(b) "Document current state, not change history… belongs in decision records";架构图写活机制,理由归 ADR(project-doc-landscape 编辑规则)。
  action: rewrite
  detail: 重排为一行;把 L178 裁剪为当前机制陈述(sendMessage steer 单通道 + "steer 的诚实局限"警告),废弃经过与 9 分钟实测只保留 `(ADR-013)` 引用,细节留在 ADR-013。
  evidence: doc_landscape.py wrap — `docs/architecture.md:178`;docs/design-decisions.md ADR-013 理由段含同一实测数据。
