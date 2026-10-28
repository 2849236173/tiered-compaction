# tiered-compaction

> DSH（DeepSeek-Harness）分层上下文压缩插件 —— 用「四层递进」替代「一步摘要」。
>
> 面向 DSH 的 Cordis 插件体系，可与官方 `@deepseek-ai/dsh-compaction-basic` 并存或替代它。

---

## 它解决什么问题

DSH 默认的压缩是**一步到位**：上下文到 80% 就调一次 LLM 做摘要，把历史整段换掉。实测下来有三个问题：

1. **贵**：每次压缩都是一次完整 LLM 调用；
2. **丢信息**：摘要输出有 token 上限，长内容被截断（实测 22,690 次摘要调用中 2,462 次被截断过半）；
3. **丢中部**：先截断再摘要，长消息中间的事实最先丢——而这往往是最关键的部分。

本插件把「一步摘要」拆成**四层递进**：前两层零 LLM 成本就能吃掉大部分体积，软压力层负责提醒与驱逐，只有真到阈值才动用一次带预算预留的 LLM 摘要。

## 四层管线

```
工具输出产生
    │
    ▼
┌─ 第 1 层 · 无损折叠 ────────────────────────────┐
│ 连续重复行（≥3 次）折叠为「首行 + …[folded Nx]」  │  零 LLM 成本
│ 每次折叠生成逆变换记录，还原可逐字节校验           │
└──────────────────┬─────────────────────────────┘
                   ▼
┌─ 第 2 层 · 落盘 ────────────────────────────────┐
│ >8KB（UTF-8 字节）工具输出整体落盘               │  零 LLM 成本
│ 上下文只留头尾预览 + 存档路径 + SHA-256           │
└──────────────────┬─────────────────────────────┘
                   ▼
┌─ 第 3 层 · 软压力 ──────────────────────────────┐
│ 70% 窗口：插入提醒（不改历史）                    │  零 LLM 成本
│ 80% 窗口：按优先级驱逐易失内容                    │
└──────────────────┬─────────────────────────────┘
                   ▼
┌─ 第 4 层 · 有损摘要 ────────────────────────────┐
│ 阈值 = 窗口 − max(16k, 5%) − 摘要预留(20k)        │  LLM 调用
│ 摘要预算提前预留，从根上杜绝截断死循环             │
│ 摘要前全量存档，摘要后登记谱系                    │
└─────────────────────────────────────────────────┘
```

另有**旁路管线**：目标切换清理（goal-switch purge）——显式宣告新目标时，把旧目标的 todo/goal/plan 打包成结构化胶囊，过程内容归档，全程零 LLM。

## 保真三原则

贯穿所有层的设计约束，也是它敢做有损操作的前提：

1. **每层留恢复机制** —— 第 1 层逆变换记录；第 2 层 SHA-256 + 全量文件；第 3 层被驱逐项记原始位置（read/grep/glob 重跑即恢复）；第 4 层摘要前全量存档。
2. **被取代引用记谱系，不静默删** —— 任何内容被折叠/落盘/驱逐/摘要取代，都在谱系表登记「原位置 → 新位置 → 取代者」，可审计可回溯。
3. **压缩系统自身有熔断器 + 仲裁器** —— 单层连续失败自动降级跳过并告警，主流程绝不被阻断；仲裁器保证一份内容只归一层处理。

## 安装

插件遵循 DSH 插件的无构建链约定（纯 ESM + JSDoc，无需 tsc/bundler），`src/` 直出，**安装前无需编译**。

### 方式一：从 GitHub Release 的 tarball 装（推荐）

