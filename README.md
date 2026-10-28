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
# 从 GitHub 装（跟随 main 最新）
dsh plugin --profile desktop add "github:2849236173/tiered-compaction"

# 本地开发：软链装，改代码即生效
dsh plugin --profile desktop add "<本仓库绝对路径>"
```

`<profile>` 是 DSH 的配置档案名，对应 `~/.dsh/profiles/<名字>` 下的目录（桌面端通常是 `desktop`）。每个 profile 的 `package.json`、`node_modules` 互相独立，装到沙箱里不会影响桌面端。

插件自带的 `cordis.patch.yml` 会被自动挂载，`enabled` 默认 `false`——只注册自检服务，不改变任何现有压缩行为。要真正接管压缩，需在该 profile 的 `cordis.patch.yml` 里把 `enabled` 改为 `true`，同时停用 `@deepseek-ai/dsh-compaction-basic`（同一服务位不可双注册）。

## 配置

```yaml
- insert:
    - id: tiered-compaction
      name: "@local/dsh-tiered-compaction"
      config:
        enabled: true
        archiveDir: ~/.dsh/tiered-archive   # 存档目录
```

主要字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | `true` 才接管压缩服务位 |
| `archiveDir` | — | 落盘与摘要存档目录，未配置时跳过落盘层 |
| `auto` | `true` | 是否自动触发（压力/溢出） |
| `summaryTarget` | 会话路由 | 摘要用的 provider/model，不配则跟随当前会话 |
| `modelPolicies` | `{}` | 按模型覆盖阈值、重试次数等 |

## 运行状态

插件每 10 分钟写一行健康日志，异常时立即上报（不受节流限制）：

```
tiered-compaction 健康 window=1000000 pressure=12.7% l12=107/31repl/0fail l3=0evict spill=29 lineage=31 status=ok
```

| 字段 | 含义 |
|---|---|
| `window` | 读到的上下文窗口 |
| `pressure` | 当前压力 |
| `l12=a/b/c` | 第 1-2 层处理数 / 替换数 / 失败数 |
| `l3=N` | 第 3 层驱逐数 |
| `spill` / `lineage` | 落盘次数 / 谱系条目数 |
| `status` | `ok` 或 `warn` |

能识别四类明确异常：窗口读数为 0、第 1-2 层有失败但零成功、压力 ≥80% 却零动作、`summaryTarget` 只配一半。

## 验证

```bash
node --test test/*.test.js          # 全量用例
node scripts/verify-e2e.mjs <会话文件>   # 端到端链路（需真实会话）
```

端到端脚本验证的是「摘要请求是否为正常对话请求的严格前缀」——相同即必然命中 provider 的 KV 缓存，不同则一次都命中不了。传真实会话文件路径即可，会话在 `~/.dsh/sessions/<工作区>/<会话ID>/session.v4.jsonl.zstd`。

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
