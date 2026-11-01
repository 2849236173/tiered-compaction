/**
 * client 骨架 + 压力条（方案《方案-UI显示.md》§五 任务 #3，骨架来自任务 #2）。
 *
 * 宿主通过 combo 脚本加载本文件（dsh-client-modules 解析 package.json 的
 * dsh.client 声明 + exports["./client"]），入口是
 * `window.__ModuleLoader__.load({ id, factory })`——与官方模板
 * decoration/client.js 同构，不 import/export（combo 走普通 script 通道）。
 *
 * 数据区共用同一份实现，入口只差外围壳，按 `surface` 分支渲染：
 *   - settings：全尺寸（标题 + 状态卡 + 条 + 刻度线图例 + 四层数字块），
 *     设置页主入口；
 *   - overlay：低干扰 HUD（状态点 + 压力百分比 + 可读压力条），不遮挡输入区，
 *     可拖动、可关闭；
 *   设置页与 HUD 是用户可见的两处入口，数据源始终是同一份状态快照。
 */

/** 模块 id 必须等于包名（dshmarket 同款约定）。 */
const MODULE_ID = "dsh-tiered-compaction";

/**
 * i18n 字典命名空间（任务 #7）。plugin-market 同款：宿主 locale 服务的
 * register/bind 都要求一个 ns，字符串只要全仓库唯一即可；条目注册处引用同名。
 */
const I18N_NS = "tieredCompaction";

/**
 * 双语字典（任务 #7）：key 是抽象文案名，zh/en 两表 key 集合必须一致
 * （d29 双向 diff 防漏译）。Object.freeze 防运行时误改——字典是三入口共享
 * 的模块级数据，坏一处坏三处。取词规则见 tOf()；zh 与现有硬编码逐字节一致
 * （d23-d28 断言的中文是回归红线，不许顺手改词）。
 */
const STRINGS = Object.freeze({
    zh: Object.freeze({
        panelTitle: "tiered-compaction 分层压缩",
        statusPrefix: "状态",
        loading: "读取中…",
        unavailable: "数据不可用",
        compacting: "压缩中",
        windowPrefix: "窗口",
        sinceMark: "本会话自 {time} 起统计",
        sessionPrefix: "本次会话：",
        sessionPrefixWithSince: "本次会话（{since}）：",
        missingValue: "—",
        statsTitle: "活动统计",
         l12Processed: "无损折叠",
        spillCount: "落盘存档",
        l3Evicted: "软压力驱逐",
        l4Summaries: "有损摘要",
        foldShort: "折叠",
        foldSpillShort: "折叠/落盘",
        chipSaved: "省 {value}",
        spillShort: "落盘",
        evictShort: "驱逐",
        summaryShort: "摘要",
        bytesSavedMB: "省 ~{value} MB",
        bytesSavedKB: "省 ~{value} KB",
        bytesSavedBytes: "省 ~{value} 字节",
        markRemind: "{percent} 提醒线",
        markEvict: "{percent} 驱逐线",
        markSummary: "{percent} 摘要线",
        toneCalm: "正常",
        toneRemind: "偏高",
        toneEvict: "危险",
        toneUnknown: "未知",
        pressurePrefix: "压力",
        hudCloseTitle: "关闭悬浮窗",
        combinedCharsSaved: "折叠+落盘合计（字符）省 ~{value}",
        toSummary: "距摘要 ≈ {value}",
        summaryDue: "已到摘要线",
        hudFooterSaved: "共省 ≈ {value}",
        hudFooterLast: "上次摘要 {ago}",
        agoMinutes: "{n} 分钟前",
        agoHours: "{n} 小时前",
        agoDays: "{n} 天前",
        agoJustNow: "刚刚",
        tokensApprox: "≈ {value} tokens",
        processSummaries: "全进程 {count}",
        sessionScope: "本会话",
        autoNotRunningShort: "自动压缩未运行 · /compact",
        totalSavedTitle: "总节省",
        totalSavedValue: "≈ {value} tokens",
        totalSavedOfWindow: "相当于窗口的 {percent}",
        autoNotRunning: "自动压缩未运行，可手动执行 /compact",
        autoCheckedAgo: "自动压缩：{seconds} 秒前检查",
        lastCompaction: "最近一次摘要：{time}，{trigger}，遮蔽 {nodes} 个节点 ≈ {shadowed} tokens → {summary} tokens",
        triggerAuto: "自动",
        triggerManual: "手动",
        usageTokens: "{current} / {window} tokens",
        hudShow: "显示悬浮窗",
        hudHide: "隐藏悬浮窗",
        hudRestoreTitle: "恢复悬浮窗",
        hudCollapseTitle: "收起悬浮窗",
        hudExpandTitle: "展开悬浮窗",
        compactedToast: "已压缩：{from} → {to}",
        compactedToastSaved: "已压缩：{from} → {to}，节省 ≈ {saved} tokens",
    }),
    en: Object.freeze({
        panelTitle: "tiered-compaction",
        statusPrefix: "Status",
        loading: "Loading…",
        unavailable: "Data unavailable",
        compacting: "Compacting",
        windowPrefix: "Window",
        sinceMark: "this session, counted since {time}",
        sessionPrefix: "This session:",
        sessionPrefixWithSince: "This session (since {since}):",
        missingValue: "—",
        statsTitle: "Activity",
         l12Processed: "Lossless fold",
        spillCount: "Spill to disk",
        l3Evicted: "Soft-pressure eviction",
        l4Summaries: "Lossy summary",
        foldShort: "Fold",
        foldSpillShort: "Fold/spill",
        chipSaved: "saved {value}",
        spillShort: "Spill",
        evictShort: "Evict",
        summaryShort: "Summary",
        bytesSavedMB: "~{value} MB saved",
        bytesSavedKB: "~{value} KB saved",
        bytesSavedBytes: "~{value} bytes saved",
        markRemind: "{percent} remind line",
        markEvict: "{percent} evict line",
        markSummary: "{percent} summary line",
        toneCalm: "OK",
        toneRemind: "High",
        toneEvict: "Critical",
        toneUnknown: "Unknown",
        pressurePrefix: "Pressure",
        hudCloseTitle: "Close HUD",
        combinedCharsSaved: "Fold + spill combined (chars) ~{value} saved",
        toSummary: "≈ {value} to summary",
        summaryDue: "at summary line",
        hudFooterSaved: "Saved ≈ {value}",
        hudFooterLast: "last summary {ago}",
        agoMinutes: "{n} min ago",
        agoHours: "{n} h ago",
        agoDays: "{n} d ago",
        agoJustNow: "just now",
        tokensApprox: "≈ {value} tokens",
        processSummaries: "process total {count}",
        sessionScope: "This session",
        autoNotRunningShort: "Auto compaction idle · /compact",
        totalSavedTitle: "Total saved",
        totalSavedValue: "≈ {value} tokens",
        totalSavedOfWindow: "{percent} of the window",
        autoNotRunning: "Auto compaction is not running; run /compact manually",
        autoCheckedAgo: "Auto compaction: checked {seconds}s ago",
        lastCompaction: "Last summary: {time}, {trigger}, shadowed {nodes} nodes ≈ {shadowed} tokens → {summary} tokens",
        triggerAuto: "auto",
        triggerManual: "manual",
        usageTokens: "{current} / {window} tokens",
        hudShow: "Show HUD",
        hudHide: "Hide HUD",
        hudRestoreTitle: "Restore HUD",
        hudCollapseTitle: "Collapse HUD",
        hudExpandTitle: "Expand HUD",
        compactedToast: "Compacted: {from} → {to}",
        compactedToastSaved: "Compacted: {from} → {to}, saved ≈ {saved} tokens",
    }),
});

/** 取词回落语言：en 表缺 key 时回落 zh（与宿主 FALLBACK_LOCALE=en 不同向——本表 zh 是原文，绝无缺词）。 */
const I18N_FALLBACK = "zh";

/** 本插件的 localStorage 语言记忆键（探测链第 2 级；v1 后缀同 HUD_STATE_KEY 的理由）。 */
const LOCALE_STORAGE_KEY = "tiered-compaction-locale";

/** 支持的语言集合（字典只有这两张表；探测出别的值一律回落 zh）。 */
const SUPPORTED_LOCALES = ["zh", "en"];

/**
 * 状态路由路径。为什么复制而不 import src/status-route.js：client 半是
 * 浏览器脚本，与 host 半不共享模块系统；两处必须保持同字符串，改动时成对改。
 */
const STATUS_PATH = "/api/tiered-compaction/status";

/** 设置页分区槽位（宿主 settings 外壳声明）。 */
const SETTINGS_SECTION_SLOT = "settings.section";
const SETTINGS_SECTION_ID = "tiered-compaction";
const SETTINGS_SECTION_ORDER = 45;


/** 悬浮 overlay 槽位（宿主 root children 声明，kind=list，必须自带 id）。 */
const OVERLAY_SLOT = "shell.overlay";
const OVERLAY_ID = "tiered-compaction-hud";
/** overlay 条目 label：id 性质字符串（宿主 ledger 用），不是展示文案，不参与翻译。 */
const OVERLAY_LABEL = "tiered-compaction";
/** overlay 悬浮层级：高于宿主常规内容即可。 */
const OVERLAY_Z_INDEX = 1000;
/** HUD 默认右侧偏移；底部使用宿主 composer 高度变量避让输入区。 */
const OVERLAY_CORNER_OFFSET = "16px";
const OVERLAY_SAFE_BOTTOM = "calc(var(--dsh-composer-height, 152px) + 16px)";

/**
 * overlay 记忆键（方案 §五 #4「可关闭（localStorage 记住）」+ 拖动位置）。
 * 关闭状态与位置存同一个键：一次读写即一致，不会出现「关了但记不住了」的半截
 * 状态。名字带 v1 后缀——形状变了就换键，旧存档不会把新代码带进未定义字段。
 */
const HUD_STATE_KEY = "tiered-compaction-hud-state";

/**
 * 压力配色档位（方案 §3.3 原文：<70% 绿、70-80% 黄、≥80% 橙）。
 * 分档切点直接复用上面的镜像阈值（PRESSURE_REMIND_RATIO / PRESSURE_EVICT_RATIO），
 * 与刻度线共用同一组数字，不引入第二套阈值源。
 * 82%（摘要线）不参与配色：它是第 4 层的触发底线，不是压力档位边界；
 * 配色只做视觉提示，数值仍以 API 返回为准。
 */
const PRESSURE_TONE_CALM = "calm";
const PRESSURE_TONE_REMIND = "remind";
const PRESSURE_TONE_EVICT = "evict";
const PRESSURE_TONE_UNKNOWN = "unknown";

/**
 * 档位 → 颜色 + STRINGS 的档位名 key。tone 名进 data-tone、颜色进 style、
 * 显示词按 locale 从 STRINGS 取（任务 #7），三者同源于此表。
 */
const PRESSURE_TONES = Object.freeze({
    [PRESSURE_TONE_CALM]: { color: "#10a37f", key: "toneCalm" },
    [PRESSURE_TONE_REMIND]: { color: "#d97706", key: "toneRemind" },
    [PRESSURE_TONE_EVICT]: { color: "#dc2626", key: "toneEvict" },
    [PRESSURE_TONE_UNKNOWN]: { color: "#81858c", key: "toneUnknown" },
});

/**
 * 压力刻度线镜像常量（任务 #3）。浏览器端不能 import src/，三处与 host 半
 * 成对维护，改动任一侧必须同步另一侧：
 *   70%/80% ← src/soft-pressure.js 的 REMIND_RATIO/EVICT_RATIO
 *     （pressureAction：≥70% remind 只提醒、≥80% evict 驱逐）；
 *   82% ← src/lossy-summarize.js 的 MIN_THRESHOLD_RATIO（=0.82，函数内
 *     底线 FLOOR_RATIO 同值：低于它会抢跑第 3 层 80% 驱逐，四层递进失效）。
 * 显示单位一律是 0~1 小数（与 API pressure 同口径），渲染层才乘 100。
 */
const PRESSURE_REMIND_RATIO = 0.7;
const PRESSURE_EVICT_RATIO = 0.8;
const PRESSURE_LOSSY_FLOOR_RATIO = 0.82;

/**
 * 刻度线定义：label 对齐方案 §3.1（提醒线/驱逐线/摘要线），位置=比例×条宽
 * （percent 字符串）。文案是 STRINGS 的 key（任务 #7），percent 前缀在
 * 渲染处拼——数字是本文件的镜像常量，不该复制进字典。数组顺序即 DOM 顺序。
 */
const PRESSURE_MARKS = [
    { value: PRESSURE_REMIND_RATIO, percent: "70%", key: "markRemind" },
    { value: PRESSURE_EVICT_RATIO, percent: "80%", key: "markEvict" },
    { value: PRESSURE_LOSSY_FLOOR_RATIO, percent: "82%", key: "markSummary" },
];

/**
 * 压力条布局参数：条容器高度 > 填充高度，顶部余量正好容纳「半凸出」刻度线
 * （线上探 BAR_TICK_OVERFLOW 形成条顶上方的小齿，保证 82 与 80 两线肉眼可辨）。
 */
const BAR_HEIGHT = "14px";
const BAR_FILL_HEIGHT = "6px";
const BAR_TICK_OVERFLOW = "7px";
const BAR_MARK_OFFSET = "-7px";
const MARK_LINE_WIDTH = "2px";
const BAR_MARK_HEIGHT = "10px";

const BAR_STYLE = { position: "relative", height: BAR_HEIGHT, marginTop: BAR_TICK_OVERFLOW };
const BAR_TRACK_STYLE = {
    position: "absolute",
    left: "0",
    right: "0",
    top: "0",
    height: BAR_FILL_HEIGHT,
    borderRadius: "999px",
    backgroundColor: "var(--dsw-alias-fill-tertiary, rgba(31, 35, 40, .12))",
};
const BAR_FILL_STYLE = {
    position: "absolute",
    left: "0",
    top: "0",
    height: BAR_FILL_HEIGHT,
    borderRadius: "999px",
    backgroundColor: "var(--dsh-tiered-tone, var(--dsw-alias-state-business-primary, #4a9eda))",
    transition: "width .22s ease, background-color .22s ease",
};

/**
 * 刻度线（竖线）基础样式：left 由各线的阈值百分比逐线给出，transform 把线
 * 中点对准阈值位置并上移形成凸齿。mark 与 fill 同处一个坐标系，位置天然对齐。
 */
const BAR_MARK_BASE_STYLE = {
    position: "absolute",
    top: "0",
    transform: `translate(-50%, ${BAR_MARK_OFFSET})`,
    width: MARK_LINE_WIDTH,
    height: BAR_MARK_HEIGHT,
    borderRadius: "2px",
    backgroundColor: "var(--dsw-alias-label-tertiary, #7a8591)",
};

const BAR_LEGEND_ROW_STYLE = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "6px 12px",
    marginTop: "4px",
    color: "var(--dsw-alias-label-tertiary, #7a8591)",
    fontSize: "11px",
    lineHeight: "1.4",
};

/**
 * surface 取值：组件按它分支渲染（方案 §2.3「一个组件三入口」）。
 * PANELLIST 是 #5 新增的第四种渲染面：它不占三入口中的任何一个，只在
 * sidebar.panellist（图标行）里用——图标行空间只够一行字，所以单独成型，
 * 不能复 main 的侧栏面板（那会把标题与压力条挤进图标行）。
 */
const SURFACE_SETTINGS = "settings";
const SURFACE_OVERLAY = "overlay";

/** 面板标题走 STRINGS.panelTitle（任务 #7；zh 值与旧硬编码逐字节一致）。 */
const PANEL_TITLE_KEY = "panelTitle";

/** 侧栏图标（方案 §3.2 手绘图里的 🐋）：图标行没有标题位，靠它也认得出来。 */
const PANEL_ICON = "🐋";

