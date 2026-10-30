/**
 * client 骨架 + 压力条（方案《方案-UI显示.md》§五 任务 #3，骨架来自任务 #2）。
 *
 * 宿主通过 combo 脚本加载本文件（dsh-client-modules 解析 package.json 的
 * dsh.client 声明 + exports["./client"]），入口是
 * `window.__ModuleLoader__.load({ id, factory })`——与官方模板
 * decoration/client.js 同构，不 import/export（combo 走普通 script 通道）。
 *
 * 三入口共用一个组件，按 `surface` prop 分支：settings/sidebar 全尺寸
 * （含标题与刻度线图例），overlay 紧凑（隐藏标题/图例，条与三线保留，
 * 方案 §3.3）。状态文本/统计/拖动等其余 UI 属 #4~#6。
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
/** overlay 悬浮层级：高于宿主常规内容即可，具体定位/拖动是 #4 的职责。 */
const OVERLAY_Z_INDEX = 1000;
const OVERLAY_CORNER_OFFSET = "16px";

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

/** surface 取值：组件按它分支渲染（方案 §2.3「一个组件三入口」）。 */
const SURFACE_SETTINGS = "settings";
const SURFACE_SIDEBAR = "sidebar";
const SURFACE_OVERLAY = "overlay";

const PANEL_TITLE = "tiered-compaction 分层压缩";
const PHASE_LOADING = "loading";
const PHASE_READY = "ready";
const PHASE_UNAVAILABLE = "unavailable";
const LOADING_TEXT = "读取中…";
const UNAVAILABLE_TEXT = "数据不可用";

/**
 * 初始快照：挂载后 fetch 完成前的诚实占位（不是「数据不可用」）。
 * freeze 的原因：两者是模块级共享对象，#4~#6 扩展时若误改字段会污染所有
 * 入口的初值；相位切换本就该造新对象，锁死是零成本的护栏（任务 #3 顺检）。
 */
const LOADING_SNAPSHOT = Object.freeze({ phase: PHASE_LOADING, status: null, pressure: null, pressureWidth: null });
const UNAVAILABLE_SNAPSHOT = Object.freeze({ phase: PHASE_UNAVAILABLE, status: null, pressure: null, pressureWidth: null });

/** overlay 固定角落占位样式（定位/拖动是组件自己的职责，#4 再做）。 */
const OVERLAY_STYLE = {
    position: "fixed",
    right: OVERLAY_CORNER_OFFSET,
    bottom: OVERLAY_CORNER_OFFSET,
    zIndex: OVERLAY_Z_INDEX,
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
         * @param {unknown} payload 路由 JSON
         * @returns {{phase: string, status: string|null, pressure: string|null, pressureWidth: string|null}}
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
            };
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

        /** overlay 才有定位；settings/sidebar 占位期不预设样式。 */
        function styleForSurface(surface) {
            if (surface === SURFACE_OVERLAY) return OVERLAY_STYLE;
            return undefined;
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
         * 非数据相位不渲染假数字：宽度为 0（无空条误导），数值文本走占位文案。
         * @param {{phase: string, pressureWidth: string|null}} snapshot 渲染快照
         * @param {{compact: boolean}} options 紧凑开关
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
                { key: "pressure-value", style: { marginLeft: options.compact ? "auto" : undefined } },
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
         * 三入口共用组件：接收 surface prop 分支渲染。
         * 注意：不透传 ownerProps——合成链末尾 ownerProps 会覆盖同名键
         * （close/size 等宿主常用名），干脆不接任何宿主 prop。
         * overlay 走紧凑分支（隐藏标题/图例，条+三线保留，方案 §3.3），
         * settings/sidebar 全尺寸；非 ready 相位不出假数字（数值文本各自降级）。
         */
        function StatusPanel(props) {
            const snapshot = useStatusSnapshot();
            const isCompact = props.surface === SURFACE_OVERLAY;
            return h(
                "div",
                {
                    "data-surface": props.surface,
                    style: styleForSurface(props.surface),
                },
                ...(isCompact ? [] : [h("div", { key: "panel-title" }, PANEL_TITLE)]),
                h("div", { key: "status-line" }, statusLineOf(snapshot)),
                pressureBarBlockOf(snapshot, { compact: isCompact }),
            );
        }

        /** 生成绑定到某个 surface 的组件（包装层不透传 ownerProps，见 StatusPanel 注释）。 */
        function makeSurfaceComponent(surface) {
            return function SurfacePanel() {
                return h(StatusPanel, { surface });
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

        /** 侧栏双注册：main 面板（keyed）+ panellist 图标行（list）。label 用 thunk（dshmarket 同款）。 */
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
                    makeSurfaceComponent(SURFACE_SIDEBAR),
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
