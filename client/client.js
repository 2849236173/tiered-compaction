/**
 * client 骨架 + 压力条（方案《方案-UI显示.md》§五 任务 #3，骨架来自任务 #2）。
 *
 * 宿主通过 combo 脚本加载本文件（dsh-client-modules 解析 package.json 的
 * dsh.client 声明 + exports["./client"]），入口是
 * `window.__ModuleLoader__.load({ id, factory })`——与官方模板
 * decoration/client.js 同构，不 import/export（combo 走普通 script 通道）。
 *
 * 数据区共用同一份实现，入口只差外围壳，按 `surface` 分支：
 *   - settings：全尺寸（标题 + 状态 + 条 + 刻度线图例 + 四层数字块），
 *     设置页主入口；
 *   - sidebar（main 槽位）：侧栏面板，标题 + 状态 + 条 + 窗口行 +
 *     四层数字一行式，图例属设置页专有（方案 §3.2 侧栏版没有图例行），
 *     点侧栏图标后展示的就是这一层；
 *   - sidebar.panellist：图标行精简态——图标 + 一行摘要（状态字 + 压力 +
 *     窗口），条/图例/四层统计一概不渲染（任务 #5，验收「点击显示精简状态」）；
 *   - overlay：迷你 HUD（条与三线保留＋#4 的拖动/关闭/随压力变色），
 *     不加四层数字（任务 #6 定案：保持迷你）。
 */

/** 模块 id 必须等于包名（dshmarket 同款约定）。 */
const MODULE_ID = "dsh-tiered-compaction";

/**
 * 状态路由路径。为什么复制而不 import src/status-route.js：client 半是
 * 浏览器脚本，与 host 半不共享模块系统；两处必须保持同字符串，改动时成对改。
 */
const STATUS_PATH = "/api/tiered-compaction/status";

/** 设置页分区槽位（宿主 settings 外壳声明）。 */
const SETTINGS_SECTION_SLOT = "settings.section";
const SETTINGS_SECTION_ID = "tiered-compaction";
const SETTINGS_SECTION_ORDER = 45;

/** 侧栏双注册：main（keyed，主面板）+ sidebar.panellist（list，图标行）。 */
const MAIN_SLOT = "main";
const SIDEBAR_PANELLIST_SLOT = "sidebar.panellist";
/** main 的 key 与 panellist 的 id 必须同字符串（DesktopLayoutState 按 key 匹配面板）。 */
const PANEL_KEY = "tiered-compaction";
const SIDEBAR_PANELLIST_ORDER = 1;

/** 悬浮 overlay 槽位（宿主 root children 声明，kind=list，必须自带 id）。 */
const OVERLAY_SLOT = "shell.overlay";
const OVERLAY_ID = "tiered-compaction-hud";
const OVERLAY_LABEL = "tiered-compaction";
/** overlay 悬浮层级：高于宿主常规内容即可。 */
const OVERLAY_Z_INDEX = 1000;
const OVERLAY_CORNER_OFFSET = "16px";

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

/** 档位 → 颜色 + 中文短名。tone 名进 data-tone、颜色进 style，两者同源于此表。 */
const PRESSURE_TONES = {
    [PRESSURE_TONE_CALM]: { color: "#2f9e44", label: "正常" },
    [PRESSURE_TONE_REMIND]: { color: "#f0a020", label: "偏高" },
    [PRESSURE_TONE_EVICT]: { color: "#e8590c", label: "危险" },
    [PRESSURE_TONE_UNKNOWN]: { color: "#868e96", label: "未知" },
};

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
 * （percent 字符串）。数组顺序即 DOM 顺序，与阈值升序一致。
 */
