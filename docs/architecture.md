# pi-advisor 架构设计

> 实现前必读。本文档定义系统的**完整**设计 —— 不留"待补""以后再优化"的口子。每个模块的验收标准见 [implementation-plan.md](implementation-plan.md),设计取舍见 [design-decisions.md](design-decisions.md)。

## 0. 设计总纲

pi-advisor 是一个 **watchdog 系统**:主 agent 每结束一轮,它的工作记录被渲染成 markdown,交给若干与主会话**完全隔离**的 LLM 评审员(advisor)。advisor 发现实质性问题时,通过 `advise` 工具调用发声,建议经过去重、限流、按严重级别路由后,注入主 agent 的上下文。

三条不可妥协的原则:

1. **隔离** —— advisor 永远不知道自己在看谁,主 agent 的执行节奏永远不被 advisor 拖住
2. **静默是金** —— 任何"看起来不错"式的废话都不能到达主 agent;任何重复的建议都不能到达主 agent
3. **失败不传染** —— advisor 的任何失败(provider 挂了、上下文爆了、超时了)只能影响它自己,主 agent 无感

移植自 oh-my-pi `src/advisor/`,但所有 pi 依赖被压缩到一个胶水层,核心子系统(`src/advisor/`)不 import 任何 pi 包 —— 这是 ADR-001,是整个工程可测试性的根基。

---

## 1. 系统全景

```
┌──────────────────────────── pi 主会话 ────────────────────────────┐
│                                                                  │
│   user ⇄ 主 agent (LLM + tools)                                  │
│              │                                                   │
│              │ turn_end (pi 事件, handler 被 await)               │
│              ▼                                                   │
│   extensions/index.ts                                            │
│      │  void runtime.onTurnEnd()   ← fire-and-forget(ADR-003)    │
└──────┼───────────────────────────────────────────────────────────┘
       ▼
┌──────────────── src/pi/session-source.ts(胶水层)────────────────┐
│  getBranch() → 游标切片 → 过滤 advisory 条目 → RawDelta           │
└──────┼───────────────────────────────────────────────────────────┘
       ▼  RawDelta { entries, cursor, resetDetected }
┌─────────────────── src/advisor/(纯核心)─────────────────────────┐
│                                                                 │
│  formatter.ts   entries → markdown(脱敏、截断、折叠)              │
│       │                                                         │
│       ▼  PendingDelta { text, turnIndex, revision }             │
│  runtime.ts     per-advisor 队列 + 单 drain 循环                 │
│       │         · 连续 revision 相同的 batch 合并(coalesce)      │
│       │         · maintainContext:字符预算检查                   │
│       │         · 超限 → 滚动摘要(再调一次 complete)或重置        │
│       ▼                                                         │
│  engine.ts      modelRegistry.complete(model, {sysPrompt,        │
│                 messages: advisorHistory + [batch],              │
│                 tools: [advise, ...readOnlyTools]})              │
│       │         · stopReason==="toolUse" → 执行只读工具 → 回灌    │
│       │         · 循环上限 8 次                                  │
│       ▼  AdvisorNote { note, severity, skipIf? }                │
│  emission-guard.ts                                              │
│       │  关卡1: skipIf 声明 → 丢弃                               │
│       │  关卡2: normalize → content-free 黑名单(38 短语)        │
│       │  关卡3: 4096 条 FIFO 全局去重                            │
│       │  关卡4: per-update 频率限制(nit 每 update 最多 1 条)     │
│       ▼  通过的 AdvisorNote                                     │
│  router.ts      severity → 通道                                  │
└──────┼───────────────────────────────────────────────────────────┘
       ▼
┌──────────────── src/pi/inject.ts(胶水层)───────────────────────┐
│  all severities → pi.sendMessage({customType:"advisory"}, {deliverAs:"steer", triggerTurn:true}) │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 要素一:上下文隔离

### 2.1 隔离的六层(与 oh-my-pi 逐层对应)

| # | oh-my-pi | pi-advisor | 实现位置 |
|---|---|---|---|
| 1 | 独立 `Agent` 实例,独立 messages | advisor 历史 = `AdvisorInstance.history: Message[]`,纯闭包数据 | `src/advisor/roster.ts` |
| 2 | 独立 `ToolSession`(id `-advisor` 后缀) | 工具循环在 `engine.ts` 内部,直接执行 fs 操作,不走 pi 的 ToolSession | `src/advisor/engine.ts` |
| 3 | advisor 只见渲染后 markdown | `formatter.ts` 把 `SessionEntry[]` 压扁成 `### Role\n...` 纯文本 | `src/advisor/formatter.ts` |
| 4 | advisor 自己的消息过滤出 delta | 切片时跳过 `type==="custom_message" && customType==="advisory"` | `src/advisor/cursor.ts` |
| 5 | secret 脱敏,替换值 15 个 `x` | `secrets.ts`:正则集 + 跨轮值收集 `Set<string>`,替换值固定 `"xxxxxxxxxxxxxxx"` | `src/advisor/secrets.ts` |
| 6 | 不共享 summary cache / compaction | 天然成立:advisor 历史是自己的数组,pi 的 compaction 碰不到;`session_compact` 事件只做 reset | `src/advisor/runtime.ts` |