/**
 * 状态字表：只翻译「压缩进行中」这一类，其余状态原样透出。
 * 值是 STRINGS 的 key（任务 #7）。为什么单独一张表：状态字是 API 字段的展示，
 * 不是第二套状态机——宿主半当前只产出 ok/warn，`compacting` 是任务 #5 要求
 * 覆盖的「压缩中」态，日后事件源接入时这里不用再改渲染；表里没有的词
 * （含 ok/warn）一律按原字面显示，既有断言（d23「/ok/」等）因此不受影响。
 */
const STATUS_LABELS = Object.freeze({ compacting: "compacting" });

const PHASE_LOADING = "loading";
const PHASE_READY = "ready";
const PHASE_UNAVAILABLE = "unavailable";
/** 占位文案 key（任务 #7）：zh 值与旧硬编码逐字节一致。 */
const LOADING_TEXT_KEY = "loading";
const UNAVAILABLE_TEXT_KEY = "unavailable";

/**
 * 四层数字块标签（任务 #6 顺序 + 任务 #7 双语）：值是 STRINGS 的 key。
 * 折叠用 l12Processed 口径（第 1-2 层处理数）；落盘附省字节数；
 * 摘要来自 host 半的 l4Summaries（提交过的摘要事务数）。
 */
const LAYERS_LABELS = Object.freeze({
    l12Processed: "l12Processed",
    spillCount: "spillCount",
    l3Evicted: "l3Evicted",
    l4Summaries: "l4Summaries",
});

/** 四层数字块的 testid（d28 按它定位断言；panellist 摘要行沿用既有 testid）。 */
const LAYERS_BLOCK_TESTID = "layer-stats";

/**
 * 初始快照：挂载后 fetch 完成前的诚实占位（不是「数据不可用」）。
 * freeze 的原因：两者是模块级共享对象，#4~#6 扩展时若误改字段会污染所有
 * 入口的初值；相位切换本就该造新对象，锁死是零成本的护栏（任务 #3 顺检）。
 * window（任务 #5）：非 ready 相位没有可信窗口值，一律 null——渲染层据此
 * 决定「不显示窗口」，绝不拿 0 冒充「窗口是 0」。
 */
const LOADING_SNAPSHOT = Object.freeze({
    phase: PHASE_LOADING,
    status: null,
    pressure: null,
    pressureWidth: null,
    window: null,
    currentTokens: null,
    layers: null,
    sinceText: null,
    autoCheckKnown: false,
    autoCheckedAt: null,
    autoEnabled: null,
    lastCompaction: null,
});
const UNAVAILABLE_SNAPSHOT = Object.freeze({
    phase: PHASE_UNAVAILABLE,
    status: null,
    pressure: null,
    pressureWidth: null,
    window: null,
    currentTokens: null,
    layers: null,
    sinceText: null,
    autoCheckKnown: false,
    autoCheckedAt: null,
    autoEnabled: null,
    lastCompaction: null,
});

/**
 * overlay 盒子样式（任务 #4）：定位固定，唯一可变的是 left/top——未拖动过用
 * 角落（right/bottom），拖动过就换成存档的 left/top（见 hudPositionStyleOf）。
 * touchAction:none 让触控拖拽不被宿主的滚动手势抢走。
 */
const HUD_BASE_STYLE = {
    position: "fixed",
    zIndex: OVERLAY_Z_INDEX,
    display: "block",
    width: "min(258px, calc(100vw - 24px))",
    minWidth: "0",
    cursor: "move",
    userSelect: "none",
    touchAction: "none",
};

/** 状态点与压力档位同色；未知态使用宿主次级文字色。 */
const HUD_DOT_STYLE = {
    flex: "0 0 auto",
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    backgroundColor: "var(--dsh-tiered-tone, var(--dsw-alias-label-tertiary, #7a8591))",
};

/** HUD 文本允许收缩，避免英文长词撑破窗口。 */
const HUD_STATUS_STYLE = {
    minWidth: "0",
    color: "var(--dsw-alias-label-tertiary, #7a8591)",
    fontSize: "11px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
};

/**
 * 关闭后的恢复胶囊：固定在默认角落（不跟拖动位置走——HUD 已关，存档位置留给
 * 恢复后的 HUD 用；胶囊永远在同一个可预期的地方出现）。
 */
const HUD_PILL_STYLE = {
    position: "fixed",
    zIndex: OVERLAY_Z_INDEX,
    right: OVERLAY_CORNER_OFFSET,
    bottom: OVERLAY_SAFE_BOTTOM,
};

/** 收起态胶囊：沿用 HUD 定位，只把盒子缩成一颗胶囊。 */
const HUD_CAPSULE_OVERRIDE_STYLE = {
    width: "auto",
    padding: "0",
    border: "0",
    borderRadius: "999px",
    background: "transparent",
    boxShadow: "none",
    backdropFilter: "none",
    WebkitBackdropFilter: "none",
    cursor: "default",
};

/**
 * beta4 时序参数：
 *   - 自动压缩检查超过 120 秒没跑、且压力 ≥ 驱逐线 → 判「自动压缩未运行」；
 *   - 相邻两次同会话快照压力下降 ≥ 10 个百分点 → 判「刚压缩过」，提示 4 秒；
 *   - 四层计数上涨时芯片高亮 1.2 秒（CSS 动画时长同值）。
 */
const AUTO_CHECK_STALE_MS = 120000;
const PRESSURE_DROP_TRIGGER_BP = 1000;
const COMPACTED_TOAST_MS = 4000;
const CHIP_BUMP_MS = 1200;

/** HUD 四层芯片：key → 显示名 + 悬停全称（STRINGS key）。数组顺序即 DOM 顺序。 */
const HUD_CHIPS = [
    // beta8：用动作名代替 L1-L4；折叠与落盘合并（会话日志里分不出两层，重启回填后口径一致）
    { key: "l12", titleKey: "foldSpillShort" },
    { key: "l3", titleKey: "evictShort" },
    { key: "l4", titleKey: "summaryShort" },
];

/** HUD 拖动边距和估算尺寸：实际宽度由 CSS 限制，足以做安全边界校正。 */
const HUD_EDGE_GAP = 12;
const HUD_ESTIMATED_WIDTH = 258;
const HUD_ESTIMATED_HEIGHT = 164;

/** 将 HUD 坐标限制在视口内；测试桩没有视口尺寸时保持原值。 */
function clampHudPosition(left, top) {
    if (typeof window === "undefined") return { left, top };
    const viewportWidth = Number(window.innerWidth);
    const viewportHeight = Number(window.innerHeight);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
        return { left, top };
    }
    return {
        left: Math.min(Math.max(HUD_EDGE_GAP, left), Math.max(HUD_EDGE_GAP, viewportWidth - HUD_ESTIMATED_WIDTH - HUD_EDGE_GAP)),
        top: Math.min(Math.max(HUD_EDGE_GAP, top), Math.max(HUD_EDGE_GAP, viewportHeight - HUD_ESTIMATED_HEIGHT - HUD_EDGE_GAP)),
    };
}

/** 关闭按钮：贴右，无边框，保持 HUD 的紧凑观感。 */
const HUD_CLOSE_STYLE = {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    marginLeft: "auto",
    padding: "0",
    border: "0",
    borderRadius: "5px",
    background: "transparent",
    color: "var(--dsw-alias-label-tertiary, #7a8591)",
    cursor: "pointer",
    fontSize: "14px",
    lineHeight: "1",
};

