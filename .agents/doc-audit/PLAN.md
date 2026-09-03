# Doc remediation plan — pi-advisor — 2026-09-02

Source: .agents/doc-audit/REPORT.md(6 findings: 0 high, 3 medium, 1 low, 2 informational)

## Step 1: README.md 合并双布局小节

Files: README.md(modified)
Changes:

- 删除 `## 仓库布局` 整节(L123–L152 的文件树);其末尾"架构约束(见 ADR-001)"段落保留,移到 `## 项目布局` 节之后。
- `## 项目布局` 块 scripts 段补 `scripts/analyze-latency.mjs` 与 `scripts/analyze-session-latency.mjs` 两行(见 Step 6 的决定;若决定删脚本则不加)。
Acceptance: `npm run docs:check` 通过(check-docs-freshness.mjs 校验项目布局块路径全部存在);README 中只剩一个布局小节;`doc_landscape.py links .` 0 违规。

## Step 2: docs/testing.md 按真实测试结构改写

Files: docs/testing.md(modified)
Changes:

- §2.2 改写为 fake 内联现状:fake 实现内联在各测试文件(以 test/runtime.test.ts 的 `// ── fakes ──` 段为范例),删除对 test/fakes.ts 的引用。
- §2.3 降级为"尚未建立"的计划性描述,或删除;同步修正 §4 覆盖率目标中"由 e2e 背书"的措辞与 §5 回归规则第 2 条的 e2e 引用。
Acceptance: `rg -n 'fakes\.ts|test/e2e' docs/testing.md` 无对不存在路径的引用(计划性描述需明确标注"未建立")。

## Step 3: docs/implementation-plan.md 补记 Spike 结果并删除

Files: docs/implementation-plan.md(modified → deleted)、docs/api-verification.md(modified)、README.md(modified)
Changes:

- Spike 结果表按现存证据填写,不空填:0.1 由 extensions/index.ts 实际 import `../src/...` 且全部单测通过佐证;0.2 由 api-verification.md §4 本机实测记录(pi 0.84.3)与 src/pi/model-caller.ts 的实际运行佐证,表内注明证据来源与日期。
- 将填好的 Spike 结果作为一行记录并入 docs/api-verification.md(它的职责就是 pi API 本机实测),然后删除 docs/implementation-plan.md。
- 同步删除 README.md 文档地图中 implementation-plan 那一行(L120)。
Acceptance: `doc_landscape.py links .` 0 违规;`rg -n 'implementation-plan' README.md docs/` 无残留引用。

## Step 4: docs/architecture.md L178 重排与裁剪

Files: docs/architecture.md(modified)
Changes:

- L178–179 重排为一个物理行。
- 裁剪变更叙述:保留当前机制陈述(单通道 steer)与"steer 的诚实局限"警告;废弃经过与 9 分钟实测只留 `(ADR-013)` 引用。
Acceptance: `doc_landscape.py wrap .` 无 architecture.md 违规;`rg -n '原先的 followUp' docs/architecture.md` 无命中。

## Step 5: 新建根 AGENTS.md

Files: AGENTS.md(created)
Changes: 只放硬规则 + 链接,不复述内容:

- ADR-001 import 边界(src/advisor 禁止 import pi 包,链接 docs/design-decisions.md ADR-001)
- 模块头注释引用 architecture §/ADR 编号的惯例
- Markdown 一段一个物理行
- 提交前跑 `npm test`、`npx tsc --noEmit`、`npm run lint:tokens`、`npm run docs:check`
Acceptance: `doc_landscape.py inventory .` 检出 standing-order 文件;AGENTS.md 内链接经 links 检查通过。

## Step 6: analyze-*.mjs 脚本去留(需用户拍板)

Files: scripts/analyze-latency.mjs、scripts/analyze-session-latency.mjs(deleted?)或 README.md(modified)
Changes: 二选一——(a) 保留并在 Step 1 的项目布局块补两行;(b) 确认为一次性分析残留,删除两个脚本。
Acceptance: scripts/ 下文件与 README 项目布局块一致。

## Deferred

- 无(全部 informational finding 已转化为 Step 5/6 的具体动作)。

## 执行前需用户确认的决定点

1. Step 3 删除 implementation-plan.md(而非保留归档)——其持久内容已被 architecture/testing/ADR 覆盖,Spike 结果并入 api-verification.md。
2. Step 6 analyze-*.mjs 保留还是删除。
3. Step 5 新建 AGENTS.md 是否要做。
