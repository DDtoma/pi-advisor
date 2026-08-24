# pi-advisor

> 面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的 **watchdog advisor 扩展** —— 一组与主 agent 上下文隔离的 LLM 评审员,在后台审计主 agent 的工作,发现问题时按严重级别以不同方式把建议送回主会话。

灵感与大量设计移植自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 advisor 子系统(`src/advisor/`),重新实现为独立的 pi extension 包。

## 它解决什么问题

单个 agent 在长任务中会"钻牛角尖":反复修同一个 bug 而越修越糟、删掉不该删的测试、为了过 lint 把类型检查关掉。主 agent 自己意识不到,因为它看不到自己的模式。pi-advisor 在每次主 agent 轮次结束后,把**增量工作记录**交给一个(或多个)完全独立的 LLM 评审员,它只做一件事:发现**实质性的**问题,并用一句话级别的建议打断或提醒主 agent。

设计哲学(移植自 oh-my-pi):

- **narrate, don't decide** —— advisor 只陈述它看到的问题,不替主 agent 做决定
- **blocker 可以打断** —— `blocker` 级别的建议以 steer 方式注入,立即改变主 agent 的方向
- **otherwise don't** —— `concern`/`nit` 不打断,排队或在下一轮 LLM 调用前静默注入
- **content-free 宁可沉默** —— "看起来不错""没问题"之类的废话被直接丢弃
- **weigh, don't blindly obey** —— 注入主 agent 的建议永远带着这个标签,主 agent 有权忽略

## 与 oh-my-pi 的对应关系

| oh-my-pi(`src/advisor/`) | pi-advisor | 状态 |
|---|---|---|
| 独立 `Agent` 实例 + `agent.prompt()` | `ctx.modelRegistry.complete(model, context)` + 自维护历史 | ✅ 等价 |
| 独立 `ToolSession`(id 加 `-advisor` 后缀) | 自实现只读工具循环(read/grep/find/ls/bash:只读命令) | ✅ 等价(审批模型不同,见 ADR-004) |
| `#extractNewMessages` + `#lastCount` 游标 | `ReadonlySessionManager.getBranch()` + 计数器 + 指纹 | ✅ 等价 |
| `#deliveredPrefix` 原位变异检测 | SHA-1 指纹数组 | ✅ 等价(wyhash → sha1) |
| `#formatRawDelta` markdown 渲染 | 自实现 formatter | ✅ 等价 |
| secret 脱敏(15 个 `x`) | 自实现正则集 + 值收集 | ✅ 等价 |
| `#seenContext` 折叠 | 不适用(pi 无 plan-mode 上下文注入通道) | ⚠️ 省略 |
| `AdviseTool` + `skipIf` 关卡 | `context.tools` 里的 `advise` 工具定义 + 参数校验 | ✅ 等价 |
| `EmissionGuard`(4096 FIFO + 38 短语 + 频率) | 闭包实现,逻辑照抄 | ✅ 等价 |
| `routeAdvice` 5 路路由 | 3 通道:steer / followUp / `before_agent_start` 攒批 | ⚠️ 简化(见 ADR-002) |
| `maintainContext`(promote/compact/re-prime) | 字符预算 + 滚动摘要 + 版本重置 | ✅ 等价 |
| `WATCHDOG.yml` 声明式 roster | 同格式移植 | ✅ 等价 |
| `session-advisors.ts` 文档驻留指令表 | `docs/` + `check-docs-freshness.mjs` | ✅ 等价(形式不同) |

## 安装与使用

```bash
# 全局安装
pi install /path/to/pi-advisor

# 或免安装试用
pi -e /path/to/pi-advisor/extensions/index.ts
```

```bash
/advisor status          # 查看 roster 状态、token 消耗、失败计数
/advisor next            # 检查下一次 turn 会触发哪些 advisor
/advisor now <slug>      # 立即手动触发一次(忽略 focus 过滤)
/advisor off [slug]      # 关闭全部(或指定)advisor
/advisor on [slug]       # 打开全部(或指定)advisor
/advisor reset [slug]    # 清除熔断锁与历史,游标跳到 session 末尾
/advisor reload          # 重新加载 WATCHDOG.yml(全局 + 项目)
```

`PI_ADVISOR_DEBUG=1` 时生命周期事件追加到 `/tmp/pi-advisor-debug.log`。

项目根放一个 `WATCHDOG.yml`:

```yaml
version: "1"
project: my-project
advisors:
  - name: Security
    slug: security
    model: minimax-cn/MiniMax-M3:high
    focus: ["**/*.ts", "**/*.sql"]
    tools: [read, grep]
    trigger: { frequency: "per-update", priority: high }
    prompt: |
      Watch for SQL injection, hardcoded secrets, missing auth checks.
      Flag with severity=blocker anything exploitable.
    ignore: ["**/test/**", "**/*.md"]
    maxTokens: 80000
    failurePolicy: halt
    enabled: true
```

