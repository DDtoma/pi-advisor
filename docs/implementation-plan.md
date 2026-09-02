# 实现计划

> 顺序即依赖序。每一步都有明确的**完成定义(DoD)** —— 不满足 DoD 不进入下一步。所有模块的架构约束见 [architecture.md](architecture.md),API 签名见 [api-verification.md](api-verification.md)。

## 第 0 步:Spike —— 验证两个结构性假设

**目的**:在写任何正式代码前,证实两个决定仓库形态的假设。

### 0.1 `extensions/index.ts` 能否 import `../src/...`

写 5 行 spike:

```ts
// extensions/index.ts
import { ping } from "../src/advisor/types.js";
export default function (pi) {
  pi.registerCommand("spike", { handler: (_a, ctx) => ctx.ui.notify(ping(), "info") });
}
```

`pi -e /home/llight/Projects/pi-advisor/extensions/index.ts` 启动,`/spike` 能弹通知即通过。

**若不通过**:退而把整个 `src/` 挪进 `extensions/` 目录(布局变更,文档同步改),或给 `src` 加构建步骤(`tsc` 产出 `dist/`,manifest 指向 `dist/extensions/index.js`)。**以 spike 结果为准,并回来更新本文档与 README 布局图。**

### 0.2 `modelRegistry.complete` 冒烟

spike 命令里调一次:

```ts
const model = ctx.modelRegistry.find("minimax-cn", "MiniMax-M3");
const res = await ctx.modelRegistry.complete(model, {
  systemPrompt: "Reply with exactly: PONG",
  messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
});
```

能拿到 `res.content` 里的文本即通过。同时验证带 `tools` 的调用能拿到 `toolCall` block。

**DoD**:两个 spike 都在真实 pi 会话里跑通,结果记录到本文档下方"Spike 结果"节。

---

## 第 1 步:`src/advisor/types.ts` + `secrets.ts`

纯数据与纯函数,零外部依赖。

**types.ts 内容**:`Severity`、`AdvisorNote`、`AdvisorConfig`、`TriggerConfig`、`FailureClass`、`Cursor`、`PendingDelta`、`Message`/`ContentBlock`/`ToolDef`(pi-ai 结构子集)、三大注入接口(`DeltaSource`/`ModelCaller`/`Injector`)、`ToolExecutor`。

**secrets.ts 内容**:`SecretScrubber` 类(见 architecture §2.3):内置正则集(OpenAI/Anthropic/GitHub/AWS/JWT/PEM/通用 `api[-_]?key` 赋值)、`collected: Set<string>` 跨轮值收集(1024 条 FIFO 淘汰)、`scrub(text)`、`reset()`。

**DoD**:
- `test/secrets.test.ts` 通过:每类正则至少 1 个正例 1 个反例;跨轮一致性测试(第一轮出现的 secret 值,第二轮不同文本中再次出现也被替换);`reset()` 后不再替换
- 类型文件被后续所有模块 import,自身零 import

---

## 第 2 步:`cursor.ts` + `formatter.ts`

**cursor.ts**:`createCursor()`、`sliceBranch(branch, cursor)`(见 architecture §4.1:计数器 + sha1 指纹 + 原位变异检测 + advisory 过滤但计入游标)。指纹函数:`sha1(JSON.stringify(entry))`。

**formatter.ts**:`renderDelta(entries, scrubber, opts)` → markdown。规则:`### User` / `### Assistant` / `### Tool(name)` 三级标题;assistant 丢弃 thinking 块(ADR-008);单条 6000 字符截断带尾标;toolCall 渲染为 `name(args JSON 截断 500 字符)`;toolResult 渲染 `isError` 前缀;**所有文本过 `scrubber.scrub()`**。

**DoD**:
- `test/cursor.test.ts`:增量切片、长度回缩 reset、原位变异 reset(改内容不改长度)、advisory 条目被跳过但游标不漂移
- `test/formatter.test.ts`:三种 role 渲染、thinking 丢弃、截断尾标、toolCall/toolResult 格式、脱敏集成(scrubber mock 断言被调用且输出无原文)

---

