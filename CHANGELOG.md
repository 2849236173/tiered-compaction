# Changelog

本项目的重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-28

**装完即生效**：不再要求安装后手工改配置。

### 变更

- **默认接管压缩**：`enabled` 默认值从 `false` 改为 `true`。装上就是启用的，要与官方 basic 并存时才需要显式关闭。
- **patch 自动停用 basic**：插件自带的 `cordis.patch.yml` 现在同时做两件事——停用 `dsh-compaction-basic`（让出 `compaction` 服务位）与启用自己。此前只插入一个关闭状态的自己，用户必须手工改两处才能用。
- **存档目录默认值**：`archiveDir` 默认 `~/.dsh/tiered-archive`，自动创建。此前不配置会整层静默跳过第 1、2 层。

### 修复

- 落盘预览预算对齐官方 pruner：上限从 1500 提到 5120 字符，头尾比从 1:2 改为 4:1（对齐 `headChars 4096` / `tailChars 1024`）。此前的 1500 比官方少 3.4 倍可见上下文。
- 纯空白摘要拒绝提交（`summary.trim()` 判定，此前 `"   "` 会被放行并覆盖原文）。
- 选区包含 system 头节点时不再重复投影（重复会破坏前缀顺序，导致 KV 缓存失效）。
- 摘要 token 估算只跳过消息列表最前那条 system 头，选区内 system 计入分母（此前全跳过会让正常摘要被误拒）。

### 文档

- README 重写为使用者视角：用途 → 四层 → 安装 → 配置 → 状态。
- 新增架构图（交互式）与四层分册、数据结构文档。

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
- 压力读数改从 `request/context` 事件取窗口（真实 `TokenMeter` 没有 `contextWindow()` 方法）。
- 摘要改走 `ctx.llm.stream()`（真实 llm 服务没有 `summarize` 方法）。
- 去重集合改为按会话隔离（旧实现是进程级 Set，第一个会话之后压缩静默失效）。
- 观察者去重标记在 await 之前占位，消除并发重复替换的竞态。
- 排除自身写回的替换事件，杜绝无限递归导致的 OOM。

### 已知限制

- 契约层对齐 DSH 0.2.x 的 `CompactionEngine` 接口，宿主大版本升级后需重新核对方法面。
- 只处理纯文本工具结果；含图片/附件的富块一律跳过。
- 压力读数依赖 `request/context` 事件，缺失时退回保守路径。

[0.3.0]: https://github.com/2849236173/tiered-compaction/releases/tag/v0.3.0
[0.2.0]: https://github.com/2849236173/tiered-compaction/releases/tag/v0.2.0
