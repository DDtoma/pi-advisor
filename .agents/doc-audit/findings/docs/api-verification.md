# Findings: docs/api-verification.md

- status: fixed
  severity: medium
  role: subsystem reference
  issue: 文档声明基于 pi 0.84.3 本机实测,但本机已安装 pi 0.84.4,`npm run docs:check` 的版本闸因此失败。这是 remediation 期间发现的既有漂移,与本次修复的发现无关。
  standard: 项目自有 CI 闸(check-docs-freshness.mjs 检查 b)保持权威;"Generated/verified reference 与源漂移"即失效。
  action: rewrite
  detail: 已按 §9 清单对 pi 0.84.4 逐项复核并更新(2026-09-02):五项核对全过,发现的签名/位置漂移已改——`complete<TApi extends Api>` 泛型约束、`sendMessage<T>`/`appendEntry<T>`/`registerMessageRenderer<T>` 泛型化、`getFlag` 返回 `boolean | string | undefined`、`ThinkingLevel` 无 `"off"`、`Tool` 新增可选 `constrainedSampling`;全部行号引用重核(types.d.ts 重排,§3/§4 不变);§10 spike 记录保留 0.84.3 字样(历史事实,不 retroactive 改)。README 文档地图同步为 0.84.4。复核后 `npm run docs:check` 输出 "docs fresh"。
  evidence: `npm run docs:check` 输出 `✖ api-verification.md says pi 0.84.3, installed 0.84.4`(2026-09-02);修复后同命令输出 `✔ pi version 0.84.4 matches`。
