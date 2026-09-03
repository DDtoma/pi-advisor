# Findings: docs/testing.md

- status: fixed
  severity: medium
  role: contributor workflow(测试策略)
  issue: §2.2 描述的 `test/fakes.ts` 不存在——fake 实现实际内联在各测试文件里(如 test/runtime.test.ts:23 `// ── fakes ──` 段)。§2.3 描述的 `test/e2e/` 目录与 `test/e2e/README.md` 也不存在。§4 的覆盖率目标"由 e2e 背书"因此悬空。
  standard: 文档描述当前状态;"checklists that drift from scripts"是 contributor workflow 角色的明确陷阱(project-doc-landscape 角色表)。
  action: split/rewrite(原地改写两节)
  detail: §2.2 改写为"fake 内联在各测试文件"的现状(可点名 runtime.test.ts 的 fakes 段为范例);§2.3 二选一:补上 test/e2e/ 与 README,或把该节降级为"尚未建立,计划如下"并同步修正 §4 的"由 e2e 背书"措辞。注意 §5 回归规则第 2 条也引用 e2e,需一并处理。
  evidence: `ls test/` 无 fakes.ts、无 e2e/;docs/testing.md L27、L49、L51、L70、L76。