const PRESSURE_MARKS = [
    { value: PRESSURE_REMIND_RATIO, percent: "70%", label: "70% 提醒线" },
    { value: PRESSURE_EVICT_RATIO, percent: "80%", label: "80% 驱逐线" },
    { value: PRESSURE_LOSSY_FLOOR_RATIO, percent: "82%", label: "82% 摘要线" },
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
    backgroundColor: "#8884",
};
const BAR_FILL_STYLE = {
    position: "absolute",
    left: "0",
    top: "0",
    height: BAR_FILL_HEIGHT,
    backgroundColor: "#4a9eda",
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
    backgroundColor: "#555",
};

const BAR_LEGEND_ROW_STYLE = {
    marginTop: "4px",
    fontSize: "11px",
    opacity: "0.75",
    whiteSpace: "nowrap",
};

/**
 * surface 取值：组件按它分支渲染（方案 §2.3「一个组件三入口」）。
 * PANELLIST 是 #5 新增的第四种渲染面：它不占三入口中的任何一个，只在
 * sidebar.panellist（图标行）里用——图标行空间只够一行字，所以单独成型，
 * 不能复 main 的侧栏面板（那会把标题与压力条挤进图标行）。
 */
const SURFACE_SETTINGS = "settings";
const SURFACE_SIDEBAR = "sidebar";
const SURFACE_PANELLIST = "sidebar-panellist";
const SURFACE_OVERLAY = "overlay";

const PANEL_TITLE = "tiered-compaction 分层压缩";

/** 侧栏图标（方案 §3.2 手绘图里的 🐋）：图标行没有标题位，靠它也认得出来。 */
const PANEL_ICON = "🐋";

/** 精简态的几个可点定位点：图标行、图标、状态点、摘要行（验收按图标 testid 断言）。 */
const SIDEBAR_PANEL_TESTID = "sidebar-panel";
const PANELLIST_TESTID = "sidebar-panellist";
const PANELLIST_ICON_TESTID = "sidebar-panellist-icon";
const PANELLIST_DOT_TESTID = "sidebar-panellist-dot";
const PANELLIST_SUMMARY_TESTID = "sidebar-panellist-summary";

/**
 * 状态字的中文短名表：只翻译「压缩进行中」这一类，其余状态原样透出。
 * 为什么单独一张表：状态字是 API 字段的展示，不是第二套状态机——宿主半
 * 当前只产出 ok/warn，`compacting` 是任务 #5 要求覆盖的「压缩中」态，日后
 * 事件源接入时这里不用再改渲染；表里没有的词（含 ok/warn）一律按原字面显示，
 * 既有断言（d23「/ok/」等）因此不受影响。
 */
const STATUS_LABELS = Object.freeze({ compacting: "压缩中" });

const PHASE_LOADING = "loading";
const PHASE_READY = "ready";
const PHASE_UNAVAILABLE = "unavailable";
const LOADING_TEXT = "读取中…";
const UNAVAILABLE_TEXT = "数据不可用";

/**
 * 四层数字块的中文标签（任务 #6，方案 §3.1 顺序）。
 * 折叠用 l12Processed 口径（第 1-2 层处理数）；落盘附省字节数；
 * 摘要来自 host 半的 l4Summaries（提交过的摘要事务数）。
 */
const LAYERS_LABELS = Object.freeze({
    l12Processed: "无损折叠",
    spillCount: "落盘存档",
    l3Evicted: "软压力驱逐",
    l4Summaries: "有损摘要",
});

/** 四层数字块的 testid（d28 按它定位断言；panellist 摘要行沿用既有 testid）。 */
const LAYERS_BLOCK_TESTID = "layer-stats";

/**
 * 侧栏精简态样式（方案 §3.2：图标 + 一行「● 正常 27.0%」）。
 * 只做行内排版，不预设任何定位——图标行的位置由宿主侧栏布局决定，
 * 与 d23「非 overlay 不预设定位」的约定一致。
 */
