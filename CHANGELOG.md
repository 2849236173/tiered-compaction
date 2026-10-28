# Changelog

本项目的重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-28

首个公开版本。

### 新增

- **四层递进压缩管线**：无损折叠 → 落盘 → 软压力 → 有损摘要。前三层零 LLM 成本，只有真到阈值才动用一次带预算预留的摘要。
- **保真三原则**：每层留恢复机制、被取代引用记谱系、压缩系统自带熔断器与仲裁器。
- **宿主契约层**：`TieredCompactionEngineService extends CompactionEngine`，实现 `compactNow` / `compactIfNeeded` / `compactRegion` 三入口与 `summarize` 覆写，返回形状与官方 basic 逐字段对齐。
- **工具结果观察者**：通过 `session/event` 钩子把第 1-3 层接到真实宿主，按官方 pruner 的「影子定价 → surfaceOp replace」两步范式落地。
- **目标切换旁路**：显式宣告新目标时打包 todo/goal/plan 胶囊、归档过程内容，全程零 LLM。
- **槽位探测与降级**：construction-catch 探测 `compaction` 服务位，被占时自动降级为「仅第 1-2 层」旁路模式。
- **谱系表**：任何取代关系可查「原位置 → 新位置 → 取代者」三元组。
- **熔断器 + 仲裁器**：单层连续失败自动降级跳层，主流程绝不被阻断；一份内容只归一层处理。

### 修复

- 落盘阈值按 UTF-8 字节数判定（原按 JS 字符数，中文场景会漏落盘）。
- 压力读数改从 `request/context` 事件取窗口（真实 `TokenMeter` 没有 `contextWindow()` 方法，旧写法导致压力恒 0、阈值算成负数）。
- 摘要改走 `ctx.llm.stream()`（真实 llm 服务没有 `summarize` 方法）。
- 去重集合改为按会话隔离（旧实现是进程级 Set，按 seq 记账——第一个会话之后压缩静默失效）。
- 观察者去重标记在 await 之前占位，消除并发重复替换的竞态。
- 排除自身写回的替换事件，杜绝无限递归导致的 OOM。
- 落盘预览预算对齐官方 pruner（头尾 4:1，5120 字符上限）。

### 已知限制

- 契约层对齐 DSH 0.2.x 的 `CompactionEngine` 接口，宿主大版本升级后需重新核对方法面。
- 只处理纯文本工具结果；含图片/附件的富块一律跳过。
- 压力读数依赖 `request/context` 事件，缺失时退回保守路径。

[0.2.0]: https://github.com/2849236173/tiered-compaction/releases/tag/v0.2.0
