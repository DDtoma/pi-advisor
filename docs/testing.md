# 测试策略

> 原则:**核心子系统(`src/advisor/`)在无 pi 环境下 100% 可单测**(ADR-001)。胶水层(`src/pi/`)与组合点(`extensions/`)靠真实 pi 会话的端到端脚本验证。

## 1. 测试栈

- 运行器:Node 内置 `node:test` + `node:assert/strict`(零依赖,与 ADR-007 的零依赖分发策略一致)
- 命令:`npm test` → `node --experimental-strip-types test/run.ts`(Node ≥ 22 直接跑 TS;低版本退回 `tsx`)
- mock 风格:手写 fake(实现 `DeltaSource`/`ModelCaller`/`Injector` 接口),不引入 mock 框架

## 2. 分层

### 2.1 单元测试(`test/*.test.ts`,CI 必跑)

| 文件 | 覆盖目标 | 关键用例 |
|---|---|---|
| `secrets.test.ts` | `SecretScrubber` | 每类正则正反例;跨轮值收集一致性;FIFO 淘汰;reset |
| `cursor.test.ts` | `sliceBranch` | 增量切片;长度回缩 reset;**原位变异 reset**(改内容不改长度);advisory 条目跳过但游标不漂移;指纹复用不重复计算 |
| `formatter.test.ts` | `renderDelta` | 三种 role;thinking 丢弃(ADR-008);6000 字符截断尾标;toolCall/toolResult 格式;scrubber 被调用且输出无原文;空 delta |
| `emission-guard.test.ts` | `EmissionGuard` | 38 短语逐条命中;normalize 等价类;4096 FIFO;nit 频率;concern/blocker 不限频;beginUpdate 重置 per-update 状态 |
| `config.test.ts` | YAML 子集解析 + schema 校验 + 合并 | 全字段正例;每类校验错误(含行号);块字符串保留换行;slug 冲突拒载;项目级覆盖全局 |
| `engine.test.ts` | `runWithTools` 工具循环 | text 直接结束;advise 收集后结束;read→grep→advise 三轮链;8 轮上限;toolResult 截断 2000;executor 抛错回灌为 isError 结果而不是炸循环 |
| `tools.test.ts` | 只读工具白名单 | 五工具正例;bash 拒绝矩阵(`>`、`rm`、`mv`、`tee`、`sed -i`、`chmod`、`dd`、`mkfs`);路径逃逸(`../`)拒绝;read 行截断 |
| `runtime.test.ts` | `AdvisorRuntime` 状态机 | drain 单飞;coalesce;reset 传播(revision/epoch);失败分类四分支与退避序列(1s→2s→4s,用 fake timers 或注入 sleep);连续失败熔断;EmissionGuard 集成;mock 任意抛错不逃出 drain |
| `roster.test.ts` | 发现/合并/实例化 | mock fs 的两级发现;slug 冲突;`now` 忽略 focus;`reset` 清 latch;usage 汇总 |

### 2.2 Fake 实现(`test/fakes.ts`)

```ts
class FakeDeltaSource implements DeltaSource {
  constructor(public branch: SessionEntryLike[]) {}
  slice(cursor: Cursor) { /* 复用真 cursor 逻辑,但可编程注入 resetDetected */ }
}

class FakeModelCaller implements ModelCaller {
  script: CompleteResult[] = [];          // 每次 complete 弹一个;空了抛错(测试编排错误)
  calls: CompleteRequest[] = [];
  async complete(req) { this.calls.push(req); return this.script.shift()!; }
}

class FakeInjector implements Injector {
  steered: { text: string; details?: unknown }[] = [];
  steer(text: string, details?: unknown) { this.steered.push({ text, details }); }
}
```

**编排风格**:每个 runtime 测试都是"喂 branch → 喂 model 脚本 → 断言 injector 收到了什么"。这正是 ADR-001 解耦的红利。

### 2.3 端到端(`test/e2e/`,手动触发,不进 CI)

真实 pi 会话脚本(`test/e2e/README.md` 记录步骤):

1. **happy path**:fixture 项目放 WATCHDOG.yml(Security)→ `pi -e extensions/index.ts` → 主 agent 写 SQL 拼接 → 断言 concern/blocker 注入出现
2. **失败传染**:把 advisor 的 model 指向无效 provider → 主会话继续正常使用 → `/advisor status` 显示 halted
3. **compact 后恢复**:长会话触发 `/compact` → advisor 游标 reset → 下一轮正常工作
4. **安装形态**:`pi install` 与 `pi -e` 各跑一遍 happy path

## 3. Fixtures(`test/fixtures/`)

| 文件 | 内容 |
|---|---|
| `watchdog-valid.yml` | 全字段合法样例(2 个 advisor,覆盖 focus/ignore/tools/per-N-turns) |
| `watchdog-invalid-*.yml` | 每类校验错误一个文件(slug 重复/非法 model/prompt 超预算/非法 glob/bad version) |
| `watchdog-global.yml` + `watchdog-project.yml` | 合并语义验证(同 slug 覆盖) |
| `branch-samples.ts` | 导出手写的 `SessionEntryLike[]`:user/assistant/tool/advisory 混合、含 thinking 块、含 secret 文本 |

## 4. 覆盖率目标

- `src/advisor/`:行覆盖 ≥ 90%,`runtime.ts` 与 `emission-guard.ts` 要求 100% 分支覆盖
- `src/pi/` 与 `extensions/`:不设覆盖率目标(由 e2e 背书),但每个文件 ≤ 80 行约束写入 review checklist
- 测量:`node --experimental-strip-types --experimental-test-coverage test/run.ts`

## 5. 回归规则

1. 任何 bug 修复必须附带复现测试(先红后绿)
2. pi 升级后,先跑 api-verification.md §9 核对清单,再跑全量测试,最后跑 e2e happy path
3. oh-my-pi 上游 emission-guard 短语表有更新时,同步拷贝并更新 ADR-009 的拷贝日期