const PANELLIST_ROW_STYLE = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    whiteSpace: "nowrap",
};
const PANELLIST_ICON_STYLE = { flex: "0 0 auto", fontSize: "14px", lineHeight: "1" };
const PANELLIST_DOT_STYLE = { flex: "0 0 auto", width: "6px", height: "6px", borderRadius: "50%" };
const PANELLIST_SUMMARY_STYLE = { fontSize: "12px", opacity: "0.85" };

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
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    minWidth: "190px",
    borderRadius: "8px",
    backgroundColor: "rgba(24, 24, 27, 0.88)",
    color: "#f4f4f5",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
    cursor: "move",
    userSelect: "none",
    touchAction: "none",
};

/** 状态点：颜色表示压力档位（绿/黄/橙/灰），形状固定。 */
const HUD_DOT_STYLE = {
    flex: "0 0 auto",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
};

/** HUD 里的状态文本比全尺寸入口更小，避免占宽。 */
const HUD_STATUS_STYLE = { fontSize: "11px", opacity: "0.8", whiteSpace: "nowrap" };

/** 关闭按钮：贴右，无边框，保持 HUD 的紧凑观感。 */
const HUD_CLOSE_STYLE = {
    flex: "0 0 auto",
    marginLeft: "auto",
    padding: "0 2px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: "1",
};