## 第 3 步:`emission-guard.ts`

照抄 oh-my-pi 逻辑(ADR-009):normalize(NFKC→小写→去 emoji→去标点→折叠空白)、38 短语黑名单(注释注明出处)、4096 FIFO(`advisorName+normalized` 为 key,跨 advisor 共享)、per-update 频率(nit 每 update 1 条)。API:`beginUpdate(updateId)`、`check(note, severity, name, updateId) → "allow"|"drop"`。

**DoD**:
- `test/emission-guard.test.ts`:黑名单逐条命中(从 oh-my-pi 拷贝的 38 条全覆盖)、normalize 等价类(大小写/标点/emoji 变体判重)、FIFO 4096 上限、nit 频率限制、concern/blocker 不受频率限制

---

## 第 4 步:`config.ts` + 最小 YAML 解析器

`parseYamlSubset(text)`(ADR-007)→ `parseWatchdog(yaml, source) → AdvisorConfig[]`。校验(ADR-010,全部带行号):version、slug 唯一/格式、model 格式 `provider/id[:thinking]`、prompt ≤ 5000 字符、focus/ignore glob 合法性、failurePolicy 枚举。`mergeRosters(global, project)`:项目级覆盖同 slug。

**DoD**:
- `test/config.test.ts`:合法样例全字段解析、每类校验错误各一个反例(报错含行号)、块字符串 `|` 保留换行、全局+项目合并语义
- `test/fixtures/` 下至少 3 个样例 WATCHDOG.yml(合法/非法/合并)

---

## 第 5 步:`engine.ts` —— ModelCaller 实现 + 只读工具循环

两个职责:

1. **`PiModelCaller`(接口实现放 `src/pi/`?)** —— 不。按 ADR-001,`engine.ts` 只定义**围绕 `ModelCaller` 接口的工具循环**;`ModelCaller` 的 pi 实现在 `src/pi/model-caller.ts`(薄封装 `ctx.modelRegistry.complete`,含 `reasoning` 传参与 120s AbortSignal 超时)。
2. **工具循环 `runWithTools(caller, req, executor, maxRounds=8)`**:stopReason==="toolUse" → `executor.execute()`(结果截断 2000 字符)→ toolResult 回灌 → 再 complete;`advise` 工具的 call 不执行,收集为 `AdvisorNote` 后结束循环;其他 stopReason 直接结束。

`ToolExecutor` 的白名单实现(`src/advisor/tools.ts`):read(fs 读文件,行截断)、grep(正则递归搜)、find(glob)、ls、bash(只读模式匹配,ADR-004)。参数里的路径全部 resolve 后校验在 cwd 内(防 `../../etc/passwd`)。

**DoD**:
- `test/engine.test.ts`:mock ModelCaller 分别返回 text / advise toolCall / 连续 3 轮 read→grep→advise;断言循环轮数、toolResult 回灌格式、8 轮上限强制
- `test/tools.test.ts`:五个工具正例;bash 写命令拒绝矩阵(`>`、`rm`、`mv`、`tee`、`sed -i`、`chmod` 各一例);路径逃逸拒绝

---

## 第 6 步:`runtime.ts` —— drain / coalesce / maintainContext / 失败分类

核心状态机,架构 §3.1 时序的代码化。持有 per-advisor:queue、draining 锁、revision、epoch、consecutiveFailures、halted、history、charBudget(architecture §4.2/§4.4)。

入口 `onTurnEnd(source: DeltaSource)`:
1. `source.slice(cursor)` → resetDetected 则该 advisor reset(history 清、revision++)
2. `formatter.renderDelta` → 空则跳过
3. focus/frequency 过滤(config)
4. enqueue + `void drain(slug)`

`drain(slug)`:单飞锁 → coalesce 同 revision → epoch 捕获 → maintainContext(摘要/reset 三级)→ `runWithTools` → 每条 note 过 EmissionGuard → Injector 路由 → usage 记账 → 异常 → 失败分类(architecture §3.3)→ 退避/熔断。