### 2.2 类型系统强制只读

pi 给 extension 的是 `ReadonlySessionManager`(session-manager.d.ts:140)—— 一个没有任何 append 方法的 `Pick` 类型。`src/pi/session-source.ts` 是唯一触碰它的文件,核心子系统只依赖接口:

```ts
// src/advisor/types.ts —— 核心对主会话的全部认知
export interface DeltaSource {
  /** 从游标位置取新条目;游标失效时 resetDetected=true 并从头给 */
  slice(cursor: Cursor): { entries: SessionEntryLike[]; next: Cursor; resetDetected: boolean };
}
export interface SessionEntryLike {
  type: string;
  customType?: string;
  message?: { role?: string; content?: unknown };
}
```

`SessionEntryLike` 是结构子类型,单测直接喂字面量,不需要 pi。

### 2.3 脱敏的跨轮一致性(oh-my-pi `#advisorRegexSecretValues` 的移植)

```ts
// src/advisor/secrets.ts
export class SecretScrubber {
  private collected = new Set<string>();       // 跨轮收集的 secret 实际值
  private patterns: RegExp[];                   // 内置正则集(API key/JWT/PEM/AWS/GitHub token...)

  scrub(text: string): string {
    // 1. 跑正则,匹配到的值:替换为 "xxxxxxxxxxxxxxx" 并加入 collected
    // 2. 对 collected 中已有值做字面量替换(正则可能漏,但值已收集过)
    // 3. collected 增长无上限风险 → 超过 1024 条 FIFO 淘汰
  }

  reset(): void;   // 上下文 reset 时清空
}
```

**为什么不沿用 oh-my-pi 的稳定 hash 替换**(`«api-key:HASH»`):pi-advisor 的 advisor 无权访问任何需要 secret 的服务,可逆性无意义,固定替换值还能防止 advisor 反向推断 hash。

---

## 3. 要素二:触发 → 返回的完整链路

### 3.1 时序

