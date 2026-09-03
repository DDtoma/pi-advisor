# 设计决策记录(ADR)

每条 ADR 记录:决策、理由、被否决的替代方案。新决策追加到文末,编号不回收。

---

## ADR-001:核心子系统与 pi 完全解耦,胶水层隔离

**决策**:`src/advisor/` 下的所有模块(types/secrets/cursor/formatter/emission-guard/config/engine/router/runtime/roster)**禁止 import 任何 pi / pi-ai 包**。对 pi 的全部依赖通过三个接口注入:`DeltaSource`(主 transcript 来源)、`ModelCaller`(LLM 调用)、`Injector`(建议回注)。pi 相关实现全部放在 `src/pi/` 与包根 `index.ts`。

**理由**:

1. 可测试性 —— 核心逻辑(游标、防递归、脱敏、emission guard、失败分类、coalesce)是本项目复杂度最高的部分,必须能在无 pi 环境下用 `node:test` 单测
2. pi 升级时,需要改的代码被限制在 `src/pi/` 两个文件 + 包根 `index.ts`
3. 类型层面即强制:`SessionEntryLike`、`Message` 等都是结构子类型,单测喂字面量

**否决**:

- ~~直接在 extension 里写全部逻辑~~ —— 无法单测,pi 升级一次全盘回归
- ~~依赖注入框架~~ —— 三个接口的手工构造注入足够,引入框架是过度工程

---

## ADR-002:返回通道简化为 3 条,放弃 plan-mode/ACP 感知路由

**状态: 已被 ADR-013 取代(2026-08-25)** —— 保留原文存档。

**决策**:severity 路由 = `blocker → steer`、`concern → followUp`、`nit → before_agent_start 攒批`。不实现 oh-my-pi 的 5 路路由(inProgress withhold / ACP defer / plan-mode pause / aside batch / steer)。

**理由**:pi extension API 拿不到 plan-mode 激活状态、ACP 生命周期、以及"轮次进行中"的可靠信号。强行实现只能猜,猜错比没有更糟。3 条通道已覆盖全部 severity 的语义:blocker 打断、concern 排队、nit 静默攒批。

**否决**:

- ~~用 `ctx.isIdle()` 轮询模拟"轮次进行中"~~ —— 时序竞争,收益微小
- ~~nit 也走 followUp~~ —— 会产生大量"只含一条小建议"的轮次,浪费主 agent token;`before_agent_start` 注入不产生额外轮次,是严格更优的 nit 通道

**已知局限**:steer 在 `turn_end` 时本轮已结束,实际作用于后续轮;主 agent 空闲时 steer ≈ followUp。这是 pi 平台差距(无 mid-stream 打断点),记录在案,不视为缺陷。

---

## ADR-003:turn_end handler 必须 fire-and-forget

**决策**:所有事件 handler 同步返回,advisor 的 drain 循环用 `void runtime.onTurnEnd(...)` 异步启动。

**理由**:`runner.js:588` 显示 pi 在 `async emit()` 里 `await handler(event, ctx)`。advisor 的一次 drain 包含至少一次 LLM 调用(秒级到分钟级),若被 await,主 agent 的每轮结束都会被 advisor 拖住 —— 直接违反"主 agent 执行节奏不被 advisor 拖住"的总纲第 1 条。

**推论**:`before_agent_start` 是例外 —— 它必须同步返回注入内容,因此 nit 队列的 `drain()` 操作必须是 O(1) 无 await 的纯内存操作。(已随 ADR-013 废弃:nit 队列已删除,扩展不再订阅 before_agent_start)

---

## ADR-004:advisor 工具 = 自实现只读工具循环,不复用 pi 工具系统

**决策**:advisor 的工具(read/grep/find/ls/bash:只读子集)由 `engine.ts` 的工具循环直接执行(Node fs + 自实现 glob/grep),不注册为 pi 工具,不走 pi 的 ToolSession/审批系统。

**理由**:

