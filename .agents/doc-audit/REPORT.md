# Doc audit — pi-advisor — 2026-09-02

Scanner: doc_landscape.py (bundled with project-doc-landscape) + ripgrep Phase 3 patterns
Scope: 6 markdown files, 14 code files sampled for comments (src/advisor/*.ts, src/pi/*.ts, extensions/index.ts)

## Summary

| Severity | Open | Fixed |
| --- | --- | --- |
| high | 0 | 0 |
| medium | 0 | 4 |
| low | 0 | 1 |
| informational | 0 | 2 |

## Findings index

| File | Findings | Status |
| --- | --- | --- |
| [README.md](findings/README.md) | 双布局小节重复漂移(已合并);analyze-*.mjs 无文档(已补入布局块) | fixed |
| [docs/implementation-plan.md](findings/docs/implementation-plan.md) | Spike 结果已按证据填写并入 api-verification.md §10,文件已删除,README 文档地图链接已摘 | fixed |
| [docs/testing.md](findings/docs/testing.md) | §2.2 改写为 fake 内联现状;§2.3 降级为"尚未建立";§4/§5 的 e2e 引用已同步 | fixed |
| [docs/architecture.md](findings/docs/architecture.md) | L178 已重排为一行并裁剪变更叙述;L3 失效的 implementation-plan 链接已移除 | fixed |
| [PROJECT](findings/PROJECT.md) | 已新建根 AGENTS.md(硬规则 + 链接) | fixed |
| [docs/api-verification.md](findings/docs/api-verification.md) | 声明 pi 0.84.3,本机 0.84.4;已按 §9 清单复核 0.84.4 并更新全部行号与签名漂移 | fixed |

## Remediation 记录(2026-09-02)

计划见 [PLAN.md](PLAN.md),三个决定点均由用户拍板:implementation-plan.md 删除、analyze-*.mjs 保留、AGENTS.md 新建。

附带修复(删除 implementation-plan.md 的连锁):src/pi/model-caller.ts、extensions/index.ts、src/advisor/roster.ts、src/advisor/formatter.ts、scripts/check-docs-freshness.mjs 五处注释中的悬空 `(implementation-plan Step N)` 引用改为 architecture §/ADR 引用;docs/api-verification.md §7 的"先做 spike 验证"改为指向 §10 的已验证结论;src/pi/model-caller.ts L75 补 SAFETY 注释(pi-lens 规则,既有问题)。

## 最终验证(2026-09-02)

- `doc_landscape.py links .`:13 files,0 broken ✓
- `doc_landscape.py wrap .`:项目文档 0 违规(残留均在 .agents/doc-audit/ 工作文件,不计) ✓
- `npm test`:全部通过;`npx tsc --noEmit`:干净 ✓
- `npm run docs:check`:layout ✓、ADR 序号 ✓、版本闸 ✓(pi 0.84.4 复核后,输出 "docs fresh")

## 追加:pi 0.84.4 复核(2026-09-02)

§9 五项核对结果:TurnEndEvent 字段不变(types.d.ts:585);ReadonlySessionManager 同一 Pick(session-manager.d.ts:140);complete 增加 `<TApi extends Api>` 约束(model-registry.d.ts:33);Context.tools 不变(l.387),Tool 新增可选 `constrainedSampling`;runner.js 仍 await handler(l.632,emit 于 l.623)。全部通过,155 测试 pass,tsc 干净,审计发现全部闭环。
