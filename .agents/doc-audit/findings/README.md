# Findings: README.md

- status: fixed
  severity: medium
  role: product entry
  issue: 存在两个内容重叠的仓库布局小节——`## 项目布局`(L80)与 `## 仓库布局`(L123),且两者不一致:仓库布局漏掉 `src/advisor/tools.ts`、`src/pi/model-caller.ts`,`scripts/` 下也只列出部分文件。只有项目布局块被 CI 闸(check-docs-freshness.mjs 检查 a)校验,仓库布局无人守门,已经漂移。
  standard: one home per fact(每个事实只有一个家);重复文档抬高每次编辑的成本(project-doc-landscape, "Coupled documents raise the cost of every edit")。
  action: split/merge
  detail: 保留被 CI 校验的 `## 项目布局` 块(补齐 scripts/analyze-*.mjs,见下条),删除 `## 仓库布局` 整节(L123–L152);该节末尾的 ADR-001 架构约束段落(L152 附近"架构约束"段)是无重复信息,可并入项目布局节后或保留原位独立成段。
  evidence: README.md L80–L101 vs L123–L152 两份文件树;仓库布局无 tools.ts/model-caller.ts,而 `ls src/advisor src/pi` 确认两文件存在。

- status: fixed
  severity: informational
  role: product entry
  issue: `scripts/analyze-latency.mjs` 与 `scripts/analyze-session-latency.mjs` 未出现在任何文档中(README 布局块只列了两个 check 脚本)。
  standard: 项目布局块应反映真实路径;check-docs-freshness.mjs 只校验"列出的路径存在",不校验"存在的文件被列出",所以漏列不会被 CI 抓到。
  action: none(二选一,由维护者定)
  detail: 若这两个延迟分析脚本是常用工具,在项目布局 scripts 段补两行;若是一次性分析残留,删除脚本本身。
  evidence: `ls scripts/` 有 4 个 .mjs;README.md L99–L100 只列 check-token-budget.mjs 与 check-docs-freshness.mjs。