到 [Releases](https://github.com/2849236173/tiered-compaction/releases) 下载 `dsh-tiered-compaction-<版本>.tgz`，然后：

```powershell
dsh plugin --profile <profile> add "C:\下载路径\dsh-tiered-compaction-0.2.0.tgz"
```

### 方式二：直接从仓库装

```powershell
dsh plugin --profile <profile> add "github:2849236173/tiered-compaction"
```

### 方式三：本地开发（软链，改代码即生效）

```powershell
dsh plugin --profile <profile> add "<本仓库绝对路径>"
```

### 挂载配置

装好后在该 profile 的 `cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: tiered-compaction
      name: "dsh-tiered-compaction"
      config:
        enabled: true            # 默认 false：仅注册自检服务，不影响 basic
        archiveDir: C:\Users\<you>\.dsh\tiered-archive
```

> ⚠️ 注意 DSH patch 的写法：新增条目必须只写 `insert:`，`id`/`config` 全部放进 insert 数组项内。写成顶层 `id:` 会被当作「修改已存在条目」而报 `not found`。

> ⚠️ 同一 `compaction` 服务位不可双注册。`enabled: true` 时必须在同一 profile 里停用 `dsh-compaction-basic`，否则后加载者会被跳过。`enabled: false` 时二者可以共存。

## 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 是否接管 `ctx.compaction` 服务位 |
| `archiveDir` | string | `~/.dsh/tiered-archive` | 落盘存档目录（懒创建） |
| `bypassMode` | boolean | `false` | 槽位被占时降级为「仅第 1-2 层」旁路模式 |
| `summaryTarget` | object | 从会话路由推断 | 摘要用的 `{ provider, model }` |

## 与官方 basic 的关系

DSH 的 `compaction` 服务位是**单槽**（basic、glm、kiro 等都往那儿挂）。本插件的策略是：

- `enabled: false`（默认）：只注册只读自检服务 `tieredCompaction`，**不占服务位**，与 basic 完全并存；
- `enabled: true`：用 **construction-catch 探测**接管服务位。槽被占时自动降级为「第 1-2 层旁路模式」——无损折叠与落盘照常工作（这两层与任何压缩形态都不冲突），第 3-4 层挂起。

> 踩坑备忘：**不要用 `ctx.get('compaction')` 探测槽位**。它会强制实例化懒声明的引擎、把槽占掉反噬自己（在 headless 环境实测踩过）。正确的探测方式是直接构造服务类，catch 住 `service "compaction" has been registered` 后解析持有者再降级。

## 验收标准

设计文档 `docs/设计.md` §6 写死了 A1–A12 共 12 条验收项，测试套件覆盖：

```powershell
npm test          # 210 个用例
```

| 项 | 内容 |
|---|---|
| A1 | 无损折叠可逆（抽样 10 组逐字节还原） |
| A2 | >8KB 输出全部落盘，SHA-256 校验，预览有上限 |
| A3 | 70% 只提醒不改历史；80% 驱逐后 todo/goal/plan/用户消息零丢失 |
| A4a/A4b | 摘要预算预留 ≥20k；截断率相对基线下降 |
| A5 | 目标切换胶囊完整、过程内容归档、零 LLM |
| A6 | `enabled=false` 行为与纯 basic 一致 |
| A7 | 人为制造落盘失败，插件降级跳层、主流程不受阻 |
| A8 | fixture 重放：token 均值降幅 ≥30%、摘要调用次数降幅 ≥50% |
| A9 | git 仅本地开发，feature 分支合主干 |
| A10 | 谱系表三元组可查、抽样对得上实物 |
| A11 | 压缩后文件引用不失效 |
| A12 | 宿主契约对齐：三入口 + 自动钩子 + 返回形状与 basic 一致 |

## 目录结构

```
src/
  index.js                 插件入口：enabled 双分支 + 槽位探测与降级
  contract.js              宿主契约层：CompactionEngine 基类 + 三入口 + 自动钩子
  tool-result-observer.js  宿主观察者：把第 1-3 层接到 session/event 流
  engine.js                四层管线编排（纯接线）
  lossless-fold.js         第 1 层：无损折叠 + 逆变换
  spill-to-disk.js         第 2 层：落盘 + SHA-256 + 头尾预览
  soft-pressure.js         第 3 层：70% 提醒 / 80% 驱逐优先级
  lossy-summarize.js       第 4 层：阈值算法 + 预算预留 + 全量存档
  summary-input.js         摘要输入构造（不先截断，避免丢中部）
  goal-switch.js           目标切换旁路
  lineage.js               谱系表（保真原则 2）
  circuit-breaker.js       熔断器 + 仲裁器（保真原则 3）
  health-check.js          自检面
test/                      210 个用例 + fixture 重放
docs/                      设计 / 审计 / 验收 / 安装记录
```

## 已知限制

- **host 版本绑定**：契约层对齐 DSH 0.2.x 的 `CompactionEngine` 接口，宿主大版本升级后需要重新核对方法面。
- **只处理纯文本工具结果**：含图片/附件的富块一律跳过，避免破坏结构。
- **压力读数依赖 `request/context` 事件**：不同 provider 是否吐该事件需要实测确认，缺失时压力判定会退回保守路径。
- **落盘预览是固定预算**：预览长度 5120 字符（头尾 4:1，对齐官方 pruner 的 `headChars 4096 + tailChars 1024` 口径）。超大输出必然有信息损失，这是设计上接受的代价——**原文永远完整保存在存档里**，随上下文给出路径与 SHA-256，需要时可回读。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/设计.md](docs/设计.md) | 四层管线、保真三原则、验收标准、里程碑 |
| [docs/审计报告.md](docs/审计报告.md) | 全量审计：设计 vs 实现逐条对照、P0–P4 分级问题 |
| [docs/系统审计报告.md](docs/系统审计报告.md) | 系统级审计（并发、递归、生命周期） |
| [docs/安装记录.md](docs/安装记录.md) | 沙箱到生产的安装过程与踩坑 |
| [docs/测试报告.md](docs/测试报告.md) | 测试执行记录 |

## License

MIT —— 见 [LICENSE](LICENSE)。