```
主 agent turn 结束
  │
  ▼ pi 调 handler 并 await(runner.js:588)
turn_end handler { void runtime.onTurnEnd(event, ctx); }   ← 同步返回!
  │
  ▼ (异步世界开始,主 agent 已被放行)
session-source.slice(cursor)
  │  · getBranch() 拿全量
  │  · 计数器游标切片
  │  · 指纹检测原位变异(§4.1)
  │  · 过滤 customType==="advisory"
  ▼
formatter.render(entries, scrubber) → markdown
  │  · 每条 entry → ### User / ### Assistant / ### Tool(name)
  │  · 单条超 6000 字符截断,带 "...[truncated]" 尾标
  ▼
runtime.enqueue(slug, PendingDelta)
  │  · per-advisor 队列
  │  · 同 revision 的连续 delta 合并(一次 drain 喂一批)
  ▼
runtime.drain(slug)   ← 单飞:同 advisor 同时只有一个 drain
  │
  ├─ maintainContext:
  │    advisorHistory + batch 的字符估算 > maxTokens*3.5?
  │    ├─ 是 → summarize():调一次 complete 把旧历史压成摘要(见 §4.4)
  │    └─ 仍超 → reset:历史清空,revision++,重渲染全量
  │
  ├─ engine.run(advisor, batch):
  │    complete(model, { systemPrompt, messages: history+[batch], tools })
  │    loop(≤8):
  │      stopReason==="toolUse" 且是只读工具 → 执行 → toolResult 回灌 → 再 complete
  │      stopReason==="toolUse" 且 name==="advise" → 收集 note,结束
  │      其他 → 结束(沉默 = 没意见)
  │
  ├─ 对每条 note:emissionGuard.check(note, severity, slug, updateId)
  │    通过 → router.route(note)
  │
  └─ 失败 → 分类(§3.3)→ 退避/降级/熔断
  ▼
router.route:
  全部 severity → inject.steer(text, details?) → pi.sendMessage({customType:"advisory"}, {deliverAs:"steer", triggerTurn:true})
```

### 3.2 注入主会话的最终形态

```xml
<advisory advisor="Security" severity="concern" guidance="weigh, don't blindly obey">
src/db.ts:45 的查询用字符串拼接拼进了 userId,有注入风险,建议参数化。
</advisory>
```

所有 severity(blocker/concern/nit)统一走一条通道:`pi.sendMessage({customType:"advisory"}, {deliverAs:"steer", triggerTurn:true})`(ADR-013,取代 ADR-002 的三通道路由)。原先的 followUp 与 nit 攒批通道被废弃,原因是延迟:实测 followUp 在主 agent 空闲时即时投递,但忙时攒批约 9 分钟才批量回放;nit 攒批要等下一次 before_agent_start,延迟无界。advisor 的价值在于帮主 agent 尽早收敛,迟到的建议毫无作用甚至是反作用。
⚠️ **steer 的诚实局限**(从 oh-my-pi 继承讨论):`turn_end` 时本轮已结束,steer 实际作用于"正在进行的后续轮"。若主 agent 空闲,steer 等价于触发新一轮。pi 没有暴露 mid-stream 打断点,这是平台差距,不是实现偷懒(ADR-002)。

### 3.3 失败分类与恢复(oh-my-pi `AdvisorFailureClass` 移植)

```ts
type FailureClass =
  | "provider_permanent"   // 401/403/model 不存在 → 该 advisor 熔断(halt)
  | "provider_transient"   // 429/5xx/网络 → 指数退避(1s,2s,4s…上限 60s),连续 maxConsecutiveFailures 次 → 熔断
  | "advisor_context"      // complete() 返回 context overflow → maintainContext 升级处理
  | "classifier_refusal"   // 内容被分类器拦 → 关闭该 advisor 的 thinking 渲染,重试一次,再犯熔断
  | "timeout";             // 单次 complete 超过 120s → 计入 transient
```

熔断 latch 存于 `AdvisorInstance.halted`,`/advisor status` 可见,`/advisor reset <slug>` 手动解除。**任何失败都不允许异常逃出 drain 循环** —— 这是"失败不传染"原则的代码形态。

---

## 4. 要素三:缓存

全部缓存按职责分四组。所有缓存都是 `AdvisorRuntime` / `Roster` 的闭包状态,不落盘(ADR-005:跨会话不保留 advisor 历史)。

### 4.1 A 组:增量游标(决定 advisor 看到多少新东西)

```ts
// src/advisor/cursor.ts
export interface Cursor {
  count: number;                 // oh-my-pi #lastCount
  fingerprints: string[];        // oh-my-pi #deliveredPrefix:每条已交付 entry 的 sha1
}
```

| 机制 | 规则 |
|---|---|
| 正常切片 | `branch.slice(cursor.count)` |
| 压缩检测 | `branch.length < cursor.count` → reset(全量重渲染) |
| 原位变异检测 | `branch[i]` 的指纹 ≠ `cursor.fingerprints[i]`(i < branch.length)→ reset。覆盖"长度没变但内容被编辑/压缩"的情况 |
| 指纹成本 | 只对新交付的 entry 算 sha1(JSON.stringify),已交付的直接沿用 |
| 防递归 | 切片时跳过 `customType==="advisory"` 的 `custom_message` 条目(但**它们仍计入 count 与指纹**,否则游标漂移) |