/** 所有样式都带插件前缀，跟随宿主 Design Tokens，不污染聊天和设置页。 */
const UI_STYLE_ID = "tiered-compaction-ui-v5";
const UI_CSS = `
.dsh-tiered-compaction {
    box-sizing: border-box;
    width: min(100%, 760px);
    margin: 0 auto;
    padding: 24px;
    color: var(--dsw-alias-label-primary, #1f2328);
    font: inherit;
    line-height: 1.45;
}
.dsh-tiered-compaction *, .dsh-tiered-compaction *::before, .dsh-tiered-compaction *::after, .dsh-tiered-compaction__hud *, .dsh-tiered-compaction__hud *::before, .dsh-tiered-compaction__hud *::after { box-sizing: border-box; }
.dsh-tiered-compaction__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.dsh-tiered-compaction__identity { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.dsh-tiered-compaction__mark { display: grid; place-items: center; flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; color: var(--dsw-alias-state-business-primary, #176b61); background: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, currentColor 12%, transparent)); font-size: 17px; }
.dsh-tiered-compaction__eyebrow { margin: 0 0 3px; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.dsh-tiered-compaction__title { margin: 0; color: var(--dsw-alias-label-primary, #1f2328); font-size: 18px; font-weight: 620; line-height: 1.25; }
.dsh-tiered-compaction__subtitle { margin: 5px 0 0; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 12px; }
.dsh-tiered-compaction__state { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; max-width: 42%; padding: 6px 9px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 999px; color: var(--dsw-alias-label-secondary, #58636e); background: var(--dsw-alias-bg-module-platform, #f6f7f8); font-size: 12px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-tiered-compaction__state-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--dsh-tiered-tone, var(--dsw-alias-state-business-primary, #2f9e44)); }
.dsh-tiered-compaction__hero { padding: 18px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 14px; background: var(--dsw-alias-bg-module-platform, #fff); box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 6%, transparent); }
.dsh-tiered-compaction__hero-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.dsh-tiered-compaction__hero-label { color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 12px; }
.dsh-tiered-compaction__pressure { color: var(--dsh-tiered-tone, var(--dsw-alias-state-business-primary, #2f9e44)); font-size: 28px; font-weight: 650; letter-spacing: -.03em; line-height: 1; }
.dsh-tiered-compaction__status-line { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--dsw-alias-label-secondary, #58636e); font-size: 13px; }
.dsh-tiered-compaction__status-line strong { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 560; overflow-wrap: anywhere; }
.dsh-tiered-compaction__bar { min-width: 0; }
.dsh-tiered-compaction__bar-track { border-radius: 999px; background: transparent; }
.dsh-tiered-compaction__bar-fill { position: relative; border-radius: 999px; background-image: linear-gradient(90deg, #00f5d4 0%, #3b82f6 25%, #8b5cf6 50%, #ec4899 75%, #00f5d4 100%) !important; background-size: 240% 100% !important; box-shadow: 0 0 12px rgba(59, 130, 246, .48), 0 0 20px rgba(139, 92, 246, .28) !important; animation: dsh-tiered-compaction-aurora 3s linear infinite, dsh-tiered-compaction-bar-grow .65s cubic-bezier(.16, 1, .3, 1) !important; transition: width .52s cubic-bezier(.16, 1, .3, 1) !important; }
.dsh-tiered-compaction__bar-fill::before { content: ""; position: absolute; inset: 0; border-radius: 999px; background: linear-gradient(110deg, transparent 20%, rgba(255, 255, 255, .75) 48%, #ffffff 50%, rgba(255, 255, 255, .75) 52%, transparent 80%); background-size: 200% 100%; animation: dsh-tiered-compaction-shimmer 2s cubic-bezier(.4, 0, .2, 1) infinite; pointer-events: none; }
.dsh-tiered-compaction__bar-fill::after { content: ""; position: absolute; right: -1px; top: 50%; width: 7px; height: 7px; border-radius: 50%; transform: translateY(-50%); background: #ffffff; box-shadow: 0 0 6px 1.5px #ffffff, 0 0 12px 3px #8b5cf6, 0 0 18px 5px var(--dsh-tiered-tone, #06b6d4); animation: dsh-tiered-compaction-spark 1.2s ease-in-out infinite alternate; pointer-events: none; }
.dsh-tiered-compaction__legend { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; line-height: 1.4; }
.dsh-tiered-compaction__marks { display: inline-flex; flex-wrap: wrap; gap: 5px 10px; min-width: 0; }
.dsh-tiered-compaction__mark-label { white-space: nowrap; }
.dsh-tiered-compaction__window { display: flex; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l2, #e2e6ea); color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 12px; }
.dsh-tiered-compaction__window strong { color: var(--dsw-alias-label-secondary, #58636e); font-weight: 550; }
.dsh-tiered-compaction__stats-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 22px 0 10px; }
.dsh-tiered-compaction__stats-title { margin: 0; color: var(--dsw-alias-label-primary, #1f2328); font-size: 14px; font-weight: 600; }
.dsh-tiered-compaction__since { color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; white-space: nowrap; }
.dsh-tiered-compaction__stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.dsh-tiered-compaction__stat { min-width: 0; padding: 13px 14px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 11px; background: var(--dsw-alias-bg-module-platform, #fff); }
.dsh-tiered-compaction__stat-label { min-height: 34px; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; line-height: 1.45; }
.dsh-tiered-compaction__stat-value { margin-top: 7px; color: var(--dsw-alias-label-primary, #1f2328); font-size: 22px; font-weight: 650; letter-spacing: -.02em; line-height: 1; }
.dsh-tiered-compaction__stat-note { min-height: 17px; margin-top: 7px; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 10px; overflow-wrap: anywhere; }
.dsh-tiered-compaction__empty { display: flex; align-items: center; gap: 9px; padding: 14px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 11px; color: var(--dsw-alias-label-tertiary, #7a8591); background: var(--dsw-alias-bg-module-platform, #fff); font-size: 12px; }
.dsh-tiered-compaction__hud { position: fixed; width: min(258px, calc(100vw - 24px)); min-width: 0; padding: 13px 13px 12px; font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; font-synthesis: none; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; font-kerning: normal;  border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .10)); border-radius: var(--dsw-radius-lg, 16px); color: var(--dsw-alias-label-primary, #0f1115); background: color-mix(in srgb, var(--dsw-specific-input-major, #ffffff) 88%, rgba(248, 250, 252, .80)); box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .95), 0 12px 32px -6px rgba(15, 17, 21, .09), 0 3px 10px -2px rgba(15, 17, 21, .04); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(36px) saturate(160%)); -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(36px) saturate(160%)); cursor: move; user-select: none; touch-action: none; transform-origin: bottom right; animation: dsh-tiered-compaction-hud-in .32s cubic-bezier(.16, 1, .3, 1); transition: box-shadow .24s ease, border-color .24s ease, background-color .24s ease; }
.dsh-tiered-compaction__hud::before { content: ""; position: absolute; left: 10%; right: 10%; top: 0; height: 2px; border-radius: 999px; background: linear-gradient(90deg, transparent 0%, #00f5d4 20%, #3b82f6 42%, #8b5cf6 62%, #ec4899 82%, transparent 100%); background-size: 200% 100%; opacity: .88; animation: dsh-tiered-compaction-aurora 3.4s linear infinite; pointer-events: none; }
.dsh-tiered-compaction__hud[data-testid="overlay-capsule"]::before { display: none; }
.dsh-tiered-compaction__hud:hover { border-color: color-mix(in srgb, #8b5cf6 28%, var(--dsw-alias-border-l3, rgba(15, 17, 21, .14))); box-shadow: inset 0 .5px 0 0 #ffffff, 0 16px 38px -6px rgba(15, 17, 21, .12), 0 4px 14px -2px rgba(139, 92, 246, .08); }
.dsh-tiered-compaction__hud:active { box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .9), 0 18px 42px -4px rgba(15, 17, 21, .15), 0 6px 14px -2px rgba(15, 17, 21, .07); }
body[data-ds-dark-theme] .dsh-tiered-compaction__hud, [data-ds-dark-theme] .dsh-tiered-compaction__hud { border-color: rgba(255, 255, 255, .10); background: color-mix(in srgb, var(--dsw-specific-input-major, #2c2c2e) 86%, rgba(22, 22, 25, .80)); box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .09), 0 16px 38px -6px rgba(0, 0, 0, .54), 0 4px 14px -2px rgba(139, 92, 246, .14); }
body[data-ds-dark-theme] .dsh-tiered-compaction__hud:hover, [data-ds-dark-theme] .dsh-tiered-compaction__hud:hover { border-color: color-mix(in srgb, #8b5cf6 36%, rgba(255, 255, 255, .16)); box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .12), 0 20px 44px -6px rgba(0, 0, 0, .62), 0 6px 18px -2px rgba(139, 92, 246, .22); }
.dsh-tiered-compaction__hud-head { display: flex; align-items: center; gap: 7px; min-width: 0; margin-bottom: 8px; }
.dsh-tiered-compaction__hud-dot { position: relative; box-shadow: 0 0 8px var(--dsh-tiered-tone, #10a37f); }
.dsh-tiered-compaction__hud-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--dsh-tiered-tone, #10a37f); opacity: 0; pointer-events: none; animation: dsh-tiered-compaction-dot-ripple 2.2s cubic-bezier(0, 0, .2, 1) infinite; }
.dsh-tiered-compaction__hud-title { min-width: 0; color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; font-weight: 600; letter-spacing: 0; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tiered-compaction__hud-title-pkg { display: inline-block; width: 0; font-size: 0; opacity: 0; overflow: hidden; vertical-align: baseline; }
.dsh-tiered-compaction__hud-status { min-width: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tiered-compaction__hud:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); outline-offset: 2px; }
.dsh-tiered-compaction__hud button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); outline-offset: 1px; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track { height: 12px !important; margin-top: 0 !important; margin-bottom: 0 !important; background: transparent !important; border-radius: 0 !important; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track-fill { top: 2px !important; height: 8px !important; border-radius: 999px !important; background: rgba(15, 17, 21, .08) !important; box-shadow: inset 0 1px 2px rgba(15, 17, 21, .10) !important; overflow: hidden; }
body[data-ds-dark-theme] .dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track-fill, [data-ds-dark-theme] .dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track-fill { background: rgba(255, 255, 255, .10) !important; box-shadow: inset 0 1px 2px rgba(0, 0, 0, .42) !important; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-fill { top: 2px !important; height: 8px !important; border-radius: 999px !important; overflow: visible !important; transform-origin: left center; background-image: linear-gradient(90deg, #00f5d4 0%, #3b82f6 25%, #8b5cf6 50%, #ec4899 75%, #00f5d4 100%) !important; background-size: 240% 100% !important; box-shadow: 0 0 12px rgba(59, 130, 246, .52), 0 0 22px rgba(139, 92, 246, .32), inset 0 1px 0 rgba(255, 255, 255, .45) !important; animation: dsh-tiered-compaction-aurora 2.8s linear infinite, dsh-tiered-compaction-bar-grow .65s cubic-bezier(.16, 1, .3, 1) !important; transition: width .52s cubic-bezier(.16, 1, .3, 1) !important; }
.dsh-tiered-compaction__hud[data-tone="remind"] .dsh-tiered-compaction__bar-fill { background-image: linear-gradient(90deg, #10b981 0%, #06b6d4 22%, #6366f1 45%, #ec4899 68%, #f59e0b 88%, #10b981 100%) !important; box-shadow: 0 0 13px rgba(236, 72, 153, .48), 0 0 22px rgba(245, 158, 11, .36), inset 0 1px 0 rgba(255, 255, 255, .45) !important; }
.dsh-tiered-compaction__hud[data-tone="evict"] .dsh-tiered-compaction__bar-fill { background-image: linear-gradient(90deg, #f59e0b 0%, #ec4899 28%, #8b5cf6 52%, #ef4444 76%, #ff0055 92%, #f59e0b 100%) !important; box-shadow: 0 0 14px rgba(239, 68, 68, .58), 0 0 24px rgba(236, 72, 153, .40), inset 0 1px 0 rgba(255, 255, 255, .45) !important; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track > div[title] { top: .5px !important; height: 11px !important; width: 1.5px !important; transform: translateX(-50%) !important; border-radius: 999px !important; background: rgba(15, 17, 21, .42) !important; box-shadow: 0 0 0 1px rgba(255, 255, 255, .88) !important; z-index: 3; transition: transform .18s ease, background-color .18s ease; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__bar:hover .dsh-tiered-compaction__bar-track > div[title] { transform: translateX(-50%) scaleY(1.16) !important; }
body[data-ds-dark-theme] .dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track > div[title], [data-ds-dark-theme] .dsh-tiered-compaction__hud .dsh-tiered-compaction__bar-track > div[title] { background: rgba(255, 255, 255, .68) !important; box-shadow: 0 0 0 1px rgba(24, 24, 27, .88) !important; }
.dsh-tiered-compaction__hud-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #81858c); cursor: pointer; font-size: 13.5px; line-height: 1; transition: background-color .16s ease, color .16s ease, transform .14s cubic-bezier(.22, 1, .36, 1); }
.dsh-tiered-compaction__hud-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .08)) !important; color: var(--dsw-alias-label-primary, #0f1115) !important; transform: scale(1.06); }
.dsh-tiered-compaction__hud-btn:active { transform: scale(.90); }
.dsh-tiered-compaction__hud-hero { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin-bottom: 8px; }
.dsh-tiered-compaction__hud-pct { flex: 0 0 auto; font-family: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; font-size: 26px; font-weight: 700; letter-spacing: -.02em; line-height: 1; font-variant-numeric: tabular-nums; transition: color .28s ease, transform .24s cubic-bezier(.16, 1, .3, 1); }
.dsh-tiered-compaction__hud-pct-num { display: inline-block; background-image: linear-gradient(100deg, var(--dsh-tiered-tone, #10a37f) 0%, #3b82f6 30%, #8b5cf6 55%, #ec4899 78%, var(--dsh-tiered-tone, #10a37f) 100%); background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; filter: drop-shadow(0 2px 8px color-mix(in srgb, #8b5cf6 30%, transparent)); animation: dsh-tiered-compaction-aurora 4s linear infinite, dsh-tiered-compaction-pct-pop .55s cubic-bezier(.34, 1.56, .64, 1); }
@keyframes dsh-tiered-compaction-pct-pop { 0% { transform: translateY(5px) scale(.86); opacity: 0; } 100% { transform: none; opacity: 1; } }
body .dsh-tiered-compaction__hud[data-testid="overlay-hud"] { background-image: radial-gradient(200px circle at var(--tc-mx, 88%) var(--tc-my, -20%), var(--tc-spot, rgba(139, 92, 246, .10)), transparent 70%); }
body[data-ds-dark-theme] .dsh-tiered-compaction__hud, [data-ds-dark-theme] .dsh-tiered-compaction__hud { --tc-spot: rgba(139, 92, 246, .22); }
.dsh-tiered-compaction__chip-num { display: inline-block; animation: dsh-tiered-compaction-pct-pop .5s cubic-bezier(.34, 1.56, .64, 1) backwards; }
.dsh-tiered-compaction__hud-usage { display: flex; flex-direction: column; align-items: flex-end; gap: 2.5px; min-width: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 11px; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-tiered-compaction__hud-tokens { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 600; letter-spacing: .01em; }
.dsh-tiered-compaction__hud-to-summary { display: inline-flex; align-items: center; padding: 1.5px 6.5px; border-radius: 999px; border: .5px solid color-mix(in srgb, #8b5cf6 24%, transparent); background: linear-gradient(90deg, rgba(6, 182, 212, .08), rgba(139, 92, 246, .10), rgba(236, 72, 153, .08)); color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; font-weight: 400; }
.dsh-tiered-compaction__hud-due { display: inline-flex; align-items: center; padding: 1.5px 6.5px; border-radius: 999px; background: color-mix(in srgb, var(--dsh-tiered-tone, #dc2626) 16%, transparent); color: var(--dsh-tiered-tone, inherit); font-weight: 600; font-size: 11px; }
.dsh-tiered-compaction__chips { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-top: 10px; }
.dsh-tiered-compaction__chip { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 7px 7.5px; border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .075)); border-radius: 10px; background: rgba(255, 255, 255, .68); box-shadow: inset 0 .5px 0 rgba(255, 255, 255, .92), 0 2px 6px -1px rgba(15, 17, 21, .03); color: var(--dsw-alias-label-primary, #0f1115); font-family: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; animation: dsh-tiered-compaction-chip-in .36s cubic-bezier(.16, 1, .3, 1) backwards; transition: background-color .18s ease, border-color .18s ease, box-shadow .18s ease, transform .18s cubic-bezier(.22, 1, .36, 1); }
.dsh-tiered-compaction__chip:nth-child(2) { animation-delay: .04s; }
.dsh-tiered-compaction__chip:nth-child(3) { animation-delay: .08s; }
.dsh-tiered-compaction__chip::before { content: ""; position: absolute; left: 14%; right: 14%; top: 0; height: 1.5px; border-radius: 999px; background: linear-gradient(90deg, #06b6d4, #8b5cf6, #ec4899); transform: scaleX(.35); opacity: .42; transition: transform .22s cubic-bezier(.16, 1, .3, 1), opacity .22s ease; }
body[data-ds-dark-theme] .dsh-tiered-compaction__chip, [data-ds-dark-theme] .dsh-tiered-compaction__chip { background: rgba(255, 255, 255, .048); border-color: rgba(255, 255, 255, .08); box-shadow: inset 0 .5px 0 rgba(255, 255, 255, .06); }
.dsh-tiered-compaction__chip:hover { transform: translateY(-1.5px); background: rgba(255, 255, 255, .92); border-color: rgba(139, 92, 246, .28); box-shadow: inset 0 .5px 0 #ffffff, 0 6px 14px -3px rgba(139, 92, 246, .12); }
.dsh-tiered-compaction__chip:hover::before { transform: scaleX(1); opacity: .95; }
body[data-ds-dark-theme] .dsh-tiered-compaction__chip:hover, [data-ds-dark-theme] .dsh-tiered-compaction__chip:hover { background: rgba(255, 255, 255, .085); border-color: rgba(139, 92, 246, .38); box-shadow: inset 0 .5px 0 rgba(255, 255, 255, .10), 0 6px 14px -3px rgba(139, 92, 246, .22); }
.dsh-tiered-compaction__chip b { color: var(--dsw-alias-label-tertiary, #81858c); font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; font-size: 11px; font-weight: 400; letter-spacing: 0; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; }
.dsh-tiered-compaction__chip-saved { color: color-mix(in srgb, #10a37f 72%, var(--dsw-alias-label-secondary, #61666b)); font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; }
.dsh-tiered-compaction__hud-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 9px; padding-top: 7.5px; border-top: .5px solid var(--dsw-alias-border-l1, rgba(15, 17, 21, .07)); color: var(--dsw-alias-label-tertiary, #81858c); font-size: 11px; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-tiered-compaction__hud-footer-saved { color: var(--dsw-alias-label-secondary, #61666b); font-weight: 600; }
.dsh-tiered-compaction__hud-footer-sep { width: 0; font-size: 0; opacity: 0; overflow: hidden; }
.dsh-tiered-compaction__hud-footer-last { margin-left: auto; color: var(--dsw-alias-label-tertiary, #81858c); overflow: hidden; text-overflow: ellipsis; }
.dsh-tiered-compaction__chip--bump { animation: dsh-tiered-compaction-bump 1.15s cubic-bezier(.16, 1, .3, 1); }
.dsh-tiered-compaction__chip--bump::before { transform: scaleX(1); opacity: 1; }
@keyframes dsh-tiered-compaction-bump { 0% { background: color-mix(in srgb, #8b5cf6 18%, transparent); border-color: #8b5cf6; box-shadow: 0 0 12px rgba(139, 92, 246, .28); } 30% { transform: translateY(-1.5px) scale(1.03); } 100% { transform: translateY(0) scale(1); } }
.dsh-tiered-compaction__alert { margin-top: 7px; padding: 5.5px 7.5px; border-radius: 8px; border: .5px solid color-mix(in srgb, #d97706 26%, transparent); color: var(--dsw-alias-state-warn-label, #b45309); background: color-mix(in srgb, #d97706 10%, transparent); font-size: 11px; line-height: 1.35; animation: dsh-tiered-compaction-hud-in .24s cubic-bezier(.16, 1, .3, 1); }
.dsh-tiered-compaction__auto-hint { margin-top: 6px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 11px; }
.dsh-tiered-compaction__toast { margin-top: 7px; padding: 5.5px 7.5px; border-radius: 8px; border: .5px solid color-mix(in srgb, #10a37f 28%, transparent); color: color-mix(in srgb, #10a37f 84%, var(--dsw-alias-label-primary, #0f1115)); background: color-mix(in srgb, #10a37f 11%, transparent); font-size: 11px; font-weight: 600; letter-spacing: 0; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: dsh-tiered-compaction-fade 4s cubic-bezier(.16, 1, .3, 1) forwards; }
@keyframes dsh-tiered-compaction-fade { 0% { opacity: 0; transform: translateY(3px) scale(.98); } 8%, 78% { opacity: 1; transform: translateY(0) scale(1); } 100% { opacity: .45; transform: translateY(0) scale(1); } }
.dsh-tiered-compaction__bar-fill--pulse { animation: dsh-tiered-compaction-aurora 1.6s linear infinite, dsh-tiered-compaction-pulse 1.1s cubic-bezier(.16, 1, .3, 1) 2 !important; }
@keyframes dsh-tiered-compaction-pulse { 0% { box-shadow: 0 0 0 0 rgba(139, 92, 246, .65), 0 0 18px rgba(6, 182, 212, .65); filter: brightness(1.22); } 100% { box-shadow: 0 0 0 8px transparent, 0 0 12px rgba(59, 130, 246, .48); filter: brightness(1); } }
@keyframes dsh-tiered-compaction-aurora { 0% { background-position: 0% 50%; } 100% { background-position: 240% 50%; } }
@keyframes dsh-tiered-compaction-bar-grow { 0% { transform: scaleX(0); opacity: .5; } 100% { transform: scaleX(1); opacity: 1; } }
@keyframes dsh-tiered-compaction-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@keyframes dsh-tiered-compaction-spark { 0% { transform: translateY(-50%) scale(.88); opacity: .85; } 100% { transform: translateY(-50%) scale(1.18); opacity: 1; } }
@keyframes dsh-tiered-compaction-hud-in { 0% { opacity: 0; transform: translateY(6px) scale(.96); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes dsh-tiered-compaction-chip-in { 0% { opacity: 0; transform: translateY(4px); } 100% { opacity: 1; transform: translateY(0); } }
@keyframes dsh-tiered-compaction-dot-ripple { 0% { transform: scale(1); opacity: .65; } 75%, 100% { transform: scale(2.6); opacity: 0; } }
.dsh-tiered-compaction__pill, .dsh-tiered-compaction__capsule { display: inline-flex; align-items: center; gap: 7px; padding: 5.5px 11px; border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .09)); border-radius: 999px; color: var(--dsw-alias-label-primary, #0f1115); background: color-mix(in srgb, var(--dsw-specific-input-major, #ffffff) 88%, rgba(248, 250, 252, .80)); box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .92), 0 8px 22px -4px rgba(15, 17, 21, .10), 0 2px 5px rgba(15, 17, 21, .04); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(32px) saturate(160%)); -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(32px) saturate(160%)); cursor: pointer; font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums; transform-origin: bottom right; animation: dsh-tiered-compaction-hud-in .26s cubic-bezier(.16, 1, .3, 1); transition: transform .18s cubic-bezier(.16, 1, .3, 1), box-shadow .18s ease, border-color .18s ease; }
.dsh-tiered-compaction__pill:hover, .dsh-tiered-compaction__capsule:hover { transform: translateY(-1.5px) scale(1.02); border-color: color-mix(in srgb, var(--dsh-tiered-tone, #10a37f) 32%, var(--dsw-alias-border-l2, rgba(15, 17, 21, .14))); box-shadow: inset 0 .5px 0 0 #ffffff, 0 10px 26px -4px rgba(15, 17, 21, .14); }
.dsh-tiered-compaction__pill:active, .dsh-tiered-compaction__capsule:active { transform: translateY(0) scale(.97); }
body[data-ds-dark-theme] .dsh-tiered-compaction__pill, body[data-ds-dark-theme] .dsh-tiered-compaction__capsule, [data-ds-dark-theme] .dsh-tiered-compaction__pill, [data-ds-dark-theme] .dsh-tiered-compaction__capsule { border-color: rgba(255, 255, 255, .10); background: color-mix(in srgb, var(--dsw-specific-input-major, #2c2c2e) 86%, rgba(22, 22, 25, .80)); box-shadow: inset 0 .5px 0 0 rgba(255, 255, 255, .09), 0 10px 26px -4px rgba(0, 0, 0, .50), 0 2px 6px rgba(0, 0, 0, .30); }
.dsh-tiered-compaction__capsule-pct { font-family: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; color: var(--dsh-tiered-tone, inherit); font-weight: 700; letter-spacing: -.02em; }
.dsh-tiered-compaction__total { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 9px; padding: 11px 14px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 11px; background: var(--dsw-alias-bg-module-platform, #fff); font-size: 12px; }
.dsh-tiered-compaction__total strong { color: var(--dsw-alias-label-primary, #1f2328); font-size: 16px; font-weight: 650; }
.dsh-tiered-compaction__total span { color: var(--dsw-alias-label-tertiary, #7a8591); }
.dsh-tiered-compaction__last { margin-top: 8px; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; overflow-wrap: anywhere; }
.dsh-tiered-compaction__hud-toggle { margin-top: 12px; padding: 5px 10px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 8px; color: var(--dsw-alias-label-secondary, #58636e); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
.dsh-tiered-compaction__hud-toggle:focus-visible, .dsh-tiered-compaction__pill:focus-visible, .dsh-tiered-compaction__capsule:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #176b61)); outline-offset: 2px; }
@media (max-width: 560px) {
    .dsh-tiered-compaction { padding: 18px 14px; }
    .dsh-tiered-compaction__header { gap: 10px; }
    .dsh-tiered-compaction__title { font-size: 16px; }
    .dsh-tiered-compaction__state { max-width: 46%; }
    .dsh-tiered-compaction__hero { padding: 14px; }
    .dsh-tiered-compaction__stats { gap: 7px; }
    .dsh-tiered-compaction__stat { padding: 11px; }
}
@media (max-width: 370px) {
    .dsh-tiered-compaction { padding-inline: 10px; }
    .dsh-tiered-compaction__header { display: block; }
    .dsh-tiered-compaction__state { margin-top: 10px; max-width: 100%; }
    .dsh-tiered-compaction__hero-head { align-items: flex-start; flex-direction: column; gap: 8px; }
    .dsh-tiered-compaction__pressure { font-size: 24px; }
    .dsh-tiered-compaction__stats { grid-template-columns: 1fr 1fr; }
    .dsh-tiered-compaction__stat-label { min-height: 46px; }
}
@media (prefers-reduced-motion: reduce) {
    .dsh-tiered-compaction__hud, .dsh-tiered-compaction__bar-fill, .dsh-tiered-compaction__chip, .dsh-tiered-compaction__pill, .dsh-tiered-compaction__capsule, .dsh-tiered-compaction__hud-btn { transition: none !important; animation: none !important; }
    .dsh-tiered-compaction__bar-fill--pulse, .dsh-tiered-compaction__chip--bump, .dsh-tiered-compaction__toast, .dsh-tiered-compaction__hud-dot, .dsh-tiered-compaction__hud-pct-num, .dsh-tiered-compaction__chip-num { animation: none !important; }
}
`;

