**简体中文** | [![English](https://img.shields.io/badge/changelog-English-blue)](CHANGELOG.en.md)


# Changelog

本项目的重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0-beta.2] - 2026-10-30

**档位：beta / 尝新版（未完全测试通过）** —— 本次只改开发工具链与发版脚本，
不触碰 `src/` 运行时压缩逻辑；自动化测试全绿，但未做生产环境浸泡。
求稳可直接留在 0.3.x 稳定版。

### 修复

- **生成器硬编码旧包名，导致 preset 挂载失败、会话 resume 报错**：`tools/gen-standard-tc.mjs` / `tools/gen-ptc-tc.mjs` 里写死了 `@local/dsh-tiered-compaction`，而包自 0.2.0 起已去 scope（npm 上叫 `dsh-tiered-compaction`）。名字解析不到时，cordis loader 的 `Entry._init` 把 import 失败吞成 `logger.error`，`agent-preset-registry` 只报 `tiered-compaction (@local/dsh-tiered-compaction): never started`，随后 `mountPreset` 抛错、整个会话 resume 失败（`gateway/internal: resume failed for session ...`）——错误链里看不到真因。
  - 新增 `tools/lib/plugin-name.mjs`：包名一律从「实际装了什么」推导（`dsh.profile.bundles` → `dependencies` → `dsh --dump-config` 兜底），并校验解析结果与包自报 `name` 完全一致。
  - 两个生成器改为通过 `--profile-dir` 注入 profile 路径，产物写盘前过 `assertNoStaleScopeNames` 护栏，杜绝再次写死 scope。
  - 新增 `tools/check-install.mjs`：一条命令自检 profile 补丁里的插件名能否解析；换安装来源（npm ↔ 本地软链）后即可验证。`files` 现已包含该命令与 `tools/lib/`，装完即可自查。
  - 两个 `.ps1` 写回后自动跑自检，不通过即报错退出，不再「静默写坏」。

## [0.4.0-beta.1] - 2026-10-29

**档位：beta / 尝新版（未完全测试通过）**——自动化测试 246 项全绿、病案
现场根因闭环；守卫语义按「任何 GitHub / npm 用户的任意挂载组合」设计并
附带混合互斥收敛测试，但尚未经过生产环境长跑观察；求稳可暂留 0.3.x
等正式版。

### 新增

- **D24 单写者守卫（`src/single-writer-guard.js`）**：全进程内最多一个
  「会写归档 / 会产 prune」的活跃族群。第二处挂载自动降级为纯自检服务
  （无观察者、不写盘）并在日志鸣笛。采用 `Symbol.for` 全局座位表，
  抗多副本加载（旧 tarball 与 link 目录并存同样受保护）；支持 realm 作用域
  （preset 组挂载传 `scopeId` 分座）；**global 与 realm 互斥混居**——
  无论用户从 GitHub / npm 以何种挂载组合安装（根平面 + preset 并挂、
  多 preset、多副本），最终都收敛为「恰一个全局写者」或「若干 realm 写者」，
  杜绝同一会话流出现两个 prune 来源。逃生阀 `DSH_TC_ALLOW_MULTI_ENGINE=1`
  （调试双写病理用）。

- **防抹除 tripwire（`test/d24-single-writer.test.js`，随 npm 包分发）**：
  直接读 `src/index.js` 源码断言守卫仍在接线链路上（导入存在、申请先于
  接管路径、`detach` 归还席位）。将来任何更新把守卫整包替换掉，
  `npm test` 当场红灯，杜绝静默回退。`package.json` 的 `files` 白名单
  已纳入 `test/`，并新增 `postinstall` 自检（守卫文件缺失时安装即告警）。

### 面向 GitHub / npm 用户的保障边界（诚实声明）

- **能保证**：同一进程内无论怎么挂（根平面 + preset 并挂、多 preset、
  多副本并存），都会收敛为单一写者；守卫与 tripwire 随包分发
  （`files` 含 `src/` 与 `test/`，pack 仿真 59 个 JS 文件零缺失）。
- **不保证**：跨进程的多开（同一台机同时跑两个 DSH 实例共用同一
  sessions 目录）不属于本守卫管辖范围——那是宿主层的话题，README
  会提醒此类部署避免共享会话目录。

### 修复

- **双装配双写导致会话归档损坏（病案 2026-10-29）**：root 平面（bundle
  清单自动装配）实例与 preset realm 实例同时观察同一条会话事件流，各自
  对同一批工具结果发 `compaction/prune`；第二枚落盘时目标已换出 surface，
  宿主冷重放校验抛 `SessionFormatError: compaction/prune shadowedSeqs do
  not name an exact current surface span`，会话从此打不开。守卫落地后，
  多挂载点自动收敛为单写者；配合 profile 侧把 root 实例
  `enabled: false`（cordis.patch.yml D24 区块）双层防線根治。

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
