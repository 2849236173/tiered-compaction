<div align="center">

# tiered-compaction

**让上下文先被整理，再决定是否调用 LLM。**

DSH 的分层上下文压缩插件：折叠 → 落盘 → 驱逐 → 摘要，前三层不调用 LLM，只有压力真正到阈值时才进入摘要。

[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f7cff)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/stable-0.4.1-24b47e)](https://github.com/2849236173/tiered-compaction/releases)
[![License](https://img.shields.io/github/license/2849236173/tiered-compaction)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)

[简体中文](README.md) · [English](README.en.md)

<img src="docs/images/tiered-pipeline.svg" alt="四层分层压缩管线：折叠、落盘、驱逐、摘要" width="100%">

</div>

> 当前正式版：**0.4.1**。正式版适合日常使用；beta 版本可能包含新修复或新功能，但**未完全测试通过**。

## 30 秒看懂

普通压缩往往等到压力已经很高才一次性处理历史。`tiered-compaction` 把处理动作按成本从低到高排成四层：先做无损整理，再做可恢复的空间回收，最后才把 LLM 调用放在真正需要的位置。

| 层 | 发生什么 | LLM 成本 | 能否找回 |
|---|---|---:|---|
| **1 · 折叠** | 连续重复 3 次以上的行折叠成一行 | 0 次 | 原文语义不变 |
| **2 · 落盘** | 超过 8 KB 的工具输出存到本地，当前上下文只留预览和路径 | 0 次 | 存档可读回 |
| **3 · 驱逐** | 70% 提醒收束，80% 移除旧的可重跑工具结果 | 0 次 | 重跑原命令 |
| **4 · 摘要** | 压力到阈值（约 82%）时摘要较早的历史 | 1 次 | 摘要前原文存档 |

### 和“一次性摘要”有什么不同？

| | 一次性摘要 | `tiered-compaction` |
|---|---|---|
| 触发方式 | 压力高了才处理 | 从低成本层开始逐步处理 |
| 前三层 | 通常直接进入模型摘要 | 不调用 LLM |
| 工具输出 | 容易和对话历史一起挤占窗口 | 大结果先落盘，保留预览与路径 |
| 恢复方式 | 依赖摘要是否准确 | 存档读回或重跑原命令 |
| 宿主接入 | 等待官方默认策略 | 通过 DSH Bundle Patch 接入压缩链 |

## 它在 DSH 里长什么样

悬浮窗把当前上下文压力、实际 token 用量、三类无损/可恢复处理次数，以及距离下次摘要的距离放在对话旁边；设置页提供更详细的分层统计。

<div align="center">
<img src="docs/images/hud.png" alt="tiered-compaction 悬浮窗：上下文压力、token 用量和分层统计" width="760">
</div>

- 大号百分比是当前上下文占窗口的比例；右上角显示实际 token 用量和距下次摘要还差多少。
- 三张卡片分别统计折叠/落盘、驱逐、摘要的次数和省下的 token。
- 摘要进行中显示「正在摘要… Ns」。
- 会话空闲时，压缩会等下一条消息触发，悬浮窗会显示「下条消息时自动压缩」。

## 安装

插件分两档发布，选一个安装：

| 档位 | 适合谁 | npm 标签 |
|---|---|---|
| **正式版** | 希望稳定使用的大多数用户 | `latest` |
| **beta 尝新版** | 愿意尝试新修复、新功能并反馈问题的用户 | `beta` |

**安装正式版：**

```powershell
dsh plugin --profile desktop add dsh-tiered-compaction@latest
```

**安装 beta 版：**

```powershell
dsh plugin --profile desktop add dsh-tiered-compaction@beta
```

命令最后可能出现 `ERR_PNPM_IGNORED_BUILDS`。这是 pnpm 跳过了一个只打印提示的安装脚本，插件本身已经装好，可以忽略。

安装后完全退出 DSH 再打开，不需要手动改配置。Web、命令行、TUI 可以把 `desktop` 换成 `web`、`headless`、`tui`。

> beta 不一定比正式版新。正式版发布后，beta 标签可能还停在更早的版本；安装前可先查看两个标签：
>
> ```powershell
> npm view dsh-tiered-compaction dist-tags
> ```

## 让四层全部生效

DSH 的每个会话在创建时绑定一个预设，之后不能更换。只安装插件时，所有会话都有第 1、2 层，第 3、4 层仍使用官方压缩。要四层全部开启，需要把预设换成本插件的版本：

| 预设 | 开启方式 |
|---|---|
| `cordis`（桌面端默认） | 安装 `tiered-cordis-preset` bundle |
| `ptc-tc` | `tools/gen-ptc-tc.ps1 -Apply` |
| `standard`（Bot 和群聊使用） | `tools/gen-standard-tc.ps1 -Apply` |
| 官方 `ptc`、`minimal` | `tools/gen-standard-tc.ps1 -Preset ptc -Apply`，`minimal` 同理 |

修改后只有**新开的会话**会生效，已有会话保持原样。DSH 升级后需要重新运行一次生成器。

## 确认它在工作

在宿主日志中搜索 `tiered-compaction 健康`：

```text
tiered-compaction 健康 window=262144 pressure=57.3% ... status=ok
```

`status=ok` 表示正常；`status=warn` 后面会写明发现的问题。

## 更新、切换和卸载

更新和切换档位都使用 `add` 加标签，重新执行一次即可：

| 想做什么 | 命令 |
|---|---|
| 正式版升到最新正式版 | `dsh plugin --profile desktop add dsh-tiered-compaction@latest` |
| beta 版升到最新 beta | `dsh plugin --profile desktop add dsh-tiered-compaction@beta` |
| 从正式版切换到 beta | `dsh plugin --profile desktop add dsh-tiered-compaction@beta` |
| 从 beta 切回正式版 | `dsh plugin --profile desktop add dsh-tiered-compaction@latest` |
| 卸载并恢复官方压缩 | `dsh plugin --profile desktop remove dsh-tiered-compaction` |

不要使用 `update`：安装时记录的是确切版本号，`update` 不会跨过它升级，也不会在两档之间切换。

执行后完全退出 DSH 再打开。确认当前安装版本：

```powershell
dsh plugin --profile desktop list dsh-tiered-compaction
```

## 配置

所有字段都可选，不填写就使用默认值：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否接管压缩 |
| `auto` | `true` | 是否自动压缩；`false` 时只能手动 `/compact` |
| `archiveDir` | `~/.dsh/tiered-archive` | 存档目录 |
| `summaryTarget` | 跟随会话 | 摘要使用的 `provider` 和 `model` |
| `modelPolicies` | 无 | 按模型覆盖阈值和重试次数 |
| `scopeId` | 不填 | 预设挂载时使用，生成器会自动填写 |

## 已知限制

- 含图片或附件的工具结果不处理。
- 落盘预览固定为 5120 字符，完整原文在存档中。
- 当前按 DSH 0.2.x 的压缩接口实现；DSH 大版本升级后需要重新核对。

## 更多文档

- [架构与设计理念](docs/架构与设计理念.md) · [架构图](docs/架构图.html)
- 各层细节：[第 1 层](docs/第1层-无损折叠.md) · [第 2 层](docs/第2层-落盘.md) · [第 3 层](docs/第3层-软压力.md) · [第 4 层](docs/第4层-有损摘要.md)
- [更新记录](CHANGELOG.md)

## License

MIT
