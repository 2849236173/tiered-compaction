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
        sinceMark: "自 {time} 起",
        sessionPrefix: "本次会话：",
        sessionPrefixWithSince: "本次会话（{since}）：",
        missingValue: "—",
        statsTitle: "活动统计",
         l12Processed: "无损折叠",
        spillCount: "落盘存档",
        l3Evicted: "软压力驱逐",
        l4Summaries: "有损摘要",
        foldShort: "折叠",
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
    }),
    en: Object.freeze({
        panelTitle: "tiered-compaction",
        statusPrefix: "Status",
        loading: "Loading…",
        unavailable: "Data unavailable",
        compacting: "Compacting",
        windowPrefix: "Window",
        sinceMark: "since {time}",
        sessionPrefix: "This session:",
        sessionPrefixWithSince: "This session (since {since}):",
        missingValue: "—",
        statsTitle: "Activity",
         l12Processed: "Lossless fold",
        spillCount: "Spill to disk",
        l3Evicted: "Soft-pressure eviction",
        l4Summaries: "Lossy summary",
        foldShort: "Fold",
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
    [PRESSURE_TONE_CALM]: { color: "#2f9e44", key: "toneCalm" },
    [PRESSURE_TONE_REMIND]: { color: "#f0a020", key: "toneRemind" },
    [PRESSURE_TONE_EVICT]: { color: "#e8590c", key: "toneEvict" },
    [PRESSURE_TONE_UNKNOWN]: { color: "#868e96", key: "toneUnknown" },
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
    layers: null,
    sinceText: null,
});
const UNAVAILABLE_SNAPSHOT = Object.freeze({
    phase: PHASE_UNAVAILABLE,
    status: null,
    pressure: null,
    pressureWidth: null,
    window: null,
    layers: null,
    sinceText: null,
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
    width: "min(224px, calc(100vw - 24px))",
    minWidth: "0",
    padding: "10px 11px",
    border: ".5px solid var(--dsw-alias-border-l2, #e2e6ea)",
    borderRadius: "12px",
    color: "var(--dsw-alias-label-primary, #1f2328)",
    backgroundColor: "var(--dsw-alias-bg-module-platform, rgba(255, 255, 255, .96))",
    boxShadow: "0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 18%, transparent)",
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

/** HUD 拖动边距和估算尺寸：实际宽度由 CSS 限制，足以做安全边界校正。 */
const HUD_EDGE_GAP = 12;
const HUD_ESTIMATED_WIDTH = 224;
const HUD_ESTIMATED_HEIGHT = 76;

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
    marginLeft: "auto",
    padding: "2px 5px",
    border: "0",
    borderRadius: "6px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: "15px",
    lineHeight: "1",
};

/** 所有样式都带插件前缀，跟随宿主 Design Tokens，不污染聊天和设置页。 */
const UI_STYLE_ID = "tiered-compaction-ui-v2";
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
.dsh-tiered-compaction *, .dsh-tiered-compaction *::before, .dsh-tiered-compaction *::after { box-sizing: border-box; }
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
.dsh-tiered-compaction__bar-track { border-radius: 999px; background: var(--dsw-alias-fill-tertiary, color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 10%, transparent)); }
.dsh-tiered-compaction__bar-fill { border-radius: 999px; background: var(--dsh-tiered-tone, var(--dsw-alias-state-business-primary, #4a9eda)); transition: width .22s ease, background-color .22s ease; }
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
.dsh-tiered-compaction__hud { width: min(224px, calc(100vw - 24px)); min-width: 0; padding: 10px 11px; border: .5px solid var(--dsw-alias-border-l2, #e2e6ea); border-radius: 12px; color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-bg-module-platform, rgba(255,255,255,.96)); box-shadow: 0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2328) 18%, transparent); cursor: move; user-select: none; touch-action: none; }
.dsh-tiered-compaction__hud-head { display: flex; align-items: center; gap: 7px; min-width: 0; margin-bottom: 8px; }
.dsh-tiered-compaction__hud-title { min-width: 0; color: var(--dsw-alias-label-secondary, #58636e); font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tiered-compaction__hud-status { min-width: 0; color: var(--dsw-alias-label-tertiary, #7a8591); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tiered-compaction__hud:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #176b61)); outline-offset: 2px; }
.dsh-tiered-compaction__hud button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #176b61)); outline-offset: 1px; }
.dsh-tiered-compaction__hud .dsh-tiered-compaction__legend { margin-top: 3px; }
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
    .dsh-tiered-compaction__bar-fill { transition: none; }
}
`;

/** 宿主已有 renderer 样式时只补一次插件私有样式；测试桩没有 DOM API 时安全跳过。 */
function ensureUiStyles() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (typeof document.querySelector === "function" && document.querySelector(`style[data-plugin-css="${UI_STYLE_ID}"]`)) return;
    const style = document.createElement("style");
    style.dataset.plugin = MODULE_ID;
    style.dataset.pluginCss = UI_STYLE_ID;
    style.textContent = UI_CSS;
    const parent = document.head ?? document.documentElement;
    if (parent && typeof parent.appendChild === "function") parent.appendChild(style);
}

window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory(require) {
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
            };
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
            const pick = (value) =>
                typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
            return {
                l12Processed: pick(raw.l12Processed),
                spillCount: pick(raw.spillCount),
                l3Evicted: pick(raw.l3Evicted),
                l4Summaries: pick(raw.l4Summaries),
                bytesSaved: pick(raw.l12BytesSaved),
            };
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
        };

        /** 页面是否不可见（没有 document 的环境按可见处理）。 */
        function isPageHidden() {
            return typeof document !== "undefined" && document.visibilityState === "hidden";
        }

        /** 写入新快照并通知所有订阅者。 */
        function publishStatus(snapshot) {
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
                const value = layers[key] ?? tOf(t, "missingValue");
                const note =
                    key === "spillCount" && layers.spillCount !== null && layers.spillCount > 0
                        ? bytesSavedTextOf(layers.bytesSaved, t)
                        : null;
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
            );
        }

        /* ------------------------------------------------------------------ *
         * #4 悬浮 HUD 的状态源：localStorage（关闭状态 + 拖动位置）
         * ------------------------------------------------------------------ */

        /** 默认 HUD 状态：未关闭、无存档位置（走角落）。每次返回新对象，避免共享可变值。 */
        function defaultHudState() {
            return { closed: false, left: null, top: null };
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
         * @returns {{closed: boolean, left: number|null, top: number|null}}
         */
        function normalizeHudState(raw) {
            if (raw === null || typeof raw !== "object") return defaultHudState();
            const left = Number.isFinite(raw.left) ? raw.left : null;
            const top = Number.isFinite(raw.top) ? raw.top : null;
            return { closed: raw.closed === true, left, top };
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
                        left: Number.isFinite(state.left) ? Math.round(state.left) : null,
                        top: Number.isFinite(state.top) ? Math.round(state.top) : null,
                    }),
                );
            } catch {
                /* 见 JSDoc：失败即放弃记忆，不往上抛 */
            }
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
            dragSession.apply({ closed: false, left: dragSession.left, top: dragSession.top });
        }

        /** 拖动结束：只在真拖动过时落盘（单纯点一下不改变存档）。 */
        function endDrag() {
            if (dragSession === null) return;
            const finished = dragSession;
            dragSession = null;
            detachDragListeners();
            if (!finished.moved) return;
            finished.commit({ closed: false, left: Math.round(finished.left), top: Math.round(finished.top) });
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
            return h(
                "div",
                { key: "pressure-bar", className: "dsh-tiered-compaction__bar", "data-testid": "pressure-bar" },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__bar-track", style: BAR_STYLE },
                    h("div", { className: "dsh-tiered-compaction__bar-track-fill", style: BAR_TRACK_STYLE }),
                    h("div", { className: "dsh-tiered-compaction__bar-fill", style: fillStyle }),
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
            const t = typeof props.t === "function" ? props.t : null;
            const snapshot = useStatusSnapshot(useCurrentSessionId(props?.useSessions));
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
                              h("strong", null, String(snapshot.window)),
                          ),
                ),
                layersBlock,
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
            const t = typeof props?.t === "function" ? props.t : null;
            const snapshot = useStatusSnapshot(useCurrentSessionId(props?.useSessions));
            const [hudState, setHudState] = React.useState(readHudState);
            const state = normalizeHudState(hudState);
            if (state.closed) return null;

            const toneKey = pressureToneOf(snapshot);
            const tone = PRESSURE_TONES[toneKey];

            /** 关闭：落盘 + 重渲（写入放在前面，重渲出错也不影响「下次不出现」）。 */
            function closeHud() {
                const next = { closed: true, left: state.left, top: state.top };
                persistHudState(next);
                setHudState(next);
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
                    apply: setHudState,
                    commit(next) {
                        persistHudState(next);
                        setHudState(next);
                    },
                };
                attachDragListeners();
                // 阻止拖拽时选中文本 / 触发浏览器原生拖影
                if (typeof event.preventDefault === "function") event.preventDefault();
            }

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
                },
                h(
                    "div",
                    { className: "dsh-tiered-compaction__hud-head" },
                    h("span", {
                        key: "tone-dot",
                        "data-testid": "overlay-status-dot",
                        "data-tone": toneKey,
                        title: tOf(t, tone.key),
                        style: { ...HUD_DOT_STYLE, backgroundColor: tone.color },
                    }),
                    h("span", { className: "dsh-tiered-compaction__hud-title" }, "tiered-compaction"),
                    h("span", { className: "dsh-tiered-compaction__hud-status" }, statusText),
                    h(
                        "button",
                        {
                            key: "close",
                            type: "button",
                            "data-testid": "overlay-close",
                            "aria-label": tOf(t, "hudCloseTitle"),
                            title: tOf(t, "hudCloseTitle"),
                            style: HUD_CLOSE_STYLE,
                            onClick: closeHud,
                            // 按下若冒泡到 HUD 就会开始拖动，这里截断
                            onMouseDown: stopPropagationOf,
                            onPointerDown: stopPropagationOf,
                        },
                        "×",
                    ),
                ),
                ...panelBodyOf(snapshot, { compact: true, valueColor: tone.color, t, showStatus: false }),
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
