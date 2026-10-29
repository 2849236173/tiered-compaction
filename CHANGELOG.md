**简体中文** | [![English](https://img.shields.io/badge/changelog-English-blue)](CHANGELOG.en.md)


# Changelog

本项目的重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-10-28

**自身审计修复**：对 22 个同类插件做源码级对比时，反过来查出本插件三处
「看着在跑、实际没做」的静默失效，以及一处只有测试在调的死代码。

### 修复

- **`restoreSpilled()` 是死代码 → 接成 `tiered_restore` 工具。**
  此前全库零调用点，只有测试在调。也就是说「原文 100% 落盘可读回」这句话，
  实际靠的是模型用通用 `read` 工具直接读文件，那套 SHA-256 校验永远不跑。
  现在模型可以按存档路径 + 摘要读回原文，校验不通过一律抛错不返回内容
  （读到坏内容比读不到更危险）。

- **阈值夹取无痕 → 留痕。** `dsh-session-manager` 这类插件会直接写
  `engine.config.thresholdRatio`（滑块 17%–90%），而本插件把值夹到
  `[0.82, 0.95]`，导致 65% 的滑块行程是死区且零反馈。现在夹取会打一条
  去重告警，说明原值、生效值、以及为什么有这个区间。

- **摘要改道无痕 → 留痕。** 摘要请求带 `purpose: "compaction"`，
  `dsh-auxiliary` / `dsh-compact-selected-model` 会按它把请求改派到别的
  模型。改道本身不是 bug，但现在会记录实际目标 provider/model，
  否则「为什么这次摘要质量变了」无从排查。

### 新增

- **preset 共存检测。** 在 preset 架构（web / desktop）下，每个会话的
  agent 跑在 preset 自己的 `isolate` realm 里，realm 内有一份独立的
  `compaction` 服务。插件自带的 cordis patch **只能停用 root 平面那份**
  `compaction-basic`——因为宿主 `buildMap` 只递归 `group && Array.isArray(config)`，
  而 preset 的插件列表躺在 `agentPreset.config.plugins` 这个对象字段里。
  现在加载时会枚举 preset，凡是自带 `compaction` 组的都会告警，明确说
  「若你的会话正在使用这些 preset，实际压缩由 preset 内引擎执行」。
  这条不试图自动修复（改写别人 preset 的 config 风险高），只把静默变可见。

## [0.3.0] - 2026-10-28

**装完即生效**：不再要求安装后手工改配置。

### 变更

- **默认接管压缩**：`enabled` 默认值从 `false` 改为 `true`。装上就是启用的，要与官方 basic 并存时才需要显式关闭。
- **patch 自动停用 basic**：插件自带的 `cordis.patch.yml` 现在同时做两件事——停用 `dsh-compaction-basic`（让出 `compaction` 服务位）与启用自己。此前只插入一个关闭状态的自己，用户必须手工改两处才能用。
- **存档目录默认值**：`archiveDir` 默认 `~/.dsh/tiered-archive`，自动创建。此前不配置会整层静默跳过第 1、2 层。

### 修复

- **严重：写出的会话文件会损坏，下次加载报 `compaction turn must be a non-negative safe integer`。**
  `compaction/start` 与 `compaction/end` 的 `data` 里缺 `turn` 字段。宿主 v4 会话格式要求该字段必须是非负安全整数，且等于当前打开的 turn（`dsh-session-format-v3-to-v4` 的 `Relationships.compact`）。缺失时写入不报错，**读取时才判定会话损坏**，整个群/会话的历史因此加载失败。
  修法：新增 `openTurnOf(session)`——从事件流尾部反向查找最近的 `turn/start` 取 `turn` 值，写进两条 compaction 事件的 `data`。触发过该问题的旧会话需要用修复脚本补字段（见 `docs/` 说明）。
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