oh-my-pi 的 `#seenContext`(plan-mode 上下文折叠)**不移植** —— pi extension 拿不到 plan-mode 状态,没有可折叠的上下文源(ADR-006)。

### 4.2 B 组:队列与代际(决定什么时候喂、喂的是不是过期数据)

```ts
// 每个 AdvisorInstance 持有
queue: PendingDelta[]        // oh-my-pi #pending
draining: boolean            // 单飞锁
revision: number             // oh-my-pi #renderRevision:上下文 reset 时 ++
epoch: number                // oh-my-pi #epoch:外部 reset/dispose 时 ++
consecutiveFailures: number
halted: boolean
```

| 机制 | 规则 |
|---|---|
| coalesce | drain 开始时,把队列里** revision 相同**的连续 delta 合并成一批喂给 advisor |
| revision 失配 | 队列里 revision < 当前 revision 的 delta 直接丢弃(其内容已被 reset 后的全量渲染覆盖) |
| epoch 检查 | drain 的每个 await 前捕获 epoch,resume 后比对,不一致说明期间被 reset → 当前批作废重排 |
| backlog | `/advisor status` 展示 queue.length,不阻塞主 agent(无 waitForCatchup —— pi 没有对应时机,ADR-002) |

### 4.3 C 组:Emission Guard(决定建议能不能出门)

`src/advisor/emission-guard.ts`,逻辑照抄 oh-my-pi `emission-guard.ts`:

```ts
export class EmissionGuard {
  private history: Array<{ key: string; ts: number }> = [];   // FIFO,上限 4096
  private seenThisUpdate = new Set<string>();                  // 单次 update 限流

  check(note: string, severity: Severity, advisorName: string, updateId: number): "allow" | "drop";
  beginUpdate(updateId: number): void;   // 每次 drain 开始
}
```

四道关卡,按顺序:

1. **normalize**:NFKC → 小写 → 去 emoji → 去标点 → 折叠空白。`normalize(note)` 作为一切比对的基础
2. **content-free 黑名单**:38 个短语(`"stop"` `"done"` `"lgtm"` `"no issue"` `"looks good"` `"没有问题"` `"继续"` … 完整清单从 oh-my-pi 拷贝并在注释里注明出处)→ 静默丢弃
3. **全局去重**:`advisorName + normalized` 命中 4096 FIFO → 丢弃(跨 advisor 共享同一 FIFO,防不同 advisor 撞车)
4. **频率限制**:同一 update 内 `advisorName+"nit"` 已发过 → 后续 nit 丢弃;`maxPerUpdate` 可配(默认 nit=1, concern/blocker 不限)

### 4.4 D 组:advisor 上下文维护(maintainContext)

```ts
// 每个 AdvisorInstance
history: Message[]            // advisor 跨轮记忆(oh-my-pi agent.state.messages)
charBudget: number            // maxTokens * 3.5(粗字符估算,避免引入 tokenizer 依赖)
summarizing: boolean
```

drain 喂批前检查 `estimateChars(history) + batch.length > charBudget`:

| 级别 | 动作 |
|---|---|
| 一级:promote | 无(pi 版不需要 oh-my-pi 的 tool-result 外置 —— 我们的工具循环本来就把结果截断到 2000 字符) |
| 二级:summarize | 调一次 `complete`(同模型,低 reasoning):`"把以下评审历史压成 ≤2000 字符的状态摘要,保留:已提过的问题、主 agent 的应对、当前关注点"`,history 替换为 `[摘要 user message]` |
| 三级:reset | 摘要后仍超预算 → history 清空,revision++,下一批附带"上下文已重置,以下是全量近况"前缀 |

