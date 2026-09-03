# API 验证清单 —— pi 0.84.4 本机实测

本文档记录 pi-advisor 依赖的**每一个** pi / pi-ai API,以及它在本机安装中的确切定义位置。写实现时以本文档为准;升级 pi 后逐行重新核对。

验证环境:

```
pi 版本:        0.84.4
安装路径:       /home/llight/.local/lib/node_modules/@earendil-works/pi-coding-agent
下文缩写:       PI_DIR = 上述路径
pi-ai 路径:     PI_DIR/node_modules/@earendil-works/pi-ai
```

---

## 1. ExtensionAPI(`PI_DIR/dist/core/extensions/types.d.ts`)

extension 入口签名:`export default function (pi: ExtensionAPI): void`

### 1.1 事件订阅 `pi.on(event, handler)`(types.d.ts:907 起,ExtensionAPI.on 重载)

pi-advisor 使用的事件:

| 事件 | payload 类型 | 用途 |
| --- | --- | --- |
| `session_start` | `SessionStartEvent` | 初始化 roster、游标放到 branch 末尾(不回放旧 transcript)、能力检测 |
| `session_shutdown` | `SessionShutdownEvent` | dispose:清队列、取消在途 drain |
| `session_compact` | `SessionCompactEvent` | 主 transcript 被压缩 → 全部 advisor 游标 reset + 上下文摘要后重建 |
| `turn_end` | `TurnEndEvent` | **主触发点**(见 §2.1) |

### 1.2 ⚠️ 关键约束:handler 会被 pi await

`PI_DIR/dist/core/extensions/runner.js:632`,在 `async emit(...)`(l.623)内部:

```js
const handlerResult = await handler(event, ctx);
```

**结论:`turn_end` handler 必须同步返回**,advisor 的 LLM 调用走 fire-and-forget:

```ts
pi.on("turn_end", (event, ctx) => {
  void runtime.onTurnEnd(event, ctx);   // ← 不许 return promise
});
```

### 1.3 方法与属性

| 签名 | 位置 | 用途 |
| --- | --- | --- |
| `sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType"\|"content"\|"display"\|"details">, options?: { triggerTurn?: boolean; deliverAs?: "steer" \| "followUp" \| "nextTurn" }): void` | types.d.ts:971 | advisory 注入(全部 severity:customType `"advisory"` + `deliverAs:"steer"` + `triggerTurn:true`,ADR-013)。`steer` = 打断进行中的工作;`followUp` = 排队等当前工作结束(advisor 不用,实测忙时攒批 ~9 分钟) |
| `appendEntry<T = unknown>(customType: string, data?: T): void` | types.d.ts:985 | 写 CustomEntry 到 session(不入 LLM 上下文)—— 用于 token 记账、debug 追踪 |
| `registerCommand(name: string, options: Omit<RegisteredCommand, "name" \| "sourceInfo">): void` | types.d.ts:946 | `/advisor status | next | now | off` |
| `registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void` | types.d.ts:965 | 让 `customType:"advisory"` 的消息在 TUI 里渲染成带 severity 颜色的卡片 |
| `registerFlag(name: string, options: ...): void` / `getFlag(name: string): boolean \| string \| undefined` | types.d.ts:953,963 | `--advisor-model` 之类 CLI flag(可选功能) |
| `exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>` | types.d.ts:993 | 找 `WATCHDOG.yml`、读文件以外的场景(如 git root 探测) |
| `events: EventBus` | types.d.ts:1077 | runtime 内部事件总线(测试钩子用) |

---

## 2. 事件 payload 形状

### 2.1 `TurnEndEvent`(types.d.ts:585)

```ts
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;              // 本轮 assistant 消息
  toolResults: ToolResultMessage[];   // 本轮工具结果
}
```

注意:pi 直接给了本轮的消息。**但 pi-advisor 不依赖它**,而是用 `ctx.sessionManager.getBranch()` 全量 + 自己的游标切片 —— 原因:跨轮上下文折叠、compact 后 reset、以及 advisor 需要看到 user 消息(turn_end 只给 assistant + toolResult)。

### 2.2 `BeforeAgentStartEventResult`(types.d.ts:845)

```ts
export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** 多个 extension 返回时链式替换 */
  systemPrompt?: string;
}
```

此消息进入 LLM 上下文(类型是 CustomMessage,带 `customType:"advisory"`),下轮游标切片时按 `customType` 过滤,**防递归闭环**。

---

## 3. SessionManager(`PI_DIR/dist/core/session-manager.d.ts`)

### 3.1 `ReadonlySessionManager`(session-manager.d.ts:140)—— extension 拿到的类型

