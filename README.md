# tiered-compaction

**DSH 分层上下文压缩插件** —— 用四层递进替代一次摘要。

DSH 默认压缩在上下文到阈值时调一次 LLM 摘要、整段换掉历史。做法简单，但代价明确：每次压缩都是一次完整 LLM 调用；摘要受输出 token 上限约束；长内容的中段最先丢。

本插件把压缩拆成四层，前三层零 LLM 成本吃掉大部分体积，只有真正触阈值才动用一次带预算预留的摘要。

## 四层管线

| 层 | 做什么 | 成本 |
|---|---|---|
| **1 · 无损折叠** | 连续重复行（≥3 次）折叠为「首行 + `…[folded Nx]`」，附逆变换记录 | 零 LLM |
| **2 · 落盘** | 超过 8KB（UTF-8 字节）的工具输出整体存档，上下文只留头尾预览 + 路径 + SHA-256 | 零 LLM |
| **3 · 软压力** | 70% 窗口插入提醒；80% 按优先级驱逐可重放内容 | 零 LLM |
| **4 · 有损摘要** | 到阈值才调 LLM 摘要，预算提前预留，摘要前全量存档 | 1 次 LLM |

另有**旁路**：目标切换清理——显式宣告新目标时，把旧目标的 todo/goal/plan 打包成结构化胶囊，过程内容归档，零 LLM。

## 为什么敢做有损操作

三条约束贯穿所有层：

1. **每层留恢复机制** —— 折叠有逆变换记录；落盘有 SHA-256 与完整文件；驱逐项记原始位置（`read`/`grep`/`glob` 重跑即恢复）；摘要前全量存档。
2. **被取代引用记谱系** —— 任何内容被取代都登记「原位置 → 新位置 → 取代者」，可审计可回溯，不静默删。
3. **自身有熔断与仲裁** —— 单层连续失败自动降级跳过并告警，主流程不被阻断；仲裁器保证一份内容只归一层处理。

## 安装

插件是纯 ESM + JSDoc，无构建链，`src/` 直出，安装前无需编译。

```powershell
# 从 GitHub 装
dsh plugin --profile desktop add "github:2849236173/tiered-compaction"

# 本地开发：软链装，改代码即生效
dsh plugin --profile desktop add "<本仓库绝对路径>"
```

`<profile>` 是 DSH 的配置档案名，对应 `~/.dsh/profiles/<名字>` 下的目录（桌面端通常是 `desktop`）。

**装完重启即可，无需改任何配置。**

插件自带的 patch 在挂载时做两件事：停用官方 `dsh-compaction-basic`（让出 `compaction` 服务位），插入并启用本插件。存档目录默认 `~/.dsh/tiered-archive`，不存在时自动创建。

装好的标志——启动日志里能看到这两行：

```
dsh-tiered-compaction 已接管 compaction 服务位（enabled=true，archiveDir=...）
dsh-tiered-compaction 观察者已注册（工具结果 → 第 1-2 层）
```

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-tiered-compaction
```

卸载后官方 `dsh-compaction-basic` **自动恢复**——因为停用它的 patch 属于本插件包，随包一起移除。重启即回到官方压缩，不需要手工改回配置。

（如果你只想临时换成官方压缩、保留插件，也可以把 patch 里两个开关互换，但这种情况下卸载更简单。）

## 配置（全部可选）

装完即用，以下字段仅在需要自定义时才填：

```yaml
- id: tiered-compaction
  config:
    enabled: true                        # 默认 true
    archiveDir: ~/.dsh/tiered-archive    # 默认值，可改
    auto: true                           # 是否自动触发
    summaryTarget:                       # 摘要用哪个模型，不填则跟随当前会话
      provider: deepseek-official
      model: deepseek-chat
    modelPolicies: {}                    # 按模型覆盖阈值与重试次数
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否接管压缩服务位 |
| `archiveDir` | `~/.dsh/tiered-archive` | 落盘与摘要存档目录，自动创建 |
| `auto` | `true` | 是否自动触发（压力/溢出） |
| `summaryTarget` | 会话路由 | 摘要用的 provider/model |
| `modelPolicies` | `{}` | 按模型覆盖阈值、重试次数等 |

## 运行状态

日常不需要关注。想看它是否在正常工作，在宿主日志里搜 `tiered-compaction`：

```
tiered-compaction 健康 window=1000000 pressure=12.7% l12=107/31repl/0fail l3=0evict spill=29 status=ok
```

`status=ok` 即正常；出现 `status=warn` 表示自检发现了异常（窗口读数为 0、前两层有失败但零成功、压力 ≥80% 却零动作、`summaryTarget` 只配一半）。

压力到 82% 左右会触发一次摘要压缩，日志里会有 `compaction/summary` 记录。

## 开发

```bash
node --test test/*.test.js              # 全量用例
node scripts/verify-e2e.mjs <会话文件>    # 端到端链路（需真实会话，验证 KV 前缀等价）
```

端到端脚本验证的是「摘要请求是否为正常对话请求的严格前缀」——相同即必然命中 provider 的 KV 缓存。会话文件在 `~/.dsh/sessions/<工作区>/<会话ID>/session.v4.jsonl.zstd`。

## 已知限制

- **宿主版本绑定**：契约层对齐 DSH 0.2.x 的 `CompactionEngine` 接口，宿主大版本升级后需重新核对方法面。
- **只处理纯文本工具结果**：含图片或附件的富块一律跳过，避免破坏结构。
- **压力读数依赖 `request/context` 事件**：部分 provider 不吐该事件，缺失时压力判定退回保守路径。
- **落盘预览是固定预算**：预览 5120 字符（头尾 4:1）。超大输出必然有信息损失——原文完整保存在存档里，随上下文给出路径与 SHA-256，可随时回读。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/架构与设计理念.md](docs/架构与设计理念.md) | 架构总览、设计取舍、降级设计、已知边界 |
| [架构图](docs/架构图.html) | 四层管线交互式图（浏览器打开） |
| [docs/第1层-无损折叠.md](docs/第1层-无损折叠.md) | 折叠算法、逆变换、可逆性保证 |
| [docs/第2层-落盘.md](docs/第2层-落盘.md) | 存档、预览预算、SHA-256 校验 |
| [docs/第3层-软压力.md](docs/第3层-软压力.md) | 提醒与驱逐的优先级规则 |
| [docs/第4层-有损摘要.md](docs/第4层-有损摘要.md) | 摘要输入结构、KV 缓存复用、预算预留 |
| [docs/数据结构.md](docs/数据结构.md) | 事件、谱系表、存档记录 |

## License

MIT，见 [LICENSE](LICENSE)。