1. `pi.registerTool` 注册的工具是给**主 LLM** 的,出现在主 agent 的工具列表里 —— advisor 的工具混进去会污染主 agent
2. pi 的 ToolSession 绑定主会话的审批状态,advisor 需要一个"始终允许只读、永远拒绝写入"的独立策略,自己实现反而更严格可控
3. 工具循环本来就是 `complete()` 之间的 ~80 行胶水:解析 toolCall → 执行 → 截断到 2000 字符 → 塞回 messages → 再 complete

**否决**:

- ~~给 advisor 也注册 pi 工具~~ —— 见理由 1
- ~~bash 全开放~~ —— 安全模型第 2 条:bash 命令必须过只读模式匹配,争议命令一律拒绝

---

## ADR-005:advisor 状态不落盘,会话生命周期 = 进程生命周期

**决策**:游标、advisor 历史、emission FIFO、熔断 latch 全部只在内存。pi 重启后,advisor 从 session 末尾重新起步(`session_start` 时游标放到 branch 末尾,不回放旧 transcript)。

**理由**:

1. 回放旧 transcript 意味着重启后第一波 drain 会把整个历史喂给 advisor —— 一次巨大的、价值可疑的 token 开销
2. advisor 的价值密度在"近期",对几小时前的工作提建议,主 agent 早已离开那个上下文
3. 不落盘就没有状态迁移问题,WATCHDOG.yml 是唯一持久化配置

**否决**:

- ~~序列化 AdvisorInstance 到 session 目录~~ —— 增加崩溃恢复、schema 迁移、stale 状态三重复杂度,换"重启后记得上次说过什么" —— emission FIFO 的意义恰恰是让 advisor 不要重复,而重启后用户容忍度天然更高

---

## ADR-006:不移植 oh-my-pi 的 `#seenContext` 上下文折叠

**决策**:不实现"主会话注入的 plan-mode/goal 上下文按 hash 折叠为 (unchanged — still in effect)"。

**理由**:oh-my-pi 折叠的是它自己注入到 advisor 的 plan-mode 规则与 goal 上下文。pi extension 拿不到 plan-mode 状态,没有对应的注入源,折叠无对象。

**复核条件**:pi 未来若暴露 plan-mode 状态(`ctx.planMode` 之类),重新评估。

---

## ADR-007:WATCHDOG.yml 用自实现的最小 YAML 子集解析器

**决策**:`config.ts` 内置一个 ~150 行的 YAML 子集解析器,支持:嵌套 map(2 空格缩进)、列表(`- item`)、标量(string/number/boolean)、块字符串(`|`)、注释。不引入 `yaml` npm 依赖。

**理由**:

1. pi extension 包对依赖敏感 —— `pi install npm:...` 的依赖解析有坑(见 packages.md 故障排除节),零运行时依赖是最稳的分发形态
2. WATCHDOG.yml 的 schema 是固定的浅层结构,完整 YAML 规范(锚点、多行流式、标签)用不上
3. 解析器本身是纯函数,单测覆盖成本极低

**否决**:

- ~~依赖 `yaml` 包~~ —— 见理由 1;若未来 schema 复杂到子集解析器撑不住(>300 行),再引入并改 ADR
- ~~改用 JSON 配置~~ —— prompt 是多行字符串,JSON 写多行 prompt 是灾难;YAML 的 `|` 块字符串是正确工具

---

## ADR-008:主 transcript 渲染不含 thinking/reasoning 块

**决策**:`formatter.ts` 渲染 assistant 消息时,丢弃 `ThinkingContent` 块,只渲染文本与工具调用。

**理由**:

1. oh-my-pi 的 `#includeThinking` 默认关闭,且会在分类器拒绝时主动降级 —— 说明 thinking 对 advisor 价值低而风险(分类器/预算)高
2. 字符预算:thinking 块通常是正文的几倍
3. advisor 评审的是"行为与结果",不是"心路历程"

