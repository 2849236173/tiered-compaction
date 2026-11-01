**简体中文** | [![English](https://img.shields.io/badge/changelog-English-blue)](CHANGELOG.en.md)


# Changelog

本项目的重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-01

**档位：正式版 / 稳定版** —— 汇总 0.4.0-beta.1 到 beta.12 的全部改动。自动化测试全部通过（363 项，362 通过，1 项需真实会话的校验按设计跳过），悬浮窗新界面已在真实桌面端验收。各项细节见下方 beta 条目。

### 主要内容

- 四层压缩的计数、事件配对、单写者与多 realm 隔离等修复（beta.3 至 beta.8）。
- 官方 standard / ptc / minimal 预设一键换装本插件（`tools/gen-standard-tc.ps1`、`tools/gen-ptc-tc.ps1`）。
- 设置页与悬浮窗两入口界面重做：极光渐变进度条、渐变数字、真实字重字体栈、热替换后样式自愈（beta.9 至 beta.12）。

### 修复

- **补回 beta.2 的会话修复脚本**：`docs/修复/fix-compaction-turn.mjs` 换回遵守宿主首帧契约的重写版，同时补回它的契约测试 `test/repair-tool-contract.test.js`（9 项）。这两项在 beta.2 发布时只留在 `fix/repair-tool-contract` 分支，没有进入后续版本。

## [0.4.0-beta.12] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 悬浮窗字体渲染与动效优化。新样式还没有在真实桌面端完整验证。

### 变更

- **字体**：悬浮窗统一使用 Segoe UI Variable / Segoe UI，中文回落到微软雅黑 UI；开启 `font-synthesis: none` 禁止浏览器伪粗体；只使用系统真实存在的 400 / 600 / 700 字重；最小字号从 10px 提到 11px，减轻中文小字发虚。
- **颜色**：大号百分比数字改为随档位变化的流动渐变文字；统计卡片数字改用 Display 字体；token 用量改为主文字色，层次更清楚。
- **动效**：百分比和卡片计数在数值变化时弹入；悬浮窗加入跟随鼠标的柔光聚光灯；去掉根节点 `overflow: hidden`，进度条光晕不再被裁掉。

## [0.4.0-beta.11] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 修复宿主热替换移除 `<style>` 导致真机样式与动画丢失的根因，并将已用 token 进度条升级为极光炫彩流光条 + 前沿脉冲光珠。新样式与动效还没有在真实桌面端完整验证。

### 修复

- **真机热更新后 `<style>` 被宿主清除导致渲染与动效全部失效**：宿主 `client-modules` 在模块 `replace` 阶段会调用 `removeOwnedStyles(id)` 删除插件 `<style>` 标签，而样式注入若仅在 `apply` 执行一次会出现样式丢失、退回无动画内联裸盒子的现象。现在在模块 `factory`、`OverlayHud` 与 `StatusPanel` 渲染入口均执行幂等的 `ensureUiStyles()` 自愈补齐。

### 变更

- **极光炫彩已用 token 进度条与流光动效**：进度条升级为青/蓝/紫/霓虹粉多层动态极光渐变（`aurora` 2.8s 循环流动）+ 镜面扫光（`shimmer`）+ 右端前沿呼吸光珠（`spark`）；悬浮窗顶沿新增 2px 极光呼吸灯带，三张统计卡片顶部配备幻彩流光指示线。
## [0.4.0-beta.10] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 重做悬浮窗表面材质、一体式三栏统计舱与进度条流光动效，并修复热加载不刷新 `<style>` 的问题。新样式与动效还没有在真实桌面端完整验证。

### 修复

- **热加载不刷新悬浮窗样式**：`ensureUiStyles()` 原先检测到已有 `<style>` 节点就直接返回，导致版本升级热加载后新 DOM 套在旧 CSS 上。现在会原地更新 `<style>` 文本并升级样式标识为 `v3`。
- **深色模式下悬浮窗泛白雾与浅色模式下死灰底**：移除内联硬编码的 `--dsw-alias-bg-module-platform` 实心灰底和用 `--dsw-alias-label-primary` 计算的阴影，改用与对话区输入框同源的 `--dsw-specific-input-major` 半透明毛玻璃材质（`--dsw-menu-backdrop-filter`）。

### 变更

- **极简一体式质感与流光动效**：三项统计改为一体式三栏内嵌数据舱；标题栏视觉隐藏 `tiered-compaction ` 英文包名前缀，直接显示「分层压缩」；进度条加入零位弹簧展开、斜向液态流光扫掠与微光晕，左上角状态指示灯加入水波纹呼吸光环，统计栏加入错峰入场与顶部流光指示条。
## [0.4.0-beta.9] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 只改了悬浮窗外观，数据和压缩逻辑没变。新样式还没有在真实桌面端的深色主题下完整验证。

### 变更

- **悬浮窗重新排版**：压力百分比放大放在压力条上方，右侧两行显示用量和「距摘要 ≈ N」；三项统计改为并排的三张卡片（名称、次数、省下的 token）；底行左边「共省」、右边「上次摘要」。
- **细节**：压力条去掉下方多出的灰带，刻度线变细并加描边，80% 和 82% 两条线更好区分；收起和关闭按钮统一尺寸并有悬停效果；状态正常时标题栏不再显示「状态 ok」。
## [0.4.0-beta.8] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 修了第 3 层误驱逐和重启后计数归零，悬浮窗改版，官方 ptc / minimal 预设也能用全四层。悬浮窗和预设覆盖还没有在真实桌面端完整验证。

### 修复

- **第 3 层把刚读到的工具结果驱逐掉**：压力过 80% 时，驱逐会连带本轮刚产生的 `read` / `grep` 结果，模型下一步就看不到刚读的内容。现在最近 2 轮的工具结果不参与驱逐。读不到轮次信息时沿用旧行为。
- **计数每次重启都从 0 开始**：会话计数原来只在内存里，重启后悬浮窗和状态 API 都显示 0。现在第一次见到会话时从会话日志回填：摘要次数和节省量、驱逐次数和节省量、折叠/落盘的合计次数和节省量。官方 pruner 写的记录不计入。日志里分不出折叠和落盘，所以这两层只回填合计。
- **重启后健康检查误报「压力 ≥80% 但第 3 层零驱逐」**：上一条修复之后，观察者还没登记的会话也按日志回填，不再误报。

### 变更

- **悬浮窗**：L1–L4 改为「折叠/落盘」「驱逐」「摘要」三行，每行显示累计次数和大约省下的 token（例如 `驱逐 476 · 省 316k`）。用量行增加「距摘要 ≈ N」，底部新增一行「共省 ≈ N · 上次摘要 N 分钟前」。设置页里的「L1+L2 合计」改为「折叠+落盘合计」。
- **预设**：`tools/gen-standard-tc.ps1` 新增 `-Preset standard|ptc|minimal`，可以把官方 ptc 和 minimal 的压缩引擎原地换成 tiered-compaction。每个预设在 profile 补丁里有独立的标记区块，删掉区块即可回退。
- **README**：去掉 GitHub 安装方式，新增「选哪个预设」一节。

## [0.4.0-beta.7] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 修复了压缩提交阶段整轮对话失败的问题。

### 修复

- **压缩报 `format v4 message requires a producer-owned source kind`，整轮对话失败**：与 beta.6 同源。插件从 `@deepseek-ai/dsh-compaction` 导入 `compactCheckpointSource`，但本包不声明这个依赖，运行时按 Node 规则向上解析，在部分机器上落到 `~/.dsh/profiles/node_modules` 里指向全局 CLI 版 dsh（0.1.0-rc.7）的副本。它给检查点消息打的是 `{kind:"plugin",plugin:"compact"}`，而桌面宿主（0.2.1-rc.2）的会话格式 v4 只接受 `{kind:"compact-checkpoint"}`，写入被拒，压缩事务失败，这一轮对话也跟着失败。现在插件自带实现，并按当前会话的 `session.header.version` 选择写法：v4 及以上写 `compact-checkpoint`，更早的格式写 `plugin`/`compact`。不依赖任何安装路径，也不绑定某一代宿主。补了回归测试。

## [0.4.0-beta.6] - 2026-11-01

**档位：beta / 尝新版（未完全测试通过）** —— 修复了 beta.4/beta.5 第 4 层压力摘要从不成功的问题；真实桌面上的第 4 层摘要尚待验证。

### 修复

- **第 4 层压力摘要报 `Cannot read properties of undefined (reading '<seq>')`**：插件从 `@deepseek-ai/dsh-compaction` 导入配对检查函数，但本包不声明这个依赖，运行时按 Node 规则向上解析。在部分机器上会解析到 `~/.dsh/profiles/node_modules` 里指向全局 CLI 版 dsh（0.1.0-rc.7）的副本，它按 `session.events[seq]` 读事件；桌面宿主（0.2.1-rc.2）的 Session 没有 `events`，于是每次都抛错，钩子降级跳过，自动摘要一次都没执行。现在改用插件自带的配对检查，只用两代宿主都有的 `session.eventAt`。补了回归测试，并确认 rc.7 的实现在同样的会话形状下会抛同一个错误。


**档位：beta / 尝新版（未完全测试通过）** —— 诊断版，只加日志、不改压缩逻辑。

### 已知问题（正在定位）

- beta.4 装到真实桌面后，第 1-3 层与自动检查都在运行，但第 4 层压力摘要在约 82% 以上时报 `pressure 钩子失败，继续步进：Cannot read properties of undefined (reading '<seq>')`，报错的 seq 是表面开头的 system 消息。钩子失败不会阻断对话，但第 4 层自动摘要不会执行；压力高时请手动 `/compact`。离线用宿主真实 `Session` 重放会话快照无法复现。

### 变更

- 压力钩子失败时，额外以 warn 级别记录堆栈前 6 帧（宿主日志不收 debug 级），用来定位上面的问题。

## [0.4.0-beta.4] - 2026-10-31

> ⚠️ 已知问题：第 4 层压力摘要在真实宿主中报错不执行，见 0.4.0-beta.5。

**档位：beta / 尝新版（未完全测试通过）** —— 自动化测试通过；自动压缩钩子的修复已有基于真实 cordis 代理的回归测试，但真实桌面环境与新界面尚待验证。**使用 beta.3 的用户请尽快升级。**

### 修复（严重）

- **修复 beta.3 自动压缩完全失效**：beta.3 新增的多 realm 归属判断把宿主 `agentPresets.serviceFor` 的返回值与自身做 `===` 比较，但经 cordis 服务代理调用时返回值会被再包一层代理，结果永远不相等。所有实例都判定「会话不归我」，第 3、4 层压力压缩与溢出恢复都不再执行，压力涨到 98% 也不压缩，最终报 `CONTEXT_WINDOW_EXCEEDED`。现在比较前先剥掉代理。补了一项用真实 cordis Service 注册表的回归测试（修复前失败、修复后通过）。第 1-2 层与手动 `/compact` 不受这个问题影响。
- **修复手动 `/compact` 后会话重开报损坏**：`compaction/summary` 事件漏写了 `sourceCommandId`，宿主恢复校验要求它与 `compaction/start` 一致，否则报 `compaction/summary has no matching compaction/start`。只影响带命令 ID 的手动压缩，自动压缩不受影响。已有会话需要用修复脚本补齐该字段。

### 变更（界面数据口径）

- 摘要次数、最近一次摘要、「自 HH:mm 起」改为按**本会话**统计；进程合计另行给出。
- 节省量按层、按 UTF-8 字节统计（折叠、落盘分开），驱逐与摘要给出估算 token 节省；旧版「落盘」行下的数字实际是 L1+L2 合计字符数，已更正。
- 状态接口新增 `currentTokens` 之外的 `autoCheckedAt`：界面据此判断自动压缩是否真的在运行，压力高而长时间未检查时提示手动 `/compact`。

### 新增（界面）

- 悬浮窗：关闭后可从角落小按钮或设置页找回；显示实际用量（已用 / 窗口 tokens）；四层活动迷你行；可收起成小胶囊；压缩发生后显示回落提示与动画（遵守「减少动态效果」设置）。
- 设置页：总节省、最近一次摘要详情、显示悬浮窗开关。

## [0.4.0-beta.3] - 2026-10-31

> ⚠️ **已知严重问题：自动压缩不触发，请升级到 0.4.0-beta.4。**

**档位：beta / 尝新版（未完全测试通过）** —— 自动化测试通过，但尚未完成真实桌面环境与真实 LLM 摘要链路验证；请愿意尝鲜并能反馈问题的用户试用，求稳请留在稳定版。

### 修复（会损坏会话 / 安全）

- **修复并发写入导致会话无法重新打开**：多个 preset 挂载时 observer 只保留一份；落盘等待期间若目标工具结果已被驱逐或替换，会在写入前跳过，避免留下悬空 prune。observer 只处理 append 事件，不再二次加工宿主 pruner 的替换结果。
- **限制 `tiered_restore` 读取范围**：只允许回读存档目录内的普通文件；拒绝符号链接和目录穿越，错误不再回显实际文件摘要。
- **避免跨会话串用存档**：预览与谱系按会话隔离；折叠与落盘同时命中时只写一份存档。
- **原子写入归档**：先完整写入临时文件并同步，再放置为最终文件；同名归档不覆盖。清洗 Windows 非法字符与保留文件名。
- **状态接口不再暴露本机归档目录绝对路径**，改为返回 `hasArchiveDir`。

### 修复（功能）

- **改进 `/compact` 和自动溢出恢复**：agent 忙时返回 `busy`；取消归类为 `cancelled`；修复 `maxOverflowRetries > 1` 不生效；将命令 ID 写入事务事件与检查点。
- **自动钩子开关生效**：`auto: false` 现在会阻止注册压力与溢出自动压缩钩子，`/compact` 手动入口仍可用。
- **摘要失败退避**：连续失败后暂缓重复 LLM 调用；成功后清零。未知上下文窗口时跳过自动压力路径，不再假定窗口为 128k。
- **改进摘要质量**：采用结构化检查点指令，并在 overflow / `/compact` 时保留最新用户消息及其后的内容。
- **修正摘要校验与事务收尾**：按完整检查点估算大小，验证 token-meter 节点顺序；结束事件不重复写入，失败事务尽力落盘。
- **状态 UI 两个入口共享同一份按会话统计**：每 5 秒刷新，页面隐藏时暂停；修复 L1/L2 与 L3 计数口径。

### 变更

- **多 realm 结构调整**：compaction 服务按 `scopeId` 每个 realm 一份；观察者进程级唯一。新增可选字符串配置 `scopeId`，并导出 `Config` 做配置校验。标准 preset 和 ptc-tc 生成器会写入对应 scope，并合并已有配置。
- **默认 cordis preset**：需安装配套本地 bundle `tiered-cordis-preset` 才会在该 preset 中启用本插件；安装后新会话生效。该 bundle 会整体覆盖 cordis preset，升级 DSH 后需检查并同步其插件清单。
- **npm 包收窄为运行代码与发布文档**：不再包含 `test/`、`docs/`、`tools/`、`scripts/`。
- **回读摘要**：`tiered_restore` 现接受 16 位 SHA-256 前缀或完整 64 位摘要。

### 已知问题与未验证项

- `goal-switch` 旁路尚未接入宿主调用链；归档目录没有自动清理上限；超大工具输出仍可能带来较高内存峰值。
- 未完成真实桌面 UI 与真实 LLM 摘要链路验证；已有会话可能需要新开会话才能使用更新后的 preset 结构。
- 生成器仅完成语法验证，未对真实 profile dump 执行 `--diff-only`；使用 `-Apply` 前应先运行 `--diff-only`。
- 当前发布级别为 beta / 尝新版（未完全测试通过），不应视为正式稳定版。

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