**DoD**:
- `test/runtime.test.ts`(全部 mock:DeltaSource/ModelCaller/Injector):
  - drain 单飞(并发 onTurnEnd 只串行执行)
  - coalesce(两次 enqueue 一次 drain 合并为一批)
  - reset 传播(source 报 reset → history 清空、revision++、旧 revision 队列丢弃)
  - 失败分类四分支(401→halt;429→退避且计数;context overflow→触发摘要;连续 N 次→halt)
  - EmissionGuard 集成(重复 note 不注入第二次)
  - 任何 mock 抛错都不逃出 drain(不传染)
- 本步完成后核心子系统全部可单测,不依赖 pi

---

## 第 7 步:`roster.ts` + `src/pi/` 胶水层

**roster.ts**:加载/合并/校验 WATCHDOG.yml(`discoverRoster`:全局 + git root 项目级)、实例化 `AdvisorInstance`(config + runtime 状态)、`/advisor now|reset|reload|next` 所需的查询与操作接口、usage 汇总。

**src/pi/session-source.ts**:`ReadonlySessionManager` → `DeltaSource` 适配(architecture §2.2)。

**src/pi/model-caller.ts**:`ctx.modelRegistry.complete` 薄封装:systemPrompt/messages/tools 透传、`reasoning` 从 model 字符串冒号后缀解析、120s AbortSignal、AssistantMessage → CompleteResult 归一化。

**src/pi/inject.ts**:`Injector` 实现:`<advisory ...>` 包装(architecture §3.2)、全部 severity 经 `pi.sendMessage({customType:"advisory"}, {deliverAs:"steer", triggerTurn:true})` 直发;`Injector` 只剩 `steer(text, details?)`(ADR-013)。

**DoD**:
- roster 单测(mock fs):发现顺序、项目级覆盖、slug 冲突拒载
- 胶水层无法单测的部分控制在每个文件 < 80 行,逻辑全部下沉到核心

---

## 第 8 步:`extensions/index.ts` —— 组合点 + 命令面

事件接线(全部 fire-and-forget,ADR-003):

```ts
session_start   → 能力检测(api-verification §8)→ discoverRoster → 游标置尾
session_compact → roster.resetAllCursors()
session_shutdown→ roster.dispose()
turn_end        → void runtime.onTurnEnd(...)
```

命令:`/advisor status`(widget 面板)/`next`/`now <slug>`/`off`/`on`/`reset <slug>`/`reload`。`registerMessageRenderer("advisory", ...)` 渲染 severity 色卡片。

**DoD**:
- 真实 pi 会话端到端:放一个 WATCHDOG.yml,让主 agent 故意写一个 SQL 拼接,Security advisor 在 turn_end 后数秒内以预期 severity 注入建议
- `/advisor status` 面板数据与实际情况一致
- `pi -e` 免安装与 `pi install` 安装两种形态都工作

---

## 第 9 步:CI 脚本 + 文档收尾

**scripts/check-token-budget.mjs**:扫描 WATCHDOG.yml 样例与代码内嵌 prompt,渲染后 > 5000 字符即失败(architecture §9)。

**scripts/check-docs-freshness.mjs**:检查(a)README 布局图与实际目录一致;(b)api-verification.md 中引用的 pi 版本与 `pi --version` 一致;(c)ADR 编号连续无空洞。

**DoD**:
- `npm test` 全绿、`npm run lint:tokens`、`npm run docs:check` 全绿
- README 的"与 oh-my-pi 的对应关系"表逐行复核状态列
- docs 五份文件交叉引用无死链

---

## 完成总定义(整个工程)

1. 全部 9 步 DoD 勾选
2. 测试覆盖率:核心子系统(`src/advisor/`)行覆盖 ≥ 90%
3. 真实使用 1 天无"失败传染"(advisor 挂掉时主会话无任何异常)
4. 本文档"Spike 结果"节已填写

---

## Spike 结果(第 0 步完成后填写)

| 假设 | 结果 | 日期 | 备注 |
|---|---|---|---|
| 0.1 extensions 可 import ../src | ☐ 未验证 | | |
| 0.2 modelRegistry.complete 冒烟 | ☐ 未验证 | | |
