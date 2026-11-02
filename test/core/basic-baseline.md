# basic 基线行为记录（A6 依赖）

> 用途：M5 按 A6 验证「enabled=false 时本插件行为与纯 basic 一致」的对照物。
> 依据：`G:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js`
> （0.2.1-rc.2）通读事实，非猜测。记录时间：2026-10-26。

## 触发策略（BasicCompactionEngine）

- 压力读数：`ctx.tokenMeter`（依赖注入 `static inject`），surface 与 session 对齐，
  meter 读数与 session surface 不一致即抛 `SurfaceChangedError`。
- 触发线：`thresholdTokens = contextWindow − reservedCompletionTokens − headroomTokens`，
  其中 `reservedCompletionTokens` 来自请求 `maxTokens`，`headroomTokens` 默认 65,536。
- 触发时机（`auto` 默认 true 时注册自动压缩）：
  1. step 边界压力（replay-aware）；
  2. provider 确认的 context overflow（失败后从替换面重试一次）；
  3. 手动/空闲会话压缩（idle，要求无 open turn、无排队唤醒）。
- 保留策略：`retainRatio` 默认 `DEFAULT_RETAIN_RATIO`（或显式 `retainTokens`），
  要求 `retainTokens < thresholdTokens`。
- 摘要：`summarizeWithLlm` 走当前路由（或 summarizationProvider/Model 显式配置），
  `maxTokens: config.maxTokens`（默认=headroomTokens）——**预算即 headroom，非独立预留**，
  这是 2,048 截断观测的候选根因层（M4 附录第 3 问的定性：截断在插件可控范围）。
- 持久化：压缩事务以 `compaction/start`、`compaction/summary`、`compaction/end`
  会话事件落地，未配对 start 由构造 seed 兜底；并发压缩用 durable 锁拒绝（busy）。

## 并存对照基线（本插件 enabled=false 时的预期）

| 行为面 | basic 独跑 | 本插件 enabled=false | 一致性依据 |
|---|---|---|---|
| ctx.compaction 服务位 | BasicCompactionEngine | 不触碰（只注册 tieredCompaction 自检服务） | M2 附录 A 结论 2 |
| 触发/保留/摘要 | basic 自有策略 | 不注册 compaction 服务，basic 照常 | 服务位替换语义 |
| 会话事件流 | compaction/start-summary-end | 无新增压缩事件 | 不接管即不产事件 |
| token-meter 读数 | 连续 | 不介入读数 | 只读旁路 |

## A6 验证方法（M5 执行）

1. 同一 fixture 会话：先只装 basic 跑一遍记录事件流与 token 读数；
2. 装 basic + 本插件（enabled=false）再跑一遍；
3. 断言：两轮事件流逐条一致、token-meter 读数曲线一致、开关反复切换会话不崩。