**推论**:oh-my-pi 的 `classifier_refusal → 关闭 thinking 渲染 → 重试` 降级链简化为 `重试一次 → 再犯熔断`(没有可关的开关了)。

---

## ADR-009:EmissionGuard 的 38 短语黑名单从 oh-my-pi 拷贝并在注释注明出处

**决策**:`emission-guard.ts` 的 `CONTENT_FREE_PHRASES` 逐条拷贝自 oh-my-pi `src/advisor/emission-guard.ts:15-70`,文件头注释注明来源与拷贝日期(2026-04)。

**理由**:这份清单是 oh-my-pi 在真实使用中迭代出来的领域知识,重新发明只会更差。拷贝时注意许可证兼容(oh-my-pi 为 MIT,pi-advisor 同为 MIT,注明出处即满足)。

**维护规则**:新增短语时同时检查 oh-my-pi 上游是否也有更新;两边分叉可接受,但出处注释永不可删。

---

## ADR-010:多 advisor 用 roster 模式,fail-fast 校验,slug 为唯一身份

**决策**:`WATCHDOG.yml` 声明全部 advisor;加载时 slug 重复、模型非法、prompt 超预算任何一项直接拒载整个文件并报行号。advisor 的一切运行时状态以 slug 为 key。

**理由**:

1. "尽力加载"(跳过坏的加载好的)会让用户以为 Security 在跑,实际它因 typo 没加载 —— 静默失效是 watchdog 系统最不可接受的失败模式
2. slug 不可变(改了视为删除+新增),运行时状态不迁移 —— 简单可预测

**否决**:

- ~~尽力加载~~ —— 见理由 1
- ~~按 name 匹配状态~~ —— name 是展示文案,允许重复(全局与项目级可能同名不同配置),slug 才是身份

---

## ADR-011:默认不开任何 advisor

**决策**:包安装后,若没有 `WATCHDOG.yml`,extension 静默注册命令面(`/advisor status` 显示"未配置")但不产生任何 LLM 调用。不提供内置默认 advisor。

**理由**:advisor 的每一次 drain 都是真实的 token 开销。未经用户显式声明就烧 token,是不可原谅的默认行为。

---

## ADR-012:token 估算用字符数,不引入 tokenizer

**决策**:`charBudget = maxTokens × 3.5`(英文字符/token ≈ 4,保守取 3.5)。history 水位用 `JSON.stringify` 长度估算。

**理由**:tokenizer 依赖(tiktoken 等)体积大、provider 间不通用;水位检查只需要"别爆",不需要精确。±20% 的误差由三级 reset 兜底。

**否决**:~~引入 gpt-tokenizer~~ —— 分发体积与维护成本不值这点精度。

---

## ADR-013:全部 severity 统一走 steer,废弃 followUp 与 nit 攒批

**状态**:已实施(2026-08-25),取代 ADR-002 的通道路由部分。

**决策**:blocker/concern/nit 全部以 `pi.sendMessage({customType:"advisory"}, {deliverAs:"steer", triggerTurn:true})` 投递;删除 followUp 通道、nit 攒批队列(`nitQueue`/`drainNits`/`enqueueNit`)和 `before_agent_start` 注入钩子。`Injector` 接口收敛为 `steer(text, details?)`。

**理由**:实测延迟(2026-08-25 session JSONL 分析)——followUp 在主 agent 空闲时即时投递,但忙时攒批约 9 分钟才批量回放;nit 攒批要等下一次 before_agent_start,延迟无界。advisor 的价值在于帮主 agent 尽早收敛,迟到的建议毫无作用甚至是反作用(用户原话)。未投递消息随进程重启丢失可接受:advisor 是辅助,丢失不影响主 agent 工作(ADR-005 同构)。

**代价与缓解**:nit 现在也会打断主 agent 节奏;由 EmissionGuard 的 per-update 频率限制(nit 每 update 最多 1 条)+ `skipIf` + content-free 黑名单兜底。