/** 宿主已有 renderer 样式时只补一次插件私有样式；若已存在旧样式节点则原地更新文本，保证热加载立即生效。 */
function ensureUiStyles() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (typeof document.querySelector === "function") {
        const existing =
            document.querySelector(`style[data-plugin="${MODULE_ID}"]`) ??
            document.querySelector(`style[data-plugin-css="${UI_STYLE_ID}"]`) ??
            document.querySelector('style[data-plugin-css^="tiered-compaction-ui"]');
        if (existing) {
            existing.dataset.plugin = MODULE_ID;
            existing.dataset.pluginCss = UI_STYLE_ID;
            if (existing.textContent !== UI_CSS) existing.textContent = UI_CSS;
            return;
        }
    }
    const style = document.createElement("style");
    style.dataset.plugin = MODULE_ID;
    style.dataset.pluginCss = UI_STYLE_ID;
    style.textContent = UI_CSS;
    const parent = document.head ?? document.documentElement;
    if (parent && typeof parent.appendChild === "function") parent.appendChild(style);
}

/** 鼠标跟随聚光灯：只写 CSS 变量，不触发 React 重渲。 */
function trackSpotlight(event) {
    const el = event?.currentTarget;
    if (!el || typeof el.getBoundingClientRect !== "function" || !el.style) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    el.style.setProperty("--tc-mx", `${(((event.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
    el.style.setProperty("--tc-my", `${(((event.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
}

window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory(require) {
        ensureUiStyles();
        const React = require("react");
        const h = React.createElement;

        /* ================================================================== *
         * 任务 #7 i18n：语言探测链 + 取词
         * ================================================================== */

        /**
         * 模块级当前语言。为什么不是常量：宿主条目 t 是随渲染注入的（随语言
         * 切换换引用），本地探测链只在「宿主没有 locale 服务」时兜底一次，
         * 切换语言需要宿主重启/重载——探测结果持久化到 localStorage（读偏好
         * 不是写敏感数据，方案 §6.2 已有 localStorage 先例）。
         */
        let activeLocale = I18N_FALLBACK;

        /**
         * navigator 语言 → 支持的 locale。只认 zh 开头（zh-TW 也没有繁体表，
         * 归入 zh 的英文回落更诚实）——与宿主 detectBrowserLocale 的主子标签
         * 匹配同向：zh-CN/zh-TW 都命中 zh。
         * @param {string|undefined} language navigator.language（可能 undefined）
         * @returns {string|null} 支持的 locale，或 null
         */
        function localeFromNavigator(language) {
            if (typeof language !== "string") return null;
            return language.startsWith("zh") ? "zh" : "en";
        }

        /**
         * 探测链（宿主没有下发布局时的兜底，任务 #7 关键决策）：
         *   1. localStorage 记忆（用户手动覆盖的唯一入口）；
         *   2. navigator.language（zh 开头 → zh，否则 en）；
         *   3. 默认 zh（插件文案原生于中文）。
         * 为什么没有显式 config 一级：本插件不引入配置面（零写边界），且
         * localStorage 已承担「用户显式选择」。宿主有 locale 服务时整条链
         * 不生效（见 bindLocaleService）——宿主 preference 永远优先。
         * @returns {string} "zh" | "en"
         */
        function detectLocale() {
            const storage = hudStorage();
            if (storage !== null) {
                try {
                    const raw = storage.getItem(LOCALE_STORAGE_KEY);
                    if (typeof raw === "string" && SUPPORTED_LOCALES.includes(raw)) return raw;
                } catch {
                    /* 存储被禁：跳过这级探测，不崩 */
                }
            }
            const fromNavigator = localeFromNavigator(
                typeof navigator === "undefined" ? undefined : navigator.language,
            );
            if (fromNavigator !== null) return fromNavigator;
            return I18N_FALLBACK;
        }

        /**
         * 本地取词：STRINGS[activeLocale] 缺 key 回落 zh 再缺回落 key 本身。
         * 「回落 key 本身」是缺译的诚实显示（渲染出 key 比渲染 undefined 或
         * 抛错好排查）；d29 的「缺 key 回落 zh 不抛错」用它验证。
         * @param {string} key STRINGS 里的 key
         * @returns {string} 文案
         */
        function localString(key) {
            const dict = STRINGS[activeLocale] ?? STRINGS[I18N_FALLBACK];
            const value = dict[key] ?? STRINGS[I18N_FALLBACK][key];
            return typeof value === "string" ? value : key;
        }

        /**
         * 模板填充：{name} 占位符。与宿主 LocaleRuntime.translate 同款实现
         * （replace 未知占位符原样保留），en 译文里的 {value}/{percent} 靠它。
         * @param {string} template 含 {name} 占位符的模板
         * @param {Record<string, unknown>|null} params 参数
         * @returns {string}
         */
        function fillTemplate(template, params) {
            if (params === null || typeof params !== "object") return template;
            return template.replace(/\{(\w+)\}/g, (match, name) =>
                name in params ? String(params[name]) : match,
            );
        }

        /**
         * 统一取词入口（三入口渲染全走它）。
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 宿主注入的 t，或 null（本地兜底）
         * @param {string} key STRINGS key
         * @param {Record<string, unknown>|null} [params] 模板参数
         * @returns {string}
         */
        function tOf(t, key, params) {
            const template = typeof t === "function" ? t(key, params) : localString(key);
            const safeTemplate = typeof template === "string" ? template : localString(key);
            return fillTemplate(safeTemplate, params);
        }

        /**
         * 宿主 locale 服务接线（plugin-market 同款）：有 locale 服务就注册字典
         * 并让宿主 preference 决定语言——我们的探测链整条让位；没有就跑本地
         * 探测链。为什么用 `"locale" in ctx` 而不是声明 inject：d23 断言
         * plugin.inject 恒为 ["slots"]（既有契约），且 "in" 探测在服务未提供时
         * 不抛错（cordis has-trap 只查 props 注册表），能优雅降级。
         * @param {object} ctx cordis 插件上下文
         * @returns {((key: string, params?: Record<string, unknown>) => string)|null} t 函数，或 null
         */
        function bindLocaleService(ctx) {
            if (typeof ctx !== "object" || ctx === null || !("locale" in ctx)) return null;
            const locale = ctx.locale;
            if (locale === null || typeof locale !== "object") return null;
            if (typeof locale.register !== "function" || typeof locale.bind !== "function") return null;
            locale.register(I18N_NS, { zh: STRINGS.zh, en: STRINGS.en });
            return locale.bind(I18N_NS);
        }

        /** 本地探测链结果（宿主无 locale 服务时的一次性模块状态）。 */
        function initLocalLocale() {
            activeLocale = detectLocale();
            return null;
        }

        /**
         * 拼状态请求地址：同源路径 + 可选 `?session=<id>`。
         * 为什么不用整 URL：宿主页面可能挂在带 query/hash 的地址上，只取同源
         * 路径部分，避免把页面自己的参数带进请求；但我们**自己的** session 参数
         * 必须保留——旧实现取 `.pathname` 会把它一起丢掉。
         * @param {string|null} sessionId 当前主视图会话；null 时不带参数（退回最近活跃会话）
         * @returns {string}
         */
        function statusUrlOf(sessionId) {
            const url = new URL(STATUS_PATH, document.baseURI);
            url.search = "";
            url.hash = "";
            if (typeof sessionId === "string" && sessionId.length > 0) {
                url.searchParams.set("session", sessionId);
            }
            return `${url.pathname}${url.search}`;
        }

        /**
         * 取一次状态快照。
         * @param {string|null} sessionId 见 statusUrlOf
         * @returns {Promise<object>} 路由 JSON
         */
        function fetchStatusSnapshot(sessionId) {
            const url = statusUrlOf(sessionId);
            return fetch(url).then((response) => {
                // 非 200 一律当失败：#9 反向验证摘除路由后必须落到「数据不可用」
                if (!response.ok) throw new Error(`status route responded ${response.status}`);
                return response.json();
            });
        }

        /**
         * 把路由 JSON 收窄成渲染快照（JSDoc 口径：unknown 收窄不隐式信任）。
         * status/pressure 任一缺失即整条判为不可用：半截数据比「数据不可用」
         * 更容易骗过用户（后续扩字段时继续沿用这条规则）。
         * window（任务 #5 侧栏用）：它是可选字段——缺了/形状不对只让窗口这一项
         * 不显示（null），不把整条快照打成不可用；压力与状态仍可渲染。
         * @param {unknown} payload 路由 JSON
         * @returns {{phase: string, status: string|null, pressure: string|null, pressureWidth: string|null, window: number|null, layers: object|null, sinceText: string|null}}
         */
        function buildReadySnapshot(payload) {
            if (payload === null || typeof payload !== "object") return UNAVAILABLE_SNAPSHOT;
            if (typeof payload.status !== "string") return UNAVAILABLE_SNAPSHOT;
            if (typeof payload.pressure !== "number" || !Number.isFinite(payload.pressure)) {
                return UNAVAILABLE_SNAPSHOT;
            }
            return {
                phase: PHASE_READY,
                status: payload.status,
                pressure: formatPressure(payload.pressure),
                // 填充宽度的唯一定型点：与数值文本同源（percentNumberOf），
                // 保证条形与文本永远说的是同一个数
                pressureWidth: `${percentNumberOf(payload.pressure)}%`,
                // 窗口大小：只做形状校验（有限非负数），不做换算——
                // 显示层直接用它，避免与 host 半的口径分叉
                window: windowNumberOf(payload.window),
                // 四层数字（任务 #6）：与 window 同规——缺了只让这一项不显示，
                // 不把整条快照打成不可用
                layers: layersOf(payload.layers),
                sinceText: sinceTextOf(payload.since),
                // 保留快照所属会话：入口据此判断「是不是当前会话的数据」
                sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
                // beta4：实际用量（与 window 同口径，缺了只是不显示用量）
                currentTokens: windowNumberOf(payload.currentTokens),
                // 自动压缩健康：旧服务端根本没有这个字段 → autoCheckKnown=false，界面
                // 一个字都不说；有字段但为 null → 「从没跑过」，这正是要报警的情形
                autoCheckKnown: Object.prototype.hasOwnProperty.call(payload, "autoCheckedAt"),
                autoCheckedAt: epochMsOf(payload.autoCheckedAt),
                autoEnabled: typeof payload.autoEnabled === "boolean" ? payload.autoEnabled : null,
                lastCompaction: lastCompactionOf(payload.lastCompaction),
            };
        }

        /** 外部 epoch ms → 有限正数或 null。 */
        function epochMsOf(raw) {
            return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
        }

        /**
         * 路由里的 lastCompaction → 可显示的最近一次摘要（本会话）。
         * 只收窄展示要用的字段；at 不可读就整条不显示（时间是这一行的主语）。
         * @param {unknown} raw
         * @returns {{at: number, trigger: string|null, shadowedNodes: number|null, shadowedTokenCount: number|null, summaryTokenCount: number|null}|null}
         */
        function lastCompactionOf(raw) {
            if (raw === null || typeof raw !== "object") return null;
            const at = epochMsOf(raw.at);
            if (at === null) return null;
            return {
                at,
                trigger: raw.trigger === "auto" || raw.trigger === "manual" ? raw.trigger : null,
                shadowedNodes: countOf(raw.shadowedNodes),
                shadowedTokenCount: countOf(raw.shadowedTokenCount),
                summaryTokenCount: countOf(raw.summaryTokenCount),
            };
        }

        /** 外部计数 → 有限非负数或 null（layersOf 与 lastCompactionOf 共用一条规则）。 */
        function countOf(value) {
            return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        }

        /**
         * 路由里的 layers → 可显示的四层数字（任务 #6）。
         * 只挑方案 §3.1 要展示的四个字段并做形状校验；缺字段给 null，
         * 渲染层对 null 显示 0 之外的诚实处理（见 layersTextOf）。
         * bytesSaved 一并收窄：只给落盘行的省字节数用，不参与四层计数。
         * @param {unknown} raw 路由 JSON 的 layers 字段
         * @returns {{l12Processed: number|null, spillCount: number|null, l3Evicted: number|null, l4Summaries: number|null, bytesSaved: number|null}|null}
         */
        function layersOf(raw) {
            if (raw === null || typeof raw !== "object") return null;
            const pick = countOf;
            return {
                l12Processed: pick(raw.l12Processed),
                spillCount: pick(raw.spillCount),
                l3Evicted: pick(raw.l3Evicted),
                l4Summaries: pick(raw.l4Summaries),
                // 旧口径：L1+L2 合计省下的**字符**数，仅在新字段缺失时兜底显示
                bytesSaved: pick(raw.l12BytesSaved),
                // beta4 新字段：分层 UTF-8 字节 + 估算 token
                l4ProcessSummaries: pick(raw.l4ProcessSummaries),
                l1Folded: pick(raw.l1Folded),
                l1BytesSaved: pick(raw.l1BytesSaved),
                l2BytesSaved: pick(raw.l2BytesSaved),
                l12TokensSaved: pick(raw.l12TokensSaved),
                l3TokensSaved: pick(raw.l3TokensSaved),
                l4TokensSaved: pick(raw.l4TokensSaved),
            };
        }

        /**
         * token 数 → 紧凑文本：<1000 原样，≥1000 用 k（一位小数），≥1e6 用 M。
         * 只做展示换算，不改数值来源。
         * @param {number} value 非负 token 数
         * @returns {string}
         */
        function formatTokens(value) {
            // 整数位够多时去掉 ".0"：245000 → "245k"，66100 → "66.1k"
            // ≥100k 取整（262144 → "262k"），更小的保留一位（66100 → "66.1k"）
            const trim = (text) => text.replace(/\.0$/, "");
            if (value >= 1e6) return `${trim((value / 1e6).toFixed(1))}M`;
            if (value >= 100000) return `${Math.round(value / 1000)}k`;
            if (value >= 1000) return `${trim((value / 1000).toFixed(1))}k`;
            return String(Math.round(value));
        }

        /**
         * 总节省（A.5）：三项估算 token 求和；三项全缺时 null（不拿 0 冒充）。
         * @param {object|null} layers 收窄后的 layers
         * @returns {number|null}
         */
        function totalTokensSavedOf(layers) {
            if (layers === null) return null;
            const parts = [layers.l12TokensSaved, layers.l3TokensSaved, layers.l4TokensSaved].filter(
                (value) => value !== null,
            );
            if (parts.length === 0) return null;
            return parts.reduce((sum, value) => sum + value, 0);
        }

        /**
         * 自动压缩健康（A.6）：
         *   - 旧服务端（无 autoCheckedAt 字段）或自动压缩被关 → null（什么都不显示）；
         *   - 压力 ≥ 驱逐线且从没检查过/上次检查超过 120 秒 → {kind:"stale"} 报警；
         *   - 最近检查过 → {kind:"recent", seconds}；
         *   - 其余（低压力且从没检查过）→ null。
         * @param {object} snapshot 渲染快照
         * @param {number} now Date.now()
         * @returns {{kind: "stale"}|{kind: "recent", seconds: number}|null}
         */
        function autoHealthOf(snapshot, now) {
            if (snapshot.phase !== PHASE_READY || snapshot.autoCheckKnown !== true) return null;
            if (snapshot.autoEnabled === false) return null;
            const ratio = pressureRatioOf(snapshot);
            const at = snapshot.autoCheckedAt;
            const stale = at === null || now - at > AUTO_CHECK_STALE_MS;
            if (ratio !== null && ratio >= PRESSURE_EVICT_RATIO && stale) return { kind: "stale" };
            if (at !== null && !stale) return { kind: "recent", seconds: Math.max(0, Math.round((now - at) / 1000)) };
            return null;
        }

        /** 自动压缩健康 → vnode（设置页与 HUD 共用；compact 只影响 key/样式不影响文案）。 */
        function autoHealthNodeOf(snapshot, t, keyPrefix) {
            const health = autoHealthOf(snapshot, Date.now());
            if (health === null) return null;
            if (health.kind === "stale") {
                return h(
                    "div",
                    { key: `${keyPrefix}-auto`, className: "dsh-tiered-compaction__alert", role: "alert", "data-testid": "auto-warning" },
                    tOf(t, "autoNotRunning"),
                );
            }
            return h(
                "div",
                { key: `${keyPrefix}-auto`, className: "dsh-tiered-compaction__auto-hint", "data-testid": "auto-checked" },
                tOf(t, "autoCheckedAgo", { seconds: health.seconds }),
            );
        }

        /**
         * 路由里的 since（epoch ms）→ 本地 HH:mm（任务 #6「自 HH:mm 起」）。
         * 缺失/非数字/非法时间一律 null——宁可不标，也不显示 "NaN:NaN"。
         * @param {unknown} raw 路由 JSON 的 since 字段
         * @returns {string|null}
         */
        function sinceTextOf(raw) {
            if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
            const date = new Date(raw);
            if (Number.isNaN(date.getTime())) return null;
            const pad2 = (value) => String(value).padStart(2, "0");
            return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
        }

        /**
         * 载荷里的省字节数 → 可读文本（任务 #6）。
         * 显示口径：≥1MB 用 MB（一位小数），≥1KB 用 KB（整数），否则原样字节数；
         * 形状不对给 null，渲染层不显示省字节括号。
         * @param {unknown} raw 路由 JSON 的 layers.l12BytesSaved
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {string|null}
         */
        function bytesSavedTextOf(raw, t) {
            if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
            const KB = 1024;
            const MB = KB * 1024;
            if (raw >= MB) return tOf(t, "bytesSavedMB", { value: (raw / MB).toFixed(1) });
            if (raw >= KB) return tOf(t, "bytesSavedKB", { value: Math.round(raw / KB) });
            return tOf(t, "bytesSavedBytes", { value: raw });
        }

        /**
         * 路由里的 window → 可显示的数字或 null（外部数据不隐式信任）。
         * @param {unknown} raw 路由 JSON 的 window 字段
         * @returns {number|null}
         */
        function windowNumberOf(raw) {
            if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
            return raw;
        }

        /** pressure 是 0~1 小数（host 半 toFixed(4) 口径），显示层唯一的 ×100 点。 */
        const PERCENT_SCALE = 100;
        /** 填充宽度最多保留两位小数：host 半 pressure 只有 4 位小数，两位无损。 */
        const WIDTH_MAX_DECIMALS = 2;
        /** 舍入放大因子：×100 再按两位小数取整，消除浮点尾差的惟一算点。 */
        const WIDTH_ROUND_FACTOR = 10 ** WIDTH_MAX_DECIMALS;

        /**
         * ratio → 百分数。为什么先舍入：二进制浮点有尾差（0.27×100 得
         * 27.000000000000004），直接拼进宽度会出现假精度字符串。
         */
        function percentNumberOf(ratio) {
            return Math.round(ratio * PERCENT_SCALE * WIDTH_ROUND_FACTOR) / WIDTH_ROUND_FACTOR;
        }

        /** pressure 的数值文本（一位小数百分比），宽度与文本同源于 percentNumberOf。 */
        function formatPressure(pressure) {
            return `${percentNumberOf(pressure).toFixed(1)}%`;
        }

        /** 轮询间隔：5 秒。状态读数是只读内存计数，取一次很便宜。 */
        const STATUS_POLL_MS = 5000;

        /**
         * 模块级共享状态源：两个入口（设置分区、悬浮 HUD）读同一份快照。
         *
         * 旧实现每个入口各自 `useEffect(..., [])` 挂载时 fetch 一次，之后永不刷新：
         * 数据从 0 变成非零也看不到，两个入口还可能显示不同时刻的数。
         *   - target：当前请求的会话 id（undefined=还没请求过，null=不带参数）；
         *   - requestSeq：只认最后一次发出的请求，避免 A 的迟到响应盖掉 B；
         *   - 有订阅者时每 5 秒轮询，页面不可见时跳过，订阅清零时停表。
         */
        const statusStore = {
            snapshot: LOADING_SNAPSHOT,
            target: undefined,
            listeners: new Set(),
            requestSeq: 0,
            timer: null,
            onVisibility: null,
            // beta4：相邻两次同会话快照之间的变化（HUD 的「已压缩」提示与芯片高亮）
            lastDrop: null,
            chipBumps: {},
        };

        /**
         * HUD 四层芯片计数：L1 用 l1Folded（旧服务端回落 l12Processed），其余直取。
         * @param {object|null} layers 收窄后的 layers
         * @returns {{l1: number|null, l2: number|null, l3: number|null, l4: number|null}}
         */
        function chipCountsOf(layers) {
            if (layers === null || layers === undefined) return { l12: null, l3: null, l4: null };
            return {
                l12: layers.l12Processed,
                l3: layers.l3Evicted,
                l4: layers.l4Summaries,
            };
        }

        /**
         * 比较相邻两次快照（只认同一个字符串会话 id 的 ready 快照：换会话的压力
         * 落差不是压缩，无 id 的旧服务端无法判定「同一会话」，宁可不提示）。
         *   - 压力降 ≥ 10 个百分点 → lastDrop（节省 = 降幅 × 窗口，窗口未知时 null）；
         *   - 某层计数上涨 → chipBumps[key]。
         */
        function noteTransition(prev, next) {
            if (prev.phase !== PHASE_READY || next.phase !== PHASE_READY) return;
            if (typeof next.sessionId !== "string" || prev.sessionId !== next.sessionId) return;
            const now = Date.now();
            const from = pressureRatioOf(prev);
            const to = pressureRatioOf(next);
            if (from !== null && to !== null && Math.round((from - to) * 10000) >= PRESSURE_DROP_TRIGGER_BP) {
                statusStore.lastDrop = {
                    sessionId: next.sessionId,
                    from,
                    to,
                    saved: next.window !== null && next.window > 0 ? Math.round((from - to) * next.window) : null,
                    at: now,
                };
            }
            const before = chipCountsOf(prev.layers);
            const after = chipCountsOf(next.layers);
            for (const chip of HUD_CHIPS) {
                if (before[chip.key] !== null && after[chip.key] !== null && after[chip.key] > before[chip.key]) {
                    statusStore.chipBumps[chip.key] = { sessionId: next.sessionId, at: now };
                }
            }
        }

        /** 页面是否不可见（没有 document 的环境按可见处理）。 */
        function isPageHidden() {
            return typeof document !== "undefined" && document.visibilityState === "hidden";
        }

        /** 写入新快照并通知所有订阅者。 */
        function publishStatus(snapshot) {
            noteTransition(statusStore.snapshot, snapshot);
            statusStore.snapshot = snapshot;
            for (const listener of [...statusStore.listeners]) listener(snapshot);
        }

        /**
         * 按当前 target 取一次数。失败分支必须显式落到 UNAVAILABLE，不允许空 catch。
         * @returns {Promise<void>}
         */
        function refreshStatus() {
            statusStore.requestSeq += 1;
            const seq = statusStore.requestSeq;
            const target = statusStore.target ?? null;
            return fetchStatusSnapshot(target).then(
                (payload) => {
                    if (seq === statusStore.requestSeq) publishStatus(buildReadySnapshot(payload));
                },
                () => {
                    if (seq === statusStore.requestSeq) publishStatus(UNAVAILABLE_SNAPSHOT);
                },
            );
        }

        /** 启动轮询与可见性监听（幂等）。宿主环境缺定时器时只保留「切会话即刷新」。 */
        function startStatusPolling() {
            if (statusStore.timer === null && typeof setInterval === "function") {
                statusStore.timer = setInterval(() => {
                    if (!isPageHidden()) refreshStatus();
                }, STATUS_POLL_MS);
            }
            if (
                statusStore.onVisibility === null &&
                typeof document !== "undefined" &&
                typeof document.addEventListener === "function"
            ) {
                // 页面重新可见时立刻补一次，不等下一个 5 秒
                statusStore.onVisibility = () => {
                    if (!isPageHidden()) refreshStatus();
                };
                document.addEventListener("visibilitychange", statusStore.onVisibility);
            }
        }

        /** 最后一个订阅者离开时停表、摘监听。 */
        function stopStatusPolling() {
            if (statusStore.timer !== null && typeof clearInterval === "function") {
                clearInterval(statusStore.timer);
            }
            statusStore.timer = null;
            if (statusStore.onVisibility !== null && typeof document?.removeEventListener === "function") {
                document.removeEventListener("visibilitychange", statusStore.onVisibility);
            }
            statusStore.onVisibility = null;
        }

        /**
         * 订阅共享快照并声明当前会话。
         * 会话变了、或这是第一个订阅者（之前的快照可能已过期）时立即刷新；
         * 同一会话的第二个入口直接复用现有快照，不重复请求。
         * @param {(snapshot: object) => void} listener
         * @param {string|null} sessionId
         * @returns {() => void} 退订
         */
        function attachStatus(listener, sessionId) {
            const wasIdle = statusStore.listeners.size === 0;
            statusStore.listeners.add(listener);
            listener(statusStore.snapshot);
            const changed = statusStore.target !== sessionId;
            statusStore.target = sessionId;
            if (wasIdle) startStatusPolling();
            if (changed || wasIdle) refreshStatus();
            return () => {
                statusStore.listeners.delete(listener);
                if (statusStore.listeners.size === 0) stopStatusPolling();
            };
        }

        /**
         * 当前主视图会话 id。
         * 依据：shell.overlay / settings.section 两个槽位的 standardProps 都带
         * `useSessions`；会话摘要的 `retainedBy.mainView > 0` 表示它正显示在主视图
         * （宿主 dsh-client-ui-cordis 的 CordisPanel 用同一判据取当前会话）。
         * 拿不到 useSessions 时返回 null，请求退回无参数（host 用最近活跃会话）。
         * @param {Function|undefined} useSessions 宿主注入的 hook
         * @returns {string|null}
         */
        function useCurrentSessionId(useSessions) {
            if (typeof useSessions !== "function") return null;
            const id = useSessions((state) => {
                const byId = state?.byId;
                if (byId === null || typeof byId !== "object") return null;
                for (const session of Object.values(byId)) {
                    if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id ?? null;
                }
                return null;
            });
            return typeof id === "string" && id.length > 0 ? id : null;
        }

        /**
         * 读共享快照（两入口同源）。快照属于别的会话时按「加载中」处理，
         * 不把上一个会话的数字显示在当前会话下。
         * @param {string|null} sessionId 当前会话；null=不区分会话
         */
        function useStatusSnapshot(sessionId = null) {
            const [snapshot, setSnapshot] = React.useState(statusStore.snapshot);
            React.useEffect(() => attachStatus(setSnapshot, sessionId), [sessionId]);
            if (
                sessionId !== null &&
                snapshot.phase === PHASE_READY &&
                snapshot.sessionId !== sessionId
            ) {
                return LOADING_SNAPSHOT;
            }
            return snapshot;
        }

        /** 快照 → 状态文本（三入口共用，t 随渲染注入）。压力数值不在这里：它是条旁数值文本的职责。 */
        function statusLineOf(snapshot, t) {
            if (snapshot.phase === PHASE_UNAVAILABLE) return tOf(t, UNAVAILABLE_TEXT_KEY);
            if (snapshot.phase === PHASE_LOADING) return tOf(t, LOADING_TEXT_KEY);
            return `${tOf(t, "statusPrefix")} ${snapshot.status}`;
        }

        /* ------------------------------------------------------------------ *
         * #5 侧栏面板：精简态文案（两个侧栏入口共用，取数/换算与设置页同源）
         * ------------------------------------------------------------------ */

        /**
         * 状态字：已知状态给 STRINGS 短名，其余原样透出（见 STATUS_LABELS 的取舍）。
         * ok/warn 不在表里，因此仍显示 API 原字面——既有断言与「数值可追溯到
         * API」的性质都不变。
         * 为什么用 hasOwnProperty 而不是直接下标：status 是外部数据，`toString`
         * 这类原型键会让下标命中原型上的函数，渲染出 `function toString()…`。
         * @param {string} status API 的 status 字段
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {string}
         */
        function statusWordOf(status, t) {
            if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) return status;
            return tOf(t, STATUS_LABELS[status]);
        }

        /* ------------------------------------------------------------------ *
         * #6 四层活动统计：设置页数字块（数据源同一份快照）
         * ------------------------------------------------------------------ */

        /**
         * 「自 HH:mm 起」标注：只有 ready 且 since 可读时才出。
         * sinceTextOf 已把非法值收窄成 null，这里 null 就整段省略，
         * 绝不渲染 "自 NaN:NaN 起"（en 口径 "since HH:mm"，HH:mm 保持本地时间）。
         * @param {{phase: string, sinceText: string|null}} snapshot 渲染快照
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {string|null}
         */
        function sinceMarkOf(snapshot, t) {
            if (snapshot.phase !== PHASE_READY) return null;
            if (snapshot.sinceText === null) return null;
            return tOf(t, "sinceMark", { time: snapshot.sinceText });
        }

        /**
         * 设置页四层数字块：方案 §3.1 顺序（折叠/落盘/驱逐/摘要），
         * 落盘附省字节数。数字 0 也如实显示——那是「真的在跑」的证据。
         * 某项缺失（null）显示「—」：与 0 有区别（0 是读到的，— 是没拿到），
         * 不用假零冒充读数。
         * @param {{phase: string, layers: object|null}} snapshot 渲染快照
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {object|null} 区块 vnode；无数据（非 ready 或 layers 缺失）时不渲染
         */
        function layersBlockOf(snapshot, t) {
            if (snapshot.phase !== PHASE_READY || snapshot.layers === null) return null;
            const layers = snapshot.layers;

            const rowOf = (key) => {
                // 折叠行：新服务端给 L1 自己的折叠数，旧服务端回落 L1+L2 处理数
                const raw = key === "l12Processed" ? layers.l1Folded ?? layers.l12Processed : layers[key];
                const value = raw ?? tOf(t, "missingValue");
                const note = layerNoteOf(layers, key, t);
                return h(
                    "div",
                    { key: `layer-${key}`, className: "dsh-tiered-compaction__stat", "data-layer": key },
                    h("div", { className: "dsh-tiered-compaction__stat-label" }, tOf(t, LAYERS_LABELS[key])),
                    h("div", { className: "dsh-tiered-compaction__stat-value" }, String(value)),
                    h("div", { className: "dsh-tiered-compaction__stat-note" }, note ?? " "),
                );
            };

            const sinceMark = sinceMarkOf(snapshot, t);
            return h(
                "section",
                { key: "layer-stats", "data-testid": LAYERS_BLOCK_TESTID },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__stats-head" },
                    h("h2", { className: "dsh-tiered-compaction__stats-title" }, tOf(t, "statsTitle")),
                    sinceMark === null
                        ? h("span", { className: "dsh-tiered-compaction__since" }, tOf(t, "sessionPrefix"))
                        : h("span", { className: "dsh-tiered-compaction__since" }, sinceMark),
                ),
                h(
                    "div",
                    { className: "dsh-tiered-compaction__stats" },
                    rowOf("l12Processed"),
                    rowOf("spillCount"),
                    rowOf("l3Evicted"),
                    rowOf("l4Summaries"),
                ),
                totalSavedNodeOf(snapshot, t),
                lastCompactionNodeOf(snapshot, t),
            );
        }

        /** 新服务端是否给了分层字节（任一存在即按新口径显示，不再回落合计字符）。 */
        function hasPerLayerBytes(layers) {
            return layers.l1BytesSaved !== null || layers.l2BytesSaved !== null;
        }

        /**
         * 四层卡片的附注行（A.1/A.2）：
         *   - 折叠：l1BytesSaved（字节）；
         *   - 落盘：l2BytesSaved（字节）；新字段都缺时回落旧 l12BytesSaved，
         *     明确标「L1+L2 合计（字符）」——它从来不是字节，也不只属于落盘；
         *   - 驱逐 / 摘要：估算 token（l3TokensSaved / l4TokensSaved）；
         *     摘要另附全进程摘要数作淡色提示。
         * 0 或缺失都不出附注（0 字节没有信息量，缺失不编数）。
         * @returns {string|null}
         */
        function layerNoteOf(layers, key, t) {
            if (key === "l12Processed") return bytesSavedTextOf(layers.l1BytesSaved, t);
            if (key === "spillCount") {
                if (hasPerLayerBytes(layers)) return bytesSavedTextOf(layers.l2BytesSaved, t);
                if (layers.bytesSaved === null || layers.bytesSaved <= 0) return null;
                return tOf(t, "combinedCharsSaved", { value: formatTokens(layers.bytesSaved) });
            }
            const tokensNote = (value) =>
                value === null || value <= 0 ? null : tOf(t, "tokensApprox", { value: formatTokens(value) });
            if (key === "l3Evicted") return tokensNote(layers.l3TokensSaved);
            if (key === "l4Summaries") {
                // l4Summaries 是本会话口径（beta4 服务端），标明范围；全进程数作淡色补充
                const parts = [tOf(t, "sessionScope"), tokensNote(layers.l4TokensSaved)];
                if (layers.l4ProcessSummaries !== null) {
                    parts.push(tOf(t, "processSummaries", { count: layers.l4ProcessSummaries }));
                }
                const text = parts.filter((part) => part !== null).join(" · ");
                return text === "" ? null : text;
            }
            return null;
        }

        /** 总节省（A.5）卡：三项估算 token 全缺时不渲染。 */
        function totalSavedNodeOf(snapshot, t) {
            const total = totalTokensSavedOf(snapshot.layers);
            if (total === null) return null;
            const windowSize = snapshot.window;
            const ofWindow =
                windowSize !== null && windowSize > 0
                    ? tOf(t, "totalSavedOfWindow", { percent: `${((total / windowSize) * PERCENT_SCALE).toFixed(1)}%` })
                    : null;
            return h(
                "div",
                { key: "total-saved", className: "dsh-tiered-compaction__total", "data-testid": "total-saved" },
                h("span", null, tOf(t, "totalSavedTitle")),
                h("strong", null, tOf(t, "totalSavedValue", { value: formatTokens(total) })),
                ofWindow === null ? null : h("span", null, ofWindow),
            );
        }

        /** 最近一次摘要行（C）：本会话没有提交过摘要时不渲染。 */
        function lastCompactionNodeOf(snapshot, t) {
            const last = snapshot.lastCompaction;
            if (last === null || last === undefined) return null;
            const dash = tOf(t, "missingValue");
            const tokenText = (value) => (value === null ? dash : formatTokens(value));
            const trigger =
                last.trigger === "auto" ? tOf(t, "triggerAuto") : last.trigger === "manual" ? tOf(t, "triggerManual") : dash;
            return h(
                "div",
                { key: "last-compaction", className: "dsh-tiered-compaction__last", "data-testid": "last-compaction" },
                tOf(t, "lastCompaction", {
                    time: sinceTextOf(last.at) ?? dash,
                    trigger,
                    nodes: last.shadowedNodes ?? dash,
                    shadowed: tokenText(last.shadowedTokenCount),
                    summary: tokenText(last.summaryTokenCount),
                }),
            );
        }

        /* ------------------------------------------------------------------ *
         * #4 悬浮 HUD 的状态源：localStorage（关闭状态 + 拖动位置）
         * ------------------------------------------------------------------ */

        /** 默认 HUD 状态：未关闭、无存档位置（走角落）。每次返回新对象，避免共享可变值。 */
        function defaultHudState() {
            return { closed: false, collapsed: false, left: null, top: null };
        }

        /**
         * 取存储对象。为什么整个访问都包 try/catch：Safari 隐私模式、站点数据
         * 被禁时连 `window.localStorage` 这个属性读取本身就会抛 SecurityError。
         * 取不到就返回 null——上层据此降级为「不记住」，而不是崩掉整个 overlay。
         * @returns {Storage|null} 可用的存储，或 null
         */
        function hudStorage() {
            try {
                const storage = window.localStorage;
                return storage && typeof storage.getItem === "function" ? storage : null;
            } catch {
                return null;
            }
        }

        /**
         * 存档 → HUD 状态（外部数据不可信：逐字段校验，坏值一律退回默认）。
         * @param {unknown} raw 已 JSON.parse 的对象，或任意值
         * beta4 加了 collapsed：旧存档没有这个键 → false（展开），旧用户升级后外观不变。
         * @returns {{closed: boolean, collapsed: boolean, left: number|null, top: number|null}}
         */
        function normalizeHudState(raw) {
            if (raw === null || typeof raw !== "object") return defaultHudState();
            const left = Number.isFinite(raw.left) ? raw.left : null;
            const top = Number.isFinite(raw.top) ? raw.top : null;
            return { closed: raw.closed === true, collapsed: raw.collapsed === true, left, top };
        }

        /**
         * 读存档（组件的惰性初值）。JSON 坏掉/写坏/被别的插件占用都按「没存过」
         * 处理：宁可回到角落显示，也不要因为一段脏字符串白屏。
         * @returns {{closed: boolean, left: number|null, top: number|null}}
         */
        function readHudState() {
            const storage = hudStorage();
            if (storage === null) return defaultHudState();
            try {
                const raw = storage.getItem(HUD_STATE_KEY);
                if (typeof raw !== "string" || raw === "") return defaultHudState();
                return normalizeHudState(JSON.parse(raw));
            } catch {
                return defaultHudState();
            }
        }

        /**
         * 写存档。写失败（配额满/隐私模式）只失去「记住」能力，渲染照常——
         * 这正是验收要求的降级方向：宁可这次不记，也不能让 overlay 崩掉。
         * @param {{closed: boolean, left: number|null, top: number|null}} state 待存状态
         */
        function persistHudState(state) {
            const storage = hudStorage();
            if (storage === null) return;
            try {
                storage.setItem(
                    HUD_STATE_KEY,
                    JSON.stringify({
                        closed: state.closed === true,
                        collapsed: state.collapsed === true,
                        left: Number.isFinite(state.left) ? Math.round(state.left) : null,
                        top: Number.isFinite(state.top) ? Math.round(state.top) : null,
                    }),
                );
            } catch {
                /* 见 JSDoc：失败即放弃记忆，不往上抛 */
            }
        }

        /**
         * HUD 状态的模块级订阅表（beta4 B.1）：设置页的「显示悬浮窗」开关与 HUD
         * 自己的关闭/恢复/收起都写同一个存档，靠这张表让两处同帧同步；另挂
         * window 的 storage 事件，其他标签页改了存档也能跟上。
         */
        const hudStateListeners = new Set();

        /** 写存档并通知所有订阅者（存档写失败也照常通知：本页仍要切换）。 */
        function writeHudState(next) {
            const normalized = normalizeHudState(next);
            persistHudState(normalized);
            for (const listener of [...hudStateListeners]) listener(normalized);
            return normalized;
        }

        /**
         * 订阅 HUD 状态变化。
         * @param {(state: object) => void} listener
         * @returns {() => void} 退订
         */
        function attachHudState(listener) {
            hudStateListeners.add(listener);
            let onStorage = null;
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
                onStorage = (event) => {
                    if (event?.key === HUD_STATE_KEY) listener(readHudState());
                };
                window.addEventListener("storage", onStorage);
            }
            return () => {
                hudStateListeners.delete(listener);
                if (onStorage !== null && typeof window.removeEventListener === "function") {
                    window.removeEventListener("storage", onStorage);
                }
            };
        }

        /**
         * 组件读 HUD 状态（惰性读存档 + 订阅同步）。
         * 注意调用顺序：必须排在 useStatusSnapshot 之前——d23/d25 的 mock react
         * 只保留最后一个 effect 去驱动取数，状态订阅必须是最后一个 effect。
         * @returns {[object, (state: object) => void]} [规范化状态, 本地 setter]
         */
        function useHudState() {
            const [raw, setRaw] = React.useState(readHudState);
            React.useEffect(() => attachHudState(setRaw), []);
            return [normalizeHudState(raw), setRaw];
        }

        /* ------------------------------------------------------------------ *
         * #4 压力配色（只做视觉提示，数值仍来自 API）
         * ------------------------------------------------------------------ */

        /**
         * 快照 → 0~1 压力比例（配色分档的输入）。从 pressureWidth 反解而不给快照
         * 加字段：宽度是 buildReadySnapshot 的唯一定型点，反解保证配色、条宽、
         * 数值文本永远说的是同一个数；非 ready 相位没有比例（配色走未知档）。
         * @param {{phase: string, pressureWidth: string|null}} snapshot 渲染快照
         * @returns {number|null} 0~1 比例，无数据为 null
         */
        function pressureRatioOf(snapshot) {
            if (snapshot.phase !== PHASE_READY || typeof snapshot.pressureWidth !== "string") return null;
            const percent = Number.parseFloat(snapshot.pressureWidth);
            if (!Number.isFinite(percent)) return null;
            return percent / PERCENT_SCALE;
        }

        /**
         * 压力 → 档位名（切点即 70%/80% 两条镜像阈值，与刻度线同源）。
         * @param {{phase: string, pressureWidth: string|null}} snapshot 渲染快照
         * @returns {string} PRESSURE_TONE_* 之一
         */
        function pressureToneOf(snapshot) {
            const ratio = pressureRatioOf(snapshot);
            if (ratio === null) return PRESSURE_TONE_UNKNOWN;
            if (ratio >= PRESSURE_EVICT_RATIO) return PRESSURE_TONE_EVICT;
            if (ratio >= PRESSURE_REMIND_RATIO) return PRESSURE_TONE_REMIND;
            return PRESSURE_TONE_CALM;
        }

        /* ------------------------------------------------------------------ *
         * #4 拖动：按下 → 移动 → 松开，位置落 localStorage
         * ------------------------------------------------------------------ */

        /**
         * 事件族：有 PointerEvent 就用 pointer 一套（鼠标/触控/笔统一），
         * 否则退回 mouse 一套（老浏览器不认 pointerdown，拖不动）。
         * @returns {{down: string, move: string, up: string, cancel: string|null}} 事件名
         */
        function dragChannel() {
            if (typeof window !== "undefined" && typeof window.PointerEvent === "function") {
                return { down: "onPointerDown", move: "pointermove", up: "pointerup", cancel: "pointercancel" };
            }
            return { down: "onMouseDown", move: "mousemove", up: "mouseup", cancel: null };
        }

        /**
         * 事件 → 指针坐标。pointer/mouse 直接给 clientX/Y；touch 事件坐标在
         * touches[0] 上。取不到有限数就当没有这个事件（不猜坐标）。
         * @param {object|null} event 宿主事件
         * @returns {{x: number, y: number}|null} 坐标
         */
        function pointerPointOf(event) {
            if (event === null || typeof event !== "object") return null;
            const touch = Array.isArray(event.touches) ? event.touches[0] : null;
            const source = touch ?? event;
            const x = Number(source.clientX);
            const y = Number(source.clientY);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return { x, y };
        }

        /**
         * 拖动起点：已拖动过（有存档 left/top）就接着那里拖；首次拖动取元素
         * 实际屏幕位置（角落定位下 left/top 并不在 state 里）；都取不到退回 0。
         * @param {{left: number|null, top: number|null}} state 当前 HUD 状态
         * @param {object|null} event 按下事件
         * @returns {{left: number, top: number}} 起点（像素，相对视口）
         */
        function dragOriginOf(state, event) {
            if (Number.isFinite(state.left) && Number.isFinite(state.top)) {
                return clampHudPosition(state.left, state.top);
            }
            const target = event?.currentTarget;
            if (target && typeof target.getBoundingClientRect === "function") {
                const rect = target.getBoundingClientRect();
                if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
                    return { left: rect.left, top: rect.top };
                }
            }
            return { left: 0, top: 0 };
        }

        /** 像素渲染文本：取整，避免 subpixel 让 left 值抖成 12.000001px。 */
        function pixelOf(value) {
            return `${Math.round(value)}px`;
        }

        /**
         * HUD 定位样式：拖动过用 left/top（同时清掉 right/bottom，否则 fixed
         * 下两者会互相拉扯宽度），没拖过回到角落。
         * @param {{left: number|null, top: number|null}} state HUD 状态
         * @returns {object} 内联样式
         */
        function hudPositionStyleOf(state) {
            if (Number.isFinite(state.left) && Number.isFinite(state.top)) {
                const position = clampHudPosition(state.left, state.top);
                return {
                    ...HUD_BASE_STYLE,
                    left: pixelOf(position.left),
                    top: pixelOf(position.top),
                    right: "auto",
                    bottom: "auto",
                };
            }
            return { ...HUD_BASE_STYLE, right: OVERLAY_CORNER_OFFSET, bottom: OVERLAY_SAFE_BOTTOM };
        }

        /**
         * 当前拖动会话。同一时刻只可能有一个（单指针），拖完即清空。
         * 为什么放在组件外：move/up 必须挂在 document 上（指针拖出盒子后仍在
         * 元素外），跨事件回调需要同一份会话数据；且组件内不能用 useRef——
         * 宿主注入的 react 版本未必带它，不赌。
         * @type {null|{startX: number, startY: number, originLeft: number, originTop: number, left: number, top: number, moved: boolean, apply: Function, commit: Function}}
         */
        let dragSession = null;

        /** 监听是否已挂：按会话去重，避免 pointerdown 与 mousedown 双触发时重复挂。 */
        let dragListenersAttached = false;

        /** 拖动中：只更新渲染，不落盘（每帧写 localStorage 会卡）。 */
        function moveDrag(event) {
            if (dragSession === null) return;
            const point = pointerPointOf(event);
            if (point === null) return;
            const position = clampHudPosition(
                dragSession.originLeft + (point.x - dragSession.startX),
                dragSession.originTop + (point.y - dragSession.startY),
            );
            dragSession.left = position.left;
            dragSession.top = position.top;
            dragSession.moved = true;
            dragSession.apply({ closed: false, collapsed: dragSession.collapsed === true, left: dragSession.left, top: dragSession.top });
        }

        /** 拖动结束：只在真拖动过时落盘（单纯点一下不改变存档）。 */
        function endDrag() {
            if (dragSession === null) return;
            const finished = dragSession;
            dragSession = null;
            detachDragListeners();
            if (!finished.moved) return;
            finished.commit({
                closed: false,
                collapsed: finished.collapsed === true,
                left: Math.round(finished.left),
                top: Math.round(finished.top),
            });
        }

        /** 挂 document 监听（拖出盒子仍能收到 move/up，解决「拖到一半丢失」）。 */
        function attachDragListeners() {
            if (dragListenersAttached) return;
            if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
            const channel = dragChannel();
            document.addEventListener(channel.move, moveDrag);
            document.addEventListener(channel.up, endDrag);
            if (channel.cancel !== null) document.addEventListener(channel.cancel, endDrag);
            dragListenersAttached = true;
        }

        /** 卸载 document 监听：拖完必须摘掉，否则每次拖动都多积一对监听。 */
        function detachDragListeners() {
            if (!dragListenersAttached) return;
            if (typeof document === "undefined" || typeof document.removeEventListener !== "function") return;
            const channel = dragChannel();
            document.removeEventListener(channel.move, moveDrag);
            document.removeEventListener(channel.up, endDrag);
            if (channel.cancel !== null) document.removeEventListener(channel.cancel, endDrag);
            dragListenersAttached = false;
        }

        /** 阻止事件冒泡：关闭按钮的按下不能顺带把 HUD 拖起来。 */
        function stopPropagationOf(event) {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        }

        /**
         * 压力条的数值文本按快照相位取值：只有 ready 态来自 API；loading/
         * unavailable 显各自的占位文本——不在无数据时渲染假数字（任务 #3）。
         * ready 的具体数值早已在 buildReadySnapshot 收窄处定型，这里不再计算。
         * @param {{phase: string, pressure: string|null}} snapshot 渲染快照
         * @returns {string} 数值文本或占位文本
         */
        function pressureValueTextOf(snapshot, t) {
            if (snapshot.phase === PHASE_READY) return snapshot.pressure ?? "";
            if (snapshot.phase === PHASE_UNAVAILABLE) return tOf(t, UNAVAILABLE_TEXT_KEY);
            return tOf(t, LOADING_TEXT_KEY);
        }

        /**
         * 一条刻度线（竖线）：left 取自系内阈值（PRESSURE_MARKS），防止渲染
         * 分支里出现第二个 70/80/82 数字源；title 提供悬停可读的语义标签。
         * @param {{value: number, percent: string, key: string}} mark PRESSURE_MARKS 的条目
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {object} 刻度线 vnode
         */
        function renderPressureMark(mark, t) {
            return h("div", {
                key: mark.key,
                title: tOf(t, mark.key, { percent: mark.percent }),
                style: { ...BAR_MARK_BASE_STYLE, left: `${percentNumberOf(mark.value)}%` },
            });
        }

        /**
         * 刻度线图例行：三个阈值的全称横排（「70% 提醒线 80% 驱逐线 …」），
         * 仅全尺寸入口渲染；overlay 空间小，靠条上的凸齿与 title 表达。
         * @param {((key: string, params?: Record<string, unknown>) => string)|null} t 取词函数
         * @returns {string} 图例文本
         */
        function renderMarkLegend(t) {
            return PRESSURE_MARKS.map((mark) => tOf(t, mark.key, { percent: mark.percent })).join("　·　");
        }

        /**
         * 压力条区块（任务 #3 注入点）：条 + 三刻度线 + 数值文本（三入口共用），
         * 通过 options 控制紧凑程度——overlay 设 compact 隐藏图例并把数值并入
         * 条下行的尾部（方案 §3.3 可视空间小，但条与三线必须保留）。
         * overlay 再传 valueColor 让数值文字跟着压力档位变色（#4 颜色随压力），
         * 数值本身仍来自 API，颜色只是同一份数据的视觉表达。
         * 非数据相位不渲染假数字：宽度为 0（无空条误导），数值文本走占位文案。
         * @param {{phase: string, pressureWidth: string|null}} snapshot 渲染快照
         * @param {{compact: boolean, valueColor?: string, t?: ((key: string, params?: Record<string, unknown>) => string)|null}} options 紧凑开关 + 数值色 + 取词函数
         * @returns {object} 区块 vnode
         */
        function pressureBarBlockOf(snapshot, options) {
            const t = options.t ?? null;
            const valueText = pressureValueTextOf(snapshot, t);
            const fillStyle =
                snapshot.phase === PHASE_READY && snapshot.pressureWidth !== null
                    ? { ...BAR_FILL_STYLE, width: snapshot.pressureWidth }
                    : { ...BAR_FILL_STYLE, width: "0%" };

            const markNodes = PRESSURE_MARKS.map((mark) => renderPressureMark(mark, t));
            // beta9：HUD 紧凑版把大号压力值放在条上方，右侧挂用量（options.aside）
            if (options.compact) {
                return h(
                    "div",
                    { key: "pressure-bar", className: "dsh-tiered-compaction__bar", "data-testid": "pressure-bar" },
                    h(
                        "div",
                        { className: "dsh-tiered-compaction__hud-hero" },
                        h(
                            "span",
                            { key: "pressure-value", "data-testid": "pressure-inline-value", className: "dsh-tiered-compaction__hud-pct", style: { color: options.valueColor } },
                            h("span", { key: valueText, className: "dsh-tiered-compaction__hud-pct-num" }, valueText),
                        ),
                        options.aside ?? null,
                    ),
                    h(
                        "div",
                        { className: "dsh-tiered-compaction__bar-track", style: BAR_STYLE },
                        h("div", { className: "dsh-tiered-compaction__bar-track-fill", style: BAR_TRACK_STYLE }),
                        h("div", {
                            className: options.pulse === true
                                ? "dsh-tiered-compaction__bar-fill dsh-tiered-compaction__bar-fill--pulse"
                                : "dsh-tiered-compaction__bar-fill",
                            "data-testid": "pressure-fill",
                            style: fillStyle,
                        }),
                        markNodes,
                    ),
                );
            }
            return h(
                "div",
                { key: "pressure-bar", className: "dsh-tiered-compaction__bar", "data-testid": "pressure-bar" },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__bar-track", style: BAR_STYLE },
                    h("div", { className: "dsh-tiered-compaction__bar-track-fill", style: BAR_TRACK_STYLE }),
                    h("div", {
                        className: options.pulse === true
                            ? "dsh-tiered-compaction__bar-fill dsh-tiered-compaction__bar-fill--pulse"
                            : "dsh-tiered-compaction__bar-fill",
                        "data-testid": "pressure-fill",
                        style: fillStyle,
                    }),
                    markNodes,
                ),
                h(
                    "div",
                    { className: "dsh-tiered-compaction__legend", style: BAR_LEGEND_ROW_STYLE },
                    ...(options.compact
                        ? []
                        : [
                              h(
                                  "span",
                                  { key: "marks-legend", className: "dsh-tiered-compaction__marks" },
                                  PRESSURE_MARKS.map((mark) =>
                                      h(
                                          "span",
                                          { key: mark.key, className: "dsh-tiered-compaction__mark-label" },
                                          tOf(t, mark.key, { percent: mark.percent }),
                                      ),
                                  ),
                              ),
                          ]),
                    h(
                        "span",
                        { key: "pressure-value", "data-testid": "pressure-inline-value", style: { marginLeft: options.compact ? "auto" : undefined, color: options.valueColor } },
                        valueText,
                    ),
                ),
            );
        }

        /**
         * 状态文本 + 压力条（三入口共用）：入口之间只差外围（标题/图例/HUD 壳），
         * 数据区永远同一份实现，避免三个入口各写一遍渲染分支。
         * options.statusText 供侧栏换成自己的状态字（状态字表只影响文案，
         * 数值仍来自同一快照）；不传就沿用三入口共用的 statusLineOf。
         * @param {{phase: string}} snapshot 渲染快照
         * @param {{compact: boolean, valueColor?: string, statusText?: string, t?: ((key: string, params?: Record<string, unknown>) => string)|null}} options 紧凑开关 + 数值色 + 状态文案 + 取词函数
         * @returns {object[]} 状态行与压力条 vnodes
         */
        function panelBodyOf(snapshot, options) {
            const isCompact = options.compact === true;
            const t = options.t ?? null;
            const body = [];
            if (options.showStatus !== false) {
                body.push(
                    h(
                        "div",
                        { key: "status-line", className: "dsh-tiered-compaction__status-line", style: isCompact ? HUD_STATUS_STYLE : undefined },
                        options.statusText ?? statusLineOf(snapshot, t),
                    ),
                );
            }
            body.push(pressureBarBlockOf(snapshot, options));
            return body;
        }

        /**
         * 设置页全量面板：状态徽标、压力卡、四层统计卡片。
         * 所有内容使用宿主 Design Tokens；非 ready 相位不出假数字。
         */
        function StatusPanel(props) {
            ensureUiStyles();
            const t = typeof props.t === "function" ? props.t : null;
            // useHudState 必须在 useStatusSnapshot 之前（见 useHudState 注释）
            const [hudState, setHudState] = useHudState();
            const snapshot = useStatusSnapshot(useCurrentSessionId(props?.useSessions));
            const hudShown = !hudState.closed;
            const hudToggle = h(
                "button",
                {
                    key: "hud-toggle",
                    type: "button",
                    role: "switch",
                    "aria-checked": hudShown ? "true" : "false",
                    "data-testid": "settings-hud-toggle",
                    className: "dsh-tiered-compaction__hud-toggle",
                    onClick: () => setHudState(writeHudState({ ...hudState, closed: hudShown })),
                },
                `${hudShown ? "☑" : "☐"} ${tOf(t, "hudShow")}`,
            );
            const layersBlock = layersBlockOf(snapshot, t);
            const toneKey = pressureToneOf(snapshot);
            const tone = PRESSURE_TONES[toneKey];
            const statusText = statusLineOf(snapshot, t);
            const pressureText = pressureValueTextOf(snapshot, t);
            return h(
                "div",
                {
                    "data-surface": props.surface,
                    "data-testid": "settings-panel",
                    className: "dsh-tiered-compaction",
                    style: { "--dsh-tiered-tone": tone.color },
                },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__header" },
                    h(
                        "div",
                        { className: "dsh-tiered-compaction__identity" },
                        h("div", { className: "dsh-tiered-compaction__mark", "aria-hidden": "true" }, "◉"),
                        h(
                            "div",
                            null,
                            h("p", { className: "dsh-tiered-compaction__eyebrow" }, "tiered-compaction"),
                            h("h1", { className: "dsh-tiered-compaction__title" }, tOf(t, PANEL_TITLE_KEY)),
                        ),
                    ),
                    h(
                        "div",
                        { className: "dsh-tiered-compaction__state", "data-tone": toneKey, title: statusText },
                        h("span", { className: "dsh-tiered-compaction__state-dot", style: { backgroundColor: tone.color }, "aria-hidden": "true" }),
                        statusText,
                    ),
                ),
                h(
                    "section",
                    { className: "dsh-tiered-compaction__hero", "data-testid": "pressure-card" },
                    h(
                        "div",
                        { className: "dsh-tiered-compaction__hero-head" },
                        h("div", { className: "dsh-tiered-compaction__hero-label" }, tOf(t, "pressurePrefix")),
                        h("div", { className: "dsh-tiered-compaction__pressure", "data-testid": "pressure-value" }, pressureText),
                    ),
                    ...panelBodyOf(snapshot, { compact: false, t, showStatus: false, valueColor: tone.color }),
                    snapshot.window === null
                        ? null
                        : h(
                              "div",
                              { className: "dsh-tiered-compaction__window" },
                              h("span", null, tOf(t, "windowPrefix")),
                              h(
                                  "strong",
                                  null,
                                  snapshot.currentTokens === null
                                      ? String(snapshot.window)
                                      : tOf(t, "usageTokens", {
                                            current: formatTokens(snapshot.currentTokens),
                                            window: formatTokens(snapshot.window),
                                        }),
                              ),
                          ),
                    autoHealthNodeOf(snapshot, t, "settings"),
                ),
                layersBlock,
                hudToggle,
            );
        }

        /**
         * 悬浮 HUD（任务 #4，方案 §3.3）：角落常驻 + 可拖动 + 颜色随压力 + 可关闭。
         * 关闭状态与拖动位置都存在 localStorage（HUD_STATE_KEY）：
         *   - 启动时按存档决定「渲不渲染」「从哪开始」，这就是「关闭后重启不再出现」
         *     的渲染侧全部逻辑（宿主重启=重新加载本模块=重读存档）；
         *   - 读写失败一律降级为「不记住」，绝不让 overlay 崩掉。
         * 关闭后返回 null：槽位仍注册着，但不出任何 DOM。
         */
        function OverlayHud(props) {
            ensureUiStyles();
            const t = typeof props?.t === "function" ? props.t : null;
            // useHudState 必须在 useStatusSnapshot 之前（见 useHudState 注释）
            const [state, setHudState] = useHudState();
            const snapshot = useStatusSnapshot(useCurrentSessionId(props?.useSessions));

            const toneKey = pressureToneOf(snapshot);
            const tone = PRESSURE_TONES[toneKey];
            const pressureText = pressureValueTextOf(snapshot, t);

            /** 写存档 + 本地重渲 + 通知设置页开关（写失败也照常切换）。 */
            function updateHud(patch) {
                setHudState(writeHudState({ ...state, ...patch }));
            }

            // B.1 关闭后不消失：角落留一颗恢复胶囊（图标 + 压力），点一下恢复
            if (state.closed) {
                return h(
                    "button",
                    {
                        type: "button",
                        "data-surface": SURFACE_OVERLAY,
                        "data-testid": "overlay-restore",
                        "data-tone": toneKey,
                        className: "dsh-tiered-compaction__pill",
                        "aria-label": tOf(t, "hudRestoreTitle"),
                        title: tOf(t, "hudRestoreTitle"),
                        style: { ...HUD_PILL_STYLE, "--dsh-tiered-tone": tone.color },
                        onClick: () => updateHud({ closed: false }),
                    },
                    h("span", { "aria-hidden": "true" }, PANEL_ICON),
                    h("span", { className: "dsh-tiered-compaction__capsule-pct" }, pressureText),
                );
            }

            /** 关闭：落盘 + 重渲（写入放在前面，重渲出错也不影响「下次不出现」）。 */
            function closeHud() {
                updateHud({ closed: true });
            }

            /** 按下：只记起点并挂 document 监听，位置变化交给 moveDrag。 */
            function beginDrag(event) {
                const point = pointerPointOf(event);
                if (point === null) return;
                const origin = dragOriginOf(state, event);
                dragSession = {
                    startX: point.x,
                    startY: point.y,
                    originLeft: origin.left,
                    originTop: origin.top,
                    left: origin.left,
                    top: origin.top,
                    moved: false,
                    collapsed: state.collapsed,
                    apply: setHudState,
                    commit(next) {
                        setHudState(writeHudState(next));
                    },
                };
                attachDragListeners();
                // 阻止拖拽时选中文本 / 触发浏览器原生拖影
                if (typeof event.preventDefault === "function") event.preventDefault();
            }

            // B.4 收起态：一颗可拖动的胶囊（状态点 + 压力），点一下展开
            if (state.collapsed) {
                return h(
                    "div",
                    {
                        "data-surface": SURFACE_OVERLAY,
                        "data-testid": "overlay-capsule",
                        "data-tone": toneKey,
                        className: "dsh-tiered-compaction__hud",
                        style: { ...hudPositionStyleOf(state), ...HUD_CAPSULE_OVERRIDE_STYLE, "--dsh-tiered-tone": tone.color },
                        [dragChannel().down]: beginDrag,
                    },
                    h(
                        "button",
                        {
                            type: "button",
                            "data-testid": "overlay-expand",
                            className: "dsh-tiered-compaction__capsule",
                            "aria-label": tOf(t, "hudExpandTitle"),
                            title: tOf(t, "hudExpandTitle"),
                            onClick: () => updateHud({ collapsed: false }),
                            onMouseDown: stopPropagationOf,
                            onPointerDown: stopPropagationOf,
                        },
                        h("span", { "aria-hidden": "true", className: "dsh-tiered-compaction__hud-dot", style: { ...HUD_DOT_STYLE, backgroundColor: tone.color } }),
                        h("span", { className: "dsh-tiered-compaction__capsule-pct" }, pressureText),
                    ),
                );
            }

            const now = Date.now();
            const sessionId = snapshot.phase === PHASE_READY ? snapshot.sessionId : null;
            const drop = statusStore.lastDrop;
            const showDrop =
                drop !== null && sessionId !== null && drop.sessionId === sessionId && now - drop.at < COMPACTED_TOAST_MS;
            const statusText = statusLineOf(snapshot, t);
            return h(
                "div",
                {
                    "data-surface": SURFACE_OVERLAY,
                    "data-testid": "overlay-hud",
                    "data-tone": toneKey,
                    role: "status",
                    "aria-live": "polite",
                    tabIndex: 0,
                    className: "dsh-tiered-compaction__hud",
                    style: { ...hudPositionStyleOf(state), "--dsh-tiered-tone": tone.color },
                    [dragChannel().down]: beginDrag,
                    onMouseMove: trackSpotlight,
                },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__hud-head" },
                    h("span", {
                        key: "tone-dot",
                        "data-testid": "overlay-status-dot",
                        "data-tone": toneKey,
                        className: "dsh-tiered-compaction__hud-dot",
                        title: tOf(t, tone.key),
                        style: { ...HUD_DOT_STYLE, backgroundColor: tone.color },
                    }),
                    h(
                        "span",
                        { className: "dsh-tiered-compaction__hud-title" },
                        (() => {
                            const fullTitle = tOf(t, PANEL_TITLE_KEY);
                            const prefix = "tiered-compaction ";
                            if (typeof fullTitle === "string" && fullTitle.startsWith(prefix) && fullTitle.length > prefix.length) {
                                return [
                                    h("span", { key: "pkg", className: "dsh-tiered-compaction__hud-title-pkg" }, prefix),
                                    fullTitle.slice(prefix.length),
                                ];
                            }
                            return fullTitle;
                        })(),
                    ),
                    // beta9：状态正常时不占标题栏，只在读取中/不可用/非 ok 时显示
                    snapshot.phase === PHASE_READY && snapshot.status === "ok"
                        ? null
                        : h("span", { key: "status", className: "dsh-tiered-compaction__hud-status" }, statusText),
                    h(
                        "button",
                        {
                            key: "collapse",
                            type: "button",
                            "data-testid": "overlay-collapse",
                            className: "dsh-tiered-compaction__hud-btn",
                            "aria-label": tOf(t, "hudCollapseTitle"),
                            title: tOf(t, "hudCollapseTitle"),
                            style: { ...HUD_CLOSE_STYLE, marginLeft: "auto", fontSize: "13px", paddingBottom: "3px" },
                            onClick: () => updateHud({ collapsed: true }),
                            onMouseDown: stopPropagationOf,
                            onPointerDown: stopPropagationOf,
                        },
                        "–",
                    ),
                    h(
                        "button",
                        {
                            key: "close",
                            type: "button",
                            "data-testid": "overlay-close",
                            className: "dsh-tiered-compaction__hud-btn",
                            "aria-label": tOf(t, "hudCloseTitle"),
                            title: tOf(t, "hudCloseTitle"),
                            style: { ...HUD_CLOSE_STYLE, marginLeft: "-4px", fontSize: "15px" },
                            onClick: closeHud,
                            // 按下若冒泡到 HUD 就会开始拖动，这里截断
                            onMouseDown: stopPropagationOf,
                            onPointerDown: stopPropagationOf,
                        },
                        "×",
                    ),
                ),
                ...panelBodyOf(snapshot, { compact: true, valueColor: tone.color, t, showStatus: false, pulse: showDrop, aside: hudUsageNodeOf(snapshot, t) }),
                hudChipsNodeOf(snapshot, now, t),
                hudFooterNodeOf(snapshot, t, now),
                hudAutoWarningNodeOf(snapshot, t, now),
                showDrop ? compactedToastNodeOf(drop, t) : null,
            );
        }

        /** B.2 实际用量「245k / 262k tokens」：currentTokens 与 window 都可读才显示。 */
        function hudUsageNodeOf(snapshot, t) {
            if (snapshot.phase !== PHASE_READY || snapshot.currentTokens === null || snapshot.window === null) return null;
            return h(
                "div",
                { key: "usage", className: "dsh-tiered-compaction__hud-usage", "data-testid": "overlay-usage" },
                h("span", { key: "tokens", className: "dsh-tiered-compaction__hud-tokens" }, tOf(t, "usageTokens", { current: formatTokens(snapshot.currentTokens), window: formatTokens(snapshot.window) })),
                toSummaryNodeOf(snapshot, t),
            );
        }

        /** beta8：距第 4 层摘要线（82% 窗口）还剩多少 token；窗口未知时不显示。 */
        function toSummaryNodeOf(snapshot, t) {
            if (!(snapshot.window > 0) || snapshot.autoEnabled === false) return null;
            const left = Math.round(snapshot.window * PRESSURE_LOSSY_FLOOR_RATIO - snapshot.currentTokens);
            const text = left <= 0 ? tOf(t, "summaryDue") : tOf(t, "toSummary", { value: formatTokens(left) });
            return h("span", { key: "to-summary", className: left <= 0 ? "dsh-tiered-compaction__hud-due" : "dsh-tiered-compaction__hud-to-summary" }, text);
        }

        /** beta8：相对时间（分钟粒度足够；未来时刻按刚刚处理）。 */
        function agoTextOf(at, now, t) {
            const minutes = Math.floor(Math.max(0, now - at) / 60000);
            if (minutes < 1) return tOf(t, "agoJustNow");
            if (minutes < 60) return tOf(t, "agoMinutes", { n: minutes });
            const hours = Math.floor(minutes / 60);
            return hours < 24 ? tOf(t, "agoHours", { n: hours }) : tOf(t, "agoDays", { n: Math.floor(hours / 24) });
        }

        /** beta8：HUD 底行「共省 ≈ 1.1M · 上次摘要 12 分钟前」；两项都缺时不渲染。 */
        function hudFooterNodeOf(snapshot, t, now) {
            if (snapshot.phase !== PHASE_READY) return null;
            const parts = [];
            const total = totalTokensSavedOf(snapshot.layers);
            if (total !== null && total > 0) parts.push(tOf(t, "hudFooterSaved", { value: formatTokens(total) }));
            const last = snapshot.lastCompaction;
            if (last !== null && last !== undefined) parts.push(tOf(t, "hudFooterLast", { ago: agoTextOf(last.at, now, t) }));
            if (parts.length === 0) return null;
            if (parts.length === 2) {
                return h(
                    "div",
                    { key: "footer", className: "dsh-tiered-compaction__hud-footer", "data-testid": "overlay-footer" },
                    h("span", { key: "saved", className: "dsh-tiered-compaction__hud-footer-saved" }, parts[0]),
                    h("span", { key: "sep", className: "dsh-tiered-compaction__hud-footer-sep", "aria-hidden": "true" }, " · "),
                    h("span", { key: "last", className: "dsh-tiered-compaction__hud-footer-last" }, parts[1]),
                );
            }
            return h("div", { key: "footer", className: "dsh-tiered-compaction__hud-footer", "data-testid": "overlay-footer" }, parts.join(" · "));
        }

        /**
         * B.3 四层迷你芯片：L1~L4 计数，缺失显示「—」；计数刚上涨的芯片带高亮类。
         * 为什么用 aria-label 不用 title：title 里的「驱逐/摘要」会被当成刻度线
         * 语义标签（d25 按 title 数刻度线），芯片不该混进去。
         */
        /** beta8：芯片后缀「 · 省 268k」；读不到节省量时不显示。 */
        function chipSavedNoteOf(layers, key, t) {
            const value = key === "l12" ? layers.l12TokensSaved : key === "l3" ? layers.l3TokensSaved : layers.l4TokensSaved;
            if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
            return h("span", { className: "dsh-tiered-compaction__chip-saved" }, tOf(t, "chipSaved", { value: formatTokens(value) }));
        }

        function hudChipsNodeOf(snapshot, now, t) {
            if (snapshot.phase !== PHASE_READY || snapshot.layers === null) return null;
            const counts = chipCountsOf(snapshot.layers);
            return h(
                "div",
                { key: "chips", className: "dsh-tiered-compaction__chips", "data-testid": "overlay-chips" },
                HUD_CHIPS.map((chip) => {
                    const bump = statusStore.chipBumps[chip.key];
                    const bumped =
                        bump !== undefined && bump.sessionId === snapshot.sessionId && now - bump.at < CHIP_BUMP_MS;
                    return h(
                        "span",
                        {
                            key: chip.key,
                            "data-chip": chip.key,
                            className: bumped
                                ? "dsh-tiered-compaction__chip dsh-tiered-compaction__chip--bump"
                                : "dsh-tiered-compaction__chip",
                        },
                        h("b", null, tOf(t, chip.titleKey)),
                        h(
                            "span",
                            { key: String(counts[chip.key]), className: "dsh-tiered-compaction__chip-num" },
                            counts[chip.key] === null ? STRINGS.zh.missingValue : String(counts[chip.key]),
                        ),
                        chipSavedNoteOf(snapshot.layers, chip.key, t),
                    );
                }),
            );
        }

        /** B.7 HUD 里的自动压缩告警（只出告警，不出「N 秒前检查」，保持迷你）。 */
        function hudAutoWarningNodeOf(snapshot, t, now) {
            const health = autoHealthOf(snapshot, now);
            if (health === null || health.kind !== "stale") return null;
            return h(
                "div",
                { key: "auto", className: "dsh-tiered-compaction__alert", role: "alert", "data-testid": "overlay-auto-warning" },
                tOf(t, "autoNotRunningShort"),
            );
        }

        /** 压力 0~1 → 整数百分比文本（提示用，例：0.962 → "96%"）。 */
        function wholePercentOf(ratio) {
            return `${Math.round(percentNumberOf(ratio))}%`;
        }

        /** B.6 「已压缩：96% → 40%，节省 ≈ 141k tokens」；窗口未知时不报节省量。 */
        function compactedToastNodeOf(drop, t) {
            const params = { from: wholePercentOf(drop.from), to: wholePercentOf(drop.to) };
            const text =
                drop.saved === null
                    ? tOf(t, "compactedToast", params)
                    : tOf(t, "compactedToastSaved", { ...params, saved: formatTokens(drop.saved) });
            return h(
                "div",
                { key: "toast", className: "dsh-tiered-compaction__toast", role: "status", "data-testid": "overlay-toast" },
                text,
            );
        }

        /**
         * 生成绑定到某个 surface 的组件（包装层不透传 ownerProps，见 StatusPanel 注释）。
         * 两个入口各自有自己的壳，不能合并：
         *   - overlay 走 HUD 壳（#4 的关闭/拖动状态，塞进面板会把两套状态搅在一起）；
         *   - settings 用 StatusPanel（全量视图）。
         * 数据源始终是同一个 useStatusSnapshot（模块级 statusStore）。
         * 只透传宿主 standardProps 里的 `useSessions`：两个入口靠它取当前主视图会话。
         */
        function makeSurfaceComponent(surface, t) {
            if (surface === SURFACE_OVERLAY) {
                return function SurfacePanel(props) {
                    return h(OverlayHud, { t, useSessions: props?.useSessions });
                };
            }
            return function SurfacePanel(props) {
                return h(StatusPanel, { surface, t, useSessions: props?.useSessions });
            };
        }

        /** 注册设置页分区。order=45：跟在宿主与市场分区之后（方案 §2.2 实测口径）。label 用 thunk（dshmarket 同款）。 */
        function injectSettingsSection(ctx, t) {
            // 惯例外包装：slot 声明晚到/抖动时由宿主 reconcile 自动重装
            ctx.slots.inject(SETTINGS_SECTION_SLOT, () =>
                ctx.slots.register(
                    {
                        name: SETTINGS_SECTION_SLOT,
                        id: SETTINGS_SECTION_ID,
                        order: SETTINGS_SECTION_ORDER,
                        // locale 选项：宿主 renderer 给组件注入随语言刷新的 t prop
                        // （renderer:745）；label thunk 同样随 active locale 重解析
                        locale: I18N_NS,
                        label: () => tOf(t, PANEL_TITLE_KEY),
                    },
                    makeSurfaceComponent(SURFACE_SETTINGS, t),
                ),
            );
        }

        /** overlay 槽位是 list：条目必须自带 id/label（宿主不注入，dshmarket 同款）。 */
        function injectShellOverlay(ctx, t) {
            ctx.slots.inject(OVERLAY_SLOT, () =>
                ctx.slots.register(
                    {
                        name: OVERLAY_SLOT,
                        id: OVERLAY_ID,
                        locale: I18N_NS,
                        label: () => OVERLAY_LABEL,
                    },
                    makeSurfaceComponent(SURFACE_OVERLAY, t),
                ),
            );
        }

        return {
            name: MODULE_ID,
            inject: ["slots"],
            apply(ctx) {
                ensureUiStyles();
                // 宿主有 locale 服务 → 字典注册进宿主、语言跟宿主 preference；
                // 没有 → 本地探测链兜底（任务 #7 探测决策，见 bindLocaleService）
                const t = bindLocaleService(ctx) ?? initLocalLocale();
                injectSettingsSection(ctx, t);
                injectShellOverlay(ctx, t);
            },
        };
    },
});