```ts
export type ReadonlySessionManager = Pick<SessionManager,
  "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" |
  "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" |
  "getBranch" | "buildContextEntries" | "getHeader" | "getEntries" |
  "getTree" | "getSessionName">;
```

**类型层面没有任何 append 方法** —— advisor 无法污染主 session,隔离由类型系统保证。

| 方法 | 用途 |
| --- | --- |
| `getBranch(fromId?): SessionEntry[]` | 当前分支全部条目 —— 游标切片的原料 |
| `getEntries(): SessionEntry[]` | 全部条目(含分支外) |
| `buildContextEntries(): SessionEntry[]` | LLM 实际看到的条目(compact 后视角)—— reset 检测的参考 |
| `getLeafId(): string \| null` | 当前叶子 id —— 会话分叉检测 |

### 3.2 `SessionEntry` 相关类型

| 类型 | 位置 | 形状 | 备注 |
| --- | --- | --- | --- |
| `CustomEntry` | l.69 | `{ type: "custom", customType, data }` | **不进 LLM 上下文**;`pi.appendEntry` 写的就是它 |
| `CustomMessageEntry` | l.97 | `{ type: "custom_message", customType, content, details?, display }` | **进 LLM 上下文**;advisory 注入在 transcript 里的形态 |
| `SessionMessageEntry` | — | `{ type: "message", message: AgentMessage, ... }` | 普通消息条目 |
| `CompactionEntry` | — | compact 产生的摘要条目 | reset 检测信号之一 |

**防递归过滤规则**(游标切片时):

```ts
entry.type === "custom_message" && entry.customType === "advisory"  →  跳过
```

---

## 4. ModelRegistry(`PI_DIR/dist/core/model-registry.d.ts:20`)

`ctx.modelRegistry: ModelRegistry`(types.d.ts:221)。这是暴露给 extension 的**同步 facade**(javadoc: "Synchronous compatibility facade exposed to extensions. Coding-agent internals use ModelRuntime directly.")。

### 4.1 pi-advisor 使用的方法

| 签名 | 用途 |
| --- | --- |
| `find(provider: string, modelId: string): Model<Api> \| undefined` | 按 `WATCHDOG.yml` 的 `model: "minimax-cn/MiniMax-M3"` 解析模型对象 |
| `getAvailable(): Model<Api>[]` | 能力检测 / `/advisor status` 展示 |
| `hasConfiguredAuth(model: Model<Api>): boolean` | 无 key 的 advisor 直接标 unavailable,不在 turn_end 时才炸 |
| `complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>` | **★ advisor 引擎**。pi 内部完成 auth 解析、baseURL、请求、SSE 解析,返回完整 AssistantMessage(toolCall 已解析好) |
| `getApiKeyForProvider(provider: string): Promise<string \| undefined>` | 仅 debug/catch 返回 undefined |
| `isUsingOAuth(model: Model<Api>): boolean` | OAuth token 过期风险提示(可选) |

### 4.2 为什么不用裸 `fetch`

`complete()` 替代了 oh-my-pi 的 `agent.prompt()`:

| 裸 fetch | `modelRegistry.complete` |
| --- | --- |
| 自己管 apiKey / OAuth 刷新 | pi 的 ModelRuntime 统一处理 |
| 自己拼 provider 请求体 | pi-ai 按 `model.api` 分发 |
| 自己解析 SSE / toolCall | 返回结构化 `AssistantMessage` |
| 自己处理 baseUrl / 代理 | 继承 pi 的 provider 配置 |

---

## 5. pi-ai 类型(`PI_DIR/node_modules/@earendil-works/pi-ai/dist/types.d.ts`)

### 5.1 `Context`(l.387)—— `complete()` 的入参

```ts
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];      // ← advise 工具 + 只读工具从这里进
}
```

### 5.2 消息类型

| 类型 | 位置 | 关键字段 |
| --- | --- | --- |
| `UserMessage` | l.302 | `{ role: "user", content: string \| (TextContent\|ImageContent)[], timestamp }` |
| `AssistantMessage` | l.307 | `{ role: "assistant", content: (TextContent \| ThinkingContent \| ToolCall)[], api, stopReason, usage, ... }` |
| `ToolResultMessage` | — | `{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }` |
| `ToolCall` | l.256 | `{ type: "toolCall", id, name, arguments: Record<string, any>, thoughtSignature?, namespace? }` |

### 5.3 思考等级

```ts
// types.d.ts:222
ProviderStreamOptions.reasoning?: ThinkingLevel;   // "minimal"|"low"|"medium"|"high"|"xhigh"|"max"

// 调用:
ctx.modelRegistry.complete(model, context, { reasoning: "high" });
```

`WATCHDOG.yml` 的 `model: "provider/model:high"` 冒号后缀 → 解析成 `reasoning` 选项。

`ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsRequestTransforms`(models.d.ts:45)—— 完整 options 类型。

### 5.4 工具定义格式

`Tool = { name, description, parameters: TSchema, constrainedSampling? }`(typebox;`constrainedSampling` 为可选字段,advisor 不用)。advise 工具:

```ts
const ADVISE_TOOL: Tool = {
  name: "advise",
  description: "Surface a concise review note...",
  parameters: Type.Object({
    note: Type.String({ maxLength: 500 }),
    severity: Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")]),
    skipIf: Type.Optional(Type.String({ description: "declare this batch not worth surfacing" })),
  }),
};
```

advisor 调用后在 `AssistantMessage.content` 里找 `type === "toolCall" && name === "advise"` 的 block,`arguments` 已解析为对象。

---

## 6. ExtensionContext(types.d.ts:209–249)

handler 第二参 `ctx: ExtensionContext` 上 pi-advisor 用到的:

| 成员 | 用途 |
| --- | --- |
| `modelRegistry: ModelRegistry` | §4 |
| `sessionManager: ReadonlySessionManager` | §3 |
| `cwd: string` | `WATCHDOG.yml` 查找起点 |
| `isIdle(): boolean` / `waitForIdle(): Promise<void>` | drain 前的避让(可选优化) |
| `hasPendingMessages(): boolean` | 已有排队 steering 时,advisor 的 nit 往后压 |
| `getContextUsage(): ContextUsage \| undefined` | `/advisor status` 展示主上下文水位 |
| `ui.notify(message, type)` | 状态提示 |
| `ui.setStatus(key, text)` | footer 状态条显示 advisor 数 |
| `ui.setWidget(key, content, options)` | `/advisor status` 的面板展示 |
| `ui.setWorkingMessage(message)` | drain 中显示 "advisor reviewing…"(可选) |

---

## 7. 包约定(`PI_DIR/docs/packages.md`)

| 约定 | 出处 |
| --- | --- |
| package.json manifest:`{ "pi": { "extensions": ["./extensions"], "skills": [...], "prompts": [...], "themes": [...] } }` | packages.md:124–130,路径相对包根,支持 glob 与 `!` 排除 |
| 无 manifest 时自动发现 `extensions/`、`skills/`、`prompts/`、`themes/` 约定目录 | 同文档 |
| 安装:`pi install npm:pkg@ver \| git:... \| /abs/path \| ./rel/path`,写 `~/.pi/agent/settings.json`(`-l` 写项目级) | 同文档 |
| 免安装试用:`pi -e npm:@foo/bar` 或 `pi -e /path/index.ts` | 同文档 |

### 7.1 多文件 extension 已验证可行

`~/.pi/agent/npm/node_modules/pi-web-access/index.ts` 用相对导入组织 12+ 文件(`import { extractContentFromHtml } from "./extract.ts"` 等),jiti 直接解析 `.ts` 相对导入。**pi-advisor 的包根 `index.ts` 用同样的方式 import `./src/...`**。入口位于包根,相对导入不跨越包根。

---

## 8. 能力检测矩阵(session_start 时跑一遍)

| 检测 | 方法 | 缺失时降级 |
| --- | --- | --- |
| `modelRegistry.complete` 存在 | `typeof ctx.modelRegistry.complete === "function"` | 全部 advisor unavailable,`/advisor status` 提示升级 pi |
| advisor 模型已注册 | `modelRegistry.find(provider, modelId) !== undefined` | 该 advisor unavailable |
| 模型有 auth | `modelRegistry.hasConfiguredAuth(model)` | 该 advisor unavailable,提示 `/login` |
| `sendMessage` 支持 `deliverAs` + `triggerTurn` | 签名固定(types.d.ts:971),假定存在;首次调用 try/catch | 降级为 notify-only |

---

## 9. 升级 pi 后的核对清单

1. `TurnEndEvent` 字段是否变化(§2.1)
2. `ReadonlySessionManager` 是否仍是只读 Pick(§3.1)
3. `ModelRegistry.complete` 签名是否变化(§4.1)
4. `Context.tools` 的 Tool 格式(§5.1, §5.4)
5. `runner.js` 是否仍 await handler(§1.2)

---

## 10. 结构性假设验证(原 implementation-plan 第 0 步 Spike 结果)

| 假设 | 结果 | 日期 | 证据 |
| --- | --- | --- | --- |
| 包根 `index.ts` 可 import `./src/...` | ✅ 成立 | 2026-08-24 | spike skeleton 提交引入该 import;全部单测通过 |
| `modelRegistry.complete` 冒烟 | ✅ 成立 | 2026-08-25 | §4 本机实测(pi 0.84.3);`src/pi/model-caller.ts` 实际运行 |