**token 记账**:每次 `complete()` 返回的 `usage` 累加进 `AdvisorInstance.usage`,`/advisor status` 展示。**系统提示 token 预算**:每个 advisor 的 system prompt 渲染后 ≤ 5000 字符,CI 用 `scripts/check-token-budget.mjs` 强制(对应 oh-my-pi `session-advisors.ts` 的 token 预算条款)。

### 4.5 E 组:oh-my-pi 有而 pi 版明确不做的缓存

| oh-my-pi | 不做的原因 |
|---|---|
| `#seenContext`(plan-mode 上下文折叠) | pi 不暴露 plan-mode 状态(ADR-006) |
| `#modelIdentity` 检测 | pi 的 model 由 WATCHDOG.yml 显式指定,不跟随主会话换模型 |
| `#includeThinking` 分类器降级 | 保留,但降级为"重试一次后熔断",不做 thinking 渲染开关(pi 的 delta 渲染不含 thinking 块 —— 我们从 SessionEntry 渲染,拿不到 reasoning) |
| YieldQueue / PendingAdvisoryStore / ACP defer | pi 无 plan-mode/ACP 生命周期钩子,路由统一为 steer(ADR-013 取代 ADR-002) |

---

## 5. 配置:WATCHDOG.yml

### 5.1 发现顺序(后者覆盖前者同名 slug)

1. `~/.pi/agent/WATCHDOG.yml`(全局)
2. `<git-root>/WATCHDOG.yml`(项目;git root 用 `ctx.exec("git", ["rev-parse", "--show-toplevel"])` 探测,失败退回 `ctx.cwd`)

### 5.2 schema

```yaml
version: "1"                    # 必填,目前只认 "1"
project: string                 # 可选,展示用
defaults:                       # 可选,所有 advisor 继承
  model: string
  maxTokens: number
  failurePolicy: halt | backoff
advisors:
  - name: string                # 展示名
    slug: string                # [a-z0-9-]+,唯一
    model: "provider/model-id[:thinking]"
    prompt: string              # 评审指令,必填,≤ 5000 字符(见 §4.4 预算)
    focus: string[]             # glob 列表;本轮 delta 提及的路径无一命中 → 跳过
    ignore: string[]            # 从 focus 结果中排除
    tools: ("read"|"grep"|"find"|"ls"|"bash")[]   # 授予的只读工具,默认 []
    trigger:
      frequency: per-update | per-N-turns         # per-N-turns 配 every: N
      every: number
      priority: low | normal | high               # 队列拥堵时 high 先 drain
    maxTokens: number           # 默认 80000
    failurePolicy: halt | backoff   # 默认 backoff
    enabled: boolean            # 默认 true
```

校验规则(全部 fail-fast,加载时报错并指出行号):slug 重复、`version` 不支持、model 无冒号分隔的非法格式、prompt 超预算、focus/ignore 非法 glob。

### 5.3 focus 匹配的语义

delta 渲染前,从 entries 里提取"路径线索":工具调用的 `path`/`file` 参数、`### Tool(edit/write)` 的参数 JSON、文本里的相对路径形态 token。任一命中 `focus` 且未命中 `ignore` → 本轮触发。`focus` 缺省 = 总是触发。**per-N-turns 与 focus 是 AND 关系**。

---

## 6. 命令面

| 命令 | 行为 |
|---|---|
| `/advisor status` | widget 面板:每个 advisor 的 enabled/halted、队列深度、累计 token、上次发声时间、最近一条 note 摘要 |
| `/advisor next` | 若下一 turn_end 发生,哪些 advisor 会触发(focus 预检 + frequency 计数),以及各自的 charBudget 水位 |
| `/advisor now <slug>` | 立即对当前未消费的 delta 跑一次(忽略 focus/frequency),结果照常走 emission guard + 路由 |
| `/advisor off` | 全局禁用(内存态,不写配置);`/advisor on` 恢复 |
| `/advisor reset <slug>` | 清历史、游标、熔断 latch、失败计数 |
| `/advisor reload` | 重新发现并解析 WATCHDOG.yml,diff 应用(新增/删除/改配置) |