window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory(require) {
        const React = require("react");
        const h = React.createElement;

        /**
         * 取一次状态快照（7+3 字段里本阶段只消费 status/pressure）。
         * 为什么用 new URL(...).pathname 而非整 URL：宿主页面可能挂在带
         * query/hash 的地址上，只取同源路径部分，避免把这些带进请求。
         * @returns {Promise<object>} 路由 JSON
         */
        function fetchStatusSnapshot() {
            const url = new URL(STATUS_PATH, document.baseURI).pathname;
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
         * @returns {string|null}
         */
        function bytesSavedTextOf(raw) {
            if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
            const KB = 1024;
            const MB = KB * 1024;
            if (raw >= MB) return `省 ~${(raw / MB).toFixed(1)} MB`;
            if (raw >= KB) return `省 ~${Math.round(raw / KB)} KB`;
            return `省 ~${raw} 字节`;
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

        /**
         * 挂载即取数一次（轮询/按需刷新属 #3~#6）。
         * 失败分支必须显式落到 UNAVAILABLE，不允许空 catch。
         */
        function useStatusSnapshot() {
            const [snapshot, setSnapshot] = React.useState(LOADING_SNAPSHOT);
            React.useEffect(() => {
                let isActive = true;
                fetchStatusSnapshot().then(
                    (payload) => {
                        if (isActive) setSnapshot(buildReadySnapshot(payload));
                    },
                    () => {
                        if (isActive) setSnapshot(UNAVAILABLE_SNAPSHOT);
                    },
                );
                return () => {
                    isActive = false;
                };
            }, []);
            return snapshot;
        }

        /** 快照 → 状态文本（三入口共用）。压力数值不在这里：它是条旁数值文本的职责。 */
        function statusLineOf(snapshot) {
            if (snapshot.phase === PHASE_UNAVAILABLE) return UNAVAILABLE_TEXT;
            if (snapshot.phase === PHASE_LOADING) return LOADING_TEXT;
            return `状态 ${snapshot.status}`;
        }

        /* ------------------------------------------------------------------ *
         * #5 侧栏面板：精简态文案（两个侧栏入口共用，取数/换算与设置页同源）
         * ------------------------------------------------------------------ */

        /**
         * 状态字：已知状态给中文短名，其余原样透出（见 STATUS_LABELS 的取舍）。
         * ok/warn 不在表里，因此仍显示 API 原字面——既有断言与「数值可追溯到
         * API」的性质都不变。
         * 为什么用 hasOwnProperty 而不是直接下标：status 是外部数据，`toString`
         * 这类原型键会让下标命中原型上的函数，渲染出 `function toString()…`。
         * @param {string} status API 的 status 字段
         * @returns {string}
         */
        function statusWordOf(status) {
            if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) return status;
            return STATUS_LABELS[status];
        }

        /**
         * 侧栏用的状态文本：非 ready 相位直接复用 statusLineOf（占位文案只说
         * 一次），ready 相位才套状态字表。为什么不改 statusLineOf：settings 与
         * overlay 的文案是 #2/#4 的既定行为，侧栏不该顺手改掉它们。
         * @param {{phase: string, status: string|null}} snapshot 渲染快照
         * @returns {string}
         */
        function sidebarStatusTextOf(snapshot) {
            if (snapshot.phase !== PHASE_READY) return statusLineOf(snapshot);
            return `状态 ${statusWordOf(snapshot.status)}`;
        }

        /**
         * 窗口大小文案：只有 ready 且有可信窗口值时才出——
         * loading/unavailable 说「读取中…」「数据不可用」，不编一个窗口数。
         * @param {{phase: string, window: number|null}} snapshot 渲染快照
         * @returns {string|null}
         */
        function windowTextOf(snapshot) {
            if (snapshot.phase !== PHASE_READY) return null;
            if (snapshot.window === null) return null;
            return `窗口 ${snapshot.window}`;
        }

        /**
         * 图标行摘要（一行）：状态字 + 压力百分比 + 窗口，三项全部取自同一
         * 快照字段，不在这里二次换算（pressure 已在 buildReadySnapshot 定型）。
         * 非 ready 相位只留占位文案，杜绝「读取中 0.0%」这种假读数。
         * @param {{phase: string, pressure: string|null}} snapshot 渲染快照
         * @returns {string} 单行摘要
         */
        function panellistSummaryOf(snapshot) {
            const parts = [sidebarStatusTextOf(snapshot)];
            if (snapshot.phase !== PHASE_READY) return parts.join(" · ");
            parts.push(snapshot.pressure ?? "");
            const windowText = windowTextOf(snapshot);
            if (windowText !== null) parts.push(windowText);
            return parts.join(" · ");
        }

        /* ------------------------------------------------------------------ *
         * #6 四层活动统计：设置页数字块 + 侧栏一行式（数据源同一份快照）
         * ------------------------------------------------------------------ */

        /**
         * 「自 HH:mm 起」标注：只有 ready 且 since 可读时才出。
         * sinceTextOf 已把非法值收窄成 null，这里 null 就整段省略，
         * 绝不渲染 "自 NaN:NaN 起"。
         * @param {{phase: string, sinceText: string|null}} snapshot 渲染快照
         * @returns {string|null}
         */
        function sinceMarkOf(snapshot) {
            if (snapshot.phase !== PHASE_READY) return null;
            if (snapshot.sinceText === null) return null;
            return `自 ${snapshot.sinceText} 起`;
        }

        /**
         * 设置页四层数字块：方案 §3.1 顺序（折叠/落盘/驱逐/摘要），
         * 落盘附省字节数。数字 0 也如实显示——那是「真的在跑」的证据。
         * 某项缺失（null）显示「—」：与 0 有区别（0 是读到的，— 是没拿到），
         * 不用假零冒充读数。
         * @param {{phase: string, layers: object|null}} snapshot 渲染快照
         * @returns {object|null} 区块 vnode；无数据（非 ready 或 layers 缺失）时不渲染
         */
        function layersBlockOf(snapshot) {
            if (snapshot.phase !== PHASE_READY || snapshot.layers === null) return null;
            const layers = snapshot.layers;

            const rowOf = (key) =>
                h(
                    "div",
                    { key: `layer-${key}` },
                    `${LAYERS_LABELS[key]}　${layers[key] ?? "—"}${key === "spillCount" && layers.spillCount !== null && layers.spillCount > 0 ? `（${bytesSavedTextOf(layers.bytesSaved)}）` : ""}`,
                );

            const sinceMark = sinceMarkOf(snapshot);
            return h(
                "div",
                { key: "layer-stats", "data-testid": LAYERS_BLOCK_TESTID },
                h("div", { key: "layer-stats-title" }, sinceMark === null ? "本次会话：" : `本次会话（${sinceMark}）：`),
                rowOf("l12Processed"),
                rowOf("spillCount"),
                rowOf("l3Evicted"),
                rowOf("l4Summaries"),
            );
        }

        /**
         * 侧栏一行式四层数字（任务 #6，方案 §3.2「折叠 N · 落盘 N · 驱逐 N · 摘要 N」）。
         * 同样带 since 标注；缺数据时整行不出现（同 window 行的取舍）。
         * @param {{phase: string, layers: object|null}} snapshot 渲染快照
         * @returns {string|null}
         */
        function layersLineOf(snapshot) {
            if (snapshot.phase !== PHASE_READY || snapshot.layers === null) return null;
            const l = snapshot.layers;
            const parts = [
                `折叠 ${l.l12Processed ?? "—"}`,
                `落盘 ${l.spillCount ?? "—"}`,
                `驱逐 ${l.l3Evicted ?? "—"}`,
                `摘要 ${l.l4Summaries ?? "—"}`,
            ];
            const sinceMark = sinceMarkOf(snapshot);
            if (sinceMark !== null) parts.push(sinceMark);
            return parts.join(" · ");
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
                return { left: state.left, top: state.top };
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
                return {
                    ...HUD_BASE_STYLE,
                    left: pixelOf(state.left),
                    top: pixelOf(state.top),
                    right: "auto",
                    bottom: "auto",
                };
            }
            return { ...HUD_BASE_STYLE, right: OVERLAY_CORNER_OFFSET, bottom: OVERLAY_CORNER_OFFSET };
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
            dragSession.left = dragSession.originLeft + (point.x - dragSession.startX);
            dragSession.top = dragSession.originTop + (point.y - dragSession.startY);
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
        function pressureValueTextOf(snapshot) {
            if (snapshot.phase === PHASE_READY) return snapshot.pressure ?? "";
            if (snapshot.phase === PHASE_UNAVAILABLE) return UNAVAILABLE_TEXT;
            return LOADING_TEXT;
        }

        /**
         * 一条刻度线（竖线）：left 取自系内阈值（PRESSURE_MARKS），防止渲染
         * 分支里出现第二个 70/80/82 数字源；title 提供悬停可读的语义标签。
         * @param {{value: number, label: string}} mark PRESSURE_MARKS 的条目
         * @returns {object} 刻度线 vnode
         */
        function renderPressureMark(mark) {
            return h("div", {
                key: mark.label,
                title: mark.label,
                style: { ...BAR_MARK_BASE_STYLE, left: `${percentNumberOf(mark.value)}%` },
            });
        }

        /**
         * 刻度线图例行：三个阈值的全称横排（「70% 提醒线 80% 驱逐线 …」），
         * 仅全尺寸入口渲染；overlay 空间小，靠条上的凸齿与 title 表达。
         * @returns {object[]} 图例文本 vnodes
         */
        function renderMarkLegend() {
            return PRESSURE_MARKS.map((mark) => `${mark.percent} ${mark.label}`).join("　·　");
        }

        /**
         * 压力条区块（任务 #3 注入点）：条 + 三刻度线 + 数值文本（三入口共用），
         * 通过 options 控制紧凑程度——overlay 设 compact 隐藏图例并把数值并入
         * 条下行的尾部（方案 §3.3 可视空间小，但条与三线必须保留）。
         * overlay 再传 valueColor 让数值文字跟着压力档位变色（#4 颜色随压力），
         * 数值本身仍来自 API，颜色只是同一份数据的视觉表达。
         * 非数据相位不渲染假数字：宽度为 0（无空条误导），数值文本走占位文案。
         * @param {{phase: string, pressureWidth: string|null}} snapshot 渲染快照
         * @param {{compact: boolean, valueColor?: string}} options 紧凑开关 + 数值色
         * @returns {object} 区块 vnode
         */
        function pressureBarBlockOf(snapshot, options) {
            const valueText = pressureValueTextOf(snapshot);
            const fillStyle =
                snapshot.phase === PHASE_READY && snapshot.pressureWidth !== null
                    ? { ...BAR_FILL_STYLE, width: snapshot.pressureWidth }
                    : { ...BAR_FILL_STYLE, width: "0%" };

            const markNodes = PRESSURE_MARKS.map(renderPressureMark);
            const valueNode = h(
                "span",
                {
                    key: "pressure-value",
                    style: { marginLeft: options.compact ? "auto" : undefined, color: options.valueColor },
                },
                valueText,
            );

            return h(
                "div",
                { key: "pressure-bar", "data-testid": "pressure-bar" },
                h(
                    "div",
                    { style: BAR_STYLE },
                    h("div", { style: BAR_TRACK_STYLE }),
                    h("div", { style: fillStyle }),
                    markNodes,
                ),
                h(
                    "div",
                    { style: BAR_LEGEND_ROW_STYLE },
                    ...(options.compact ? [] : [h("span", { key: "marks-legend" }, renderMarkLegend())]),
                    valueNode,
                ),
            );
        }

        /**
         * 状态文本 + 压力条（三入口共用）：入口之间只差外围（标题/图例/HUD 壳），
         * 数据区永远同一份实现，避免三个入口各写一遍渲染分支。
         * options.statusText 供侧栏换成自己的状态字（状态字表只影响文案，
         * 数值仍来自同一快照）；不传就沿用三入口共用的 statusLineOf。
         * @param {{phase: string}} snapshot 渲染快照
         * @param {{compact: boolean, valueColor?: string, statusText?: string}} options 紧凑开关 + 数值色 + 状态文案
         * @returns {object[]} 状态行与压力条 vnodes
         */
        function panelBodyOf(snapshot, options) {
            const isCompact = options.compact === true;
            return [
                h(
                    "div",
                    { key: "status-line", style: isCompact ? HUD_STATUS_STYLE : undefined },
                    options.statusText ?? statusLineOf(snapshot),
                ),
                pressureBarBlockOf(snapshot, options),
            ];
        }

        /**
         * 全尺寸面板（settings）：标题 + 状态文本 + 带图例的压力条 + 四层数字块。
         * 注意：不透传 ownerProps——合成链末尾 ownerProps 会覆盖同名键
         * （close/size 等宿主常用名），干脆不接任何宿主 prop。
         * 非 ready 相位不出假数字（数值文本各自降级）。
         */
        function StatusPanel(props) {
            const snapshot = useStatusSnapshot();
            const layersBlock = layersBlockOf(snapshot);
            return h(
                "div",
                { "data-surface": props.surface },
                h("div", { key: "panel-title" }, PANEL_TITLE),
                ...panelBodyOf(snapshot, { compact: false }),
                // 无四层数据时整块不出现：宁可少一块，也不给假读数
                ...(layersBlock === null ? [] : [layersBlock]),
            );
        }

        /**
         * 侧栏面板（main 槽位，任务 #5）：「点侧栏图标后看到的那一屏」。
         * 与设置页的差别只有两处，都是为了「精简」（方案 §3.2）：
         *   1. 压力条走 compact——刻度线保留（70/80/82 仍要看得见），刻度线
         *      图例那行字是设置页专有，侧栏不重复；
         *   2. 多一行「窗口 xxx」——侧栏用户最关心的是「窗口还够不够」，
         *      数值直接来自 status API 的 window，不在这里换算。
         * 状态文案用侧栏自己的状态字表（ok 仍是 ok，只是支持「压缩中」这类词）。
         */
        function SidebarPanel() {
            const snapshot = useStatusSnapshot();
            const windowText = windowTextOf(snapshot);
            // 任务 #6：四层数字一行式（折叠 N · 落盘 N · 驱逐 N · 摘要 N + since 标注）
            const layersLine = layersLineOf(snapshot);
            return h(
                "div",
                { "data-surface": SURFACE_SIDEBAR, "data-testid": SIDEBAR_PANEL_TESTID },
                h("div", { key: "panel-title" }, PANEL_TITLE),
                ...panelBodyOf(snapshot, {
                    compact: true,
                    statusText: sidebarStatusTextOf(snapshot),
                }),
                // 无窗口数据时整行不出现：宁可少一行，也不给一个假窗口数
                ...(windowText === null
                    ? []
                    : [h("div", { key: "sidebar-window", style: PANELLIST_SUMMARY_STYLE }, windowText)]),
                // 四层数字行同样：缺数据整行不出现，不出假零
                ...(layersLine === null
                    ? []
                    : [h("div", { key: "sidebar-layers", style: PANELLIST_SUMMARY_STYLE }, layersLine)]),
            );
        }

        /**
         * 侧栏图标行精简态（sidebar.panellist，任务 #5 验收「图标可见，点击显示
         * 精简状态」）。
         * 为什么必须与 SidebarPanel 分开：图标行只有一行的宽高，标题/压力条/四层
         * 统计塞进去会把侧栏撑坏；这里只要「图标 + 一行摘要（状态 · 压力 · 窗口）」。
         * 点它之后宿主按 id=key 把 main 槽位换成 SidebarPanel——两屏都精简，
         * 详细内容留给设置页。
         * 数据源完全相同：useStatusSnapshot + 同一份 buildReadySnapshot 换算。
         */
        function SidebarPanellist() {
            const snapshot = useStatusSnapshot();
            const toneKey = pressureToneOf(snapshot);
            const tone = PRESSURE_TONES[toneKey];
            return h(
                "div",
                {
                    "data-surface": SURFACE_PANELLIST,
                    "data-testid": PANELLIST_TESTID,
                    "data-tone": toneKey,
                    title: PANEL_TITLE,
                    style: PANELLIST_ROW_STYLE,
                },
                h(
                    "span",
                    {
                        key: "icon",
                        "data-testid": PANELLIST_ICON_TESTID,
                        "aria-hidden": "true",
                        style: PANELLIST_ICON_STYLE,
                    },
                    PANEL_ICON,
                ),
                h("span", {
                    key: "tone-dot",
                    "data-testid": PANELLIST_DOT_TESTID,
                    "data-tone": toneKey,
                    title: `压力${tone.label}`,
                    style: { ...PANELLIST_DOT_STYLE, backgroundColor: tone.color },
                }),
                h(
                    "span",
                    {
                        key: "summary",
                        "data-testid": PANELLIST_SUMMARY_TESTID,
                        style: PANELLIST_SUMMARY_STYLE,
                    },
                    panellistSummaryOf(snapshot),
                ),
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
        function OverlayHud() {
            const snapshot = useStatusSnapshot();
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

            return h(
                "div",
                {
                    "data-surface": SURFACE_OVERLAY,
                    "data-testid": "overlay-hud",
                    "data-tone": toneKey,
                    style: hudPositionStyleOf(state),
                    [dragChannel().down]: beginDrag,
                },
                h("span", {
                    key: "tone-dot",
                    "data-testid": "overlay-status-dot",
                    "data-tone": toneKey,
                    title: `压力${tone.label}`,
                    style: { ...HUD_DOT_STYLE, backgroundColor: tone.color },
                }),
                ...panelBodyOf(snapshot, { compact: true, valueColor: tone.color }),
                h(
                    "button",
                    {
                        key: "close",
                        type: "button",
                        "data-testid": "overlay-close",
                        title: "关闭悬浮窗",
                        style: HUD_CLOSE_STYLE,
                        onClick: closeHud,
                        // 按下若冒泡到 HUD 就会开始拖动，这里截断
                        onMouseDown: stopPropagationOf,
                        onPointerDown: stopPropagationOf,
                    },
                    "×",
                ),
            );
        }

        /**
         * 生成绑定到某个 surface 的组件（包装层不透传 ownerProps，见 StatusPanel 注释）。
         * 两个入口各自有自己的壳，不能合并：
         *   - overlay 走 HUD 壳（#4 的关闭/拖动状态，塞进面板会把两套状态搅在一起）；
         *   - sidebar 走 SidebarPanel（精简版：无图例、多窗口行，#5）；
         *   - settings 才用 StatusPanel（全量视图）。
         * 数据源始终是同一个 useStatusSnapshot。
         */
        function makeSurfaceComponent(surface) {
            if (surface === SURFACE_OVERLAY) {
                return function SurfacePanel() {
                    return h(OverlayHud);
                };
            }
            if (surface === SURFACE_SIDEBAR) {
                return function SidebarPanelEntry() {
                    return h(SidebarPanel);
                };
            }
            return function SurfacePanel() {
                return h(StatusPanel, { surface });
            };
        }

        /**
         * 侧栏图标行（sidebar.panellist）的精简态组件。
         * 为什么单独一个工厂而不是 makeSurfaceComponent(SURFACE_SIDEBAR)：注册处
         * 一眼就能看出「图标行≠主面板」——两者是不同组件，#5 的核心改动就是
         * 这条注册不再指向主面板。
         */
        function makePanellistComponent() {
            return function SidebarPanellistEntry() {
                return h(SidebarPanellist);
            };
        }

        /** 注册设置页分区。order=45：跟在宿主与市场分区之后（方案 §2.2 实测口径）。label 用 thunk（dshmarket 同款）。 */
        function injectSettingsSection(ctx) {
            // 惯例外包装：slot 声明晚到/抖动时由宿主 reconcile 自动重装
            ctx.slots.inject(SETTINGS_SECTION_SLOT, () =>
                ctx.slots.register(
                    {
                        name: SETTINGS_SECTION_SLOT,
                        id: SETTINGS_SECTION_ID,
                        order: SETTINGS_SECTION_ORDER,
                        label: () => PANEL_TITLE,
                    },
                    makeSurfaceComponent(SURFACE_SETTINGS),
                ),
            );
        }

        /**
         * 侧栏双注册：main 面板（keyed，点图标后展开的那一屏）+ panellist 图标行
         * （list，图标 + 一行摘要）。label 用 thunk（dshmarket 同款）。
         * 两处 id/key 必须同字符串：DesktopLayoutState 按 key 匹配面板，否则点了
         * 图标主区找不到面板（方案 §2.2）。组件则必须是两个——图标行只有一行宽高。
         */
        function injectSidebarPanel(ctx) {
            ctx.slots.inject(MAIN_SLOT, () =>
                ctx.slots.register({ name: MAIN_SLOT, key: PANEL_KEY }, makeSurfaceComponent(SURFACE_SIDEBAR)),
            );
            ctx.slots.inject(SIDEBAR_PANELLIST_SLOT, () =>
                ctx.slots.register(
                    {
                        name: SIDEBAR_PANELLIST_SLOT,
                        id: PANEL_KEY,
                        order: SIDEBAR_PANELLIST_ORDER,
                        label: () => PANEL_TITLE,
                    },
                    makePanellistComponent(),
                ),
            );
        }

        /** overlay 槽位是 list：条目必须自带 id/label（宿主不注入，dshmarket 同款）。 */
        function injectShellOverlay(ctx) {
            ctx.slots.inject(OVERLAY_SLOT, () =>
                ctx.slots.register(
                    { name: OVERLAY_SLOT, id: OVERLAY_ID, label: () => OVERLAY_LABEL },
                    makeSurfaceComponent(SURFACE_OVERLAY),
                ),
            );
        }

        return {
            name: MODULE_ID,
            inject: ["slots"],
            apply(ctx) {
                injectSettingsSection(ctx);
                injectSidebarPanel(ctx);
                injectShellOverlay(ctx);
            },
        };
    },
});