## 项目布局

```
extensions/index.ts      # 组合点:事件接线 + /advisor 命令面
src/advisor/types.ts     # 核心契约(不依赖 pi)
src/advisor/secrets.ts   # secret 脱敏
src/advisor/cursor.ts    # 增量游标(sha1 指纹)
src/advisor/formatter.ts # SessionEntry → markdown
src/advisor/emission-guard.ts  # 废话过滤 + 去重 + 限流
src/advisor/config.ts    # WATCHDOG.yml + YAML 子集解析器
src/advisor/tools.ts     # 只读工具白名单
src/advisor/engine.ts    # 工具循环
src/advisor/router.ts    # severity → 通道路由
src/advisor/runtime.ts   # drain / coalesce / maintainContext / 失败分类
src/advisor/roster.ts    # 配置发现 + runtime 生命周期
src/pi/session-source.ts # ReadonlySessionManager → DeltaSource
src/pi/model-caller.ts   # modelRegistry.complete 封装
src/pi/inject.ts         # steer/followUp/nitQueue → Injector
test/                    # node:test 单测(无 pi 依赖)
test/fixtures/           # WATCHDOG.yml 样例
scripts/check-token-budget.mjs    # prompt ≤ 5000 字符 CI 闸
scripts/check-docs-freshness.mjs  # 文档新鲜度 CI 闸
```

## 开发

```bash
npm test            # 全部单测(node --experimental-strip-types)
npx tsc --noEmit    # 类型检查
npm run lint:tokens # prompt 预算
npm run docs:check  # 文档新鲜度
```

## 文档地图

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 系统架构:三要素(隔离/链路/缓存)的完整设计 |
| [docs/api-verification.md](docs/api-verification.md) | 所有依赖的 pi API 签名,附本机验证位置(pi 0.84.3) |
| [docs/design-decisions.md](docs/design-decisions.md) | 全部 ADR,含被否决的替代方案 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 模块分解、依赖顺序、每模块验收标准 |
| [docs/testing.md](docs/testing.md) | 测试策略与 fixture 说明 |

## 仓库布局

```
pi-advisor/
├── package.json              # pi manifest: { "pi": { "extensions": ["./extensions/index.ts"] } }
├── extensions/
│   └── index.ts              # 唯一入口,组合 runtime + commands
├── src/
│   ├── advisor/              # 核心子系统(与 pi API 解耦,可单测)
│   │   ├── types.ts          # AdvisorConfig / Severity / Note / FailureClass ...
│   │   ├── config.ts         # WATCHDOG.yml 发现 + 解析 + 校验
│   │   ├── cursor.ts         # 增量游标 + 指纹 + reset 检测
│   │   ├── formatter.ts      # SessionEntry → markdown delta(含脱敏钩子)
│   │   ├── secrets.ts        # 脱敏正则集 + 值收集
│   │   ├── runtime.ts        # AdvisorRuntime:drain / coalesce / maintain / 失败分类
│   │   ├── engine.ts         # modelRegistry.complete 封装 + 只读工具循环
│   │   ├── emission-guard.ts # 去重 + content-free 黑名单 + 频率限制
│   │   ├── router.ts         # severity → steer / followUp / 攒批注入
│   │   └── roster.ts         # AdvisorInstance 生命周期 + token 记账 + 状态查询
│   └── pi/                   # pi 专用胶水层
│       ├── session-source.ts # ReadonlySessionManager → DeltaSource
│       └── inject.ts         # sendUserMessage / before_agent_start 封装
├── test/                     # 全部不依赖 pi 的单元测试(node:test)
├── scripts/
│   ├── check-token-budget.mjs    # 系统提示 token 预算 CI 检查
│   └── check-docs-freshness.mjs  # 文档-代码一致性 CI 检查
└── docs/
```

**架构约束(见 ADR-001)**:`src/advisor/` 禁止 import 任何 pi 包,全部 pi 依赖通过 `src/pi/` 胶水层注入。这是整个工程可测试性的根基。

## 版本兼容性

| pi-advisor | 依赖的 pi 版本 | 关键 API |
|---|---|---|
| 0.1.x | pi ≥ 0.84.0 | `modelRegistry.complete`, `turn_end`, `before_agent_start`, `sendUserMessage(deliverAs)` |

`session_start` 时做能力检测,缺 API 则降级为 `/advisor status` 报"需要 pi ≥ 0.84",不 crash。