TUI 渲染:`registerMessageRenderer("advisory", ...)` 解析信封,给每条 advisory 加 severity 徽标并按等级整卡着色:`[NIT]`=灰、`[CONCERN]`=橙(固定 256 色 #d75f00,不用主题 warning 黄——亮色背景下不可读)、`[BLOCKER]`=红。所有 advisory 都以 steer 投递的 `customType:"advisory"` custom message 到达,统一走此渲染器。

超长 note 的截断可见性:`note` 超 `MAX_NOTE_CHARS`(500)时引擎截断并补 `…`,未截断原文挂在消息的 `details.fullNote` 上(不进 LLM 上下文);渲染器折叠时显示 `[truncated — expand to view full note]`,展开(默认 ctrl+o)时显示完整原文。

---

## 7. 模块依赖图(无环)

```
types.ts        (零依赖)
secrets.ts      → types
cursor.ts       → types
formatter.ts    → types, secrets
emission-guard.ts → types
config.ts       → types            (yaml 解析:自实现最小 YAML 子集,见 ADR-007)
engine.ts       → types            (ModelCaller 接口注入,见 ADR-001)
router.ts       → types            (Injector 接口注入)
runtime.ts      → types, secrets, cursor, formatter, emission-guard, engine, router
roster.ts       → types, config, runtime
──────────────────────────── 以下可以 import pi ────────────────────────────
src/pi/session-source.ts → types   (ReadonlySessionManager → DeltaSource)
src/pi/inject.ts         → types   (pi.sendMessage → Injector)
extensions/index.ts      → roster, router (parseAdvisories), src/pi/*   (唯一组合点)
```

`src/advisor/` 任何文件 import pi 包 = lint 错误(CI 用简单 grep 强制)。

---

## 8. 关键接口定义(契约先行)

```ts
// src/advisor/types.ts —— 核心子系统对外部世界的全部依赖

/** 引擎抽象:engine.ts 的实现调 modelRegistry.complete,测试喂 mock */
export interface ModelCaller {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
export interface CompleteRequest {
  systemPrompt: string;
  messages: Message[];              // pi-ai 消息类型的结构子集
  tools: ToolDef[];
  signal?: AbortSignal;
}
export interface CompleteResult {
  stopReason: string;
  content: ContentBlock[];          // text / toolCall
  usage?: { input?: number; output?: number };
}

/** 注入抽象:router 对着它编程,pi/inject.ts 实现它 */
export interface Injector {
  steer(text: string, details?: unknown): void;
}

/** 只读工具执行器:engine 的工具循环对着它编程 */
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
}
```

---

## 9. 性能与资源预算

| 项 | 预算 | 强制方式 |
|---|---|---|
| advisor system prompt | ≤ 5000 字符 | `check-token-budget.mjs` CI |
| 单条 entry 渲染 | ≤ 6000 字符,超出截断 | formatter |
| 工具结果回灌 | ≤ 2000 字符 | engine 工具循环 |
| advisor history | ≤ maxTokens × 3.5 字符 | runtime maintainContext |
| emission FIFO | 4096 条 | EmissionGuard |
| 单次 complete 超时 | 120s(AbortSignal) | engine |
| 工具循环 | ≤ 8 轮 | engine |
| drain 单飞 | per-advisor 锁 | runtime |
| turn_end handler | 0 次 await(立即 fire-and-forget) | code review + runner.js:588 注释引用 |

## 10. 安全模型

1. **advisor 拿不到主会话的 secret** —— formatter 前 scrub(§2.3)
2. **advisor 的工具是只读的** —— 工具白名单 read/grep/find/ls/bash;bash 命令过只读判断(拒绝 `>`、`rm`、`mv`、`sed -i` 等写操作的模式匹配,宁严勿宽;争议命令直接拒绝)
3. **advisor 的建议不携带执行权威** —— 注入文本恒带 `guidance="weigh, don't blindly obey"`
4. **advisor 失败不影响主 agent** —— drain 全 try/catch,失败分类 + 熔断 latch
5. **配置 fail-fast** —— WATCHDOG.yml 非法直接拒载并指明行号,不做"尽力加载"
