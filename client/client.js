/**
 * client 半骨架（方案《方案-UI显示.md》§五 任务 #2）。
 *
 * 宿主通过 combo 脚本加载本文件（dsh-client-modules 解析 package.json 的
 * dsh.client 声明 + exports["./client"]），入口是
 * `window.__ModuleLoader__.load({ id, factory })`——与官方模板
 * decoration/client.js 同构，不 import/export（combo 走普通 script 通道）。
 *
 * 本任务只做骨架 + surface 区分：三入口各注册一个占位组件，组件按
 * `surface` prop 分支渲染最小内容（标题 + status/pressure 文本）；
 * 压力条/统计/拖动等具体 UI 属 #3~#6。
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

/** 初始快照：挂载后 fetch 完成前的诚实占位（不是「数据不可用」）。 */
const LOADING_SNAPSHOT = { phase: PHASE_LOADING, status: null, pressure: null };
const UNAVAILABLE_SNAPSHOT = { phase: PHASE_UNAVAILABLE, status: null, pressure: null };

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
         * 更容易骗过用户（骨架期字段少，#3~#6 扩字段时继续沿用这条规则）。
         * @param {unknown} payload 路由 JSON
         * @returns {{phase: string, status: string|null, pressure: string|null}}
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
            };
        }

        /** pressure 是 0~1 小数（host 半 toFixed(4) 口径），显示层换算成百分比。 */
        function formatPressure(pressure) {
            return `${(pressure * 100).toFixed(1)}%`;
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

        /** 快照 → 一行状态文本（三入口共用，surface 只影响容器与布局）。 */
        function statusLineOf(snapshot) {
            if (snapshot.phase === PHASE_UNAVAILABLE) return UNAVAILABLE_TEXT;
            if (snapshot.phase === PHASE_LOADING) return LOADING_TEXT;
            return `状态 ${snapshot.status} · 压力 ${snapshot.pressure}`;
        }

        /** overlay 才有定位；settings/sidebar 占位期不预设样式。 */
        function styleForSurface(surface) {
            if (surface === SURFACE_OVERLAY) return OVERLAY_STYLE;
            return undefined;
        }

        /**
         * 三入口共用组件：接收 surface prop 分支渲染。
         * 注意：不透传 ownerProps——合成链末尾 ownerProps 会覆盖同名键
         * （close/size 等宿主常用名），骨架阶段干脆不接任何宿主 prop。
         */
        function StatusPanel(props) {
            const snapshot = useStatusSnapshot();
            return h(
                "div",
                {
                    "data-surface": props.surface,
                    style: styleForSurface(props.surface),
                },
                h("div", null, PANEL_TITLE),
                h("div", null, statusLineOf(snapshot)),
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
