/**
 * 用例间复位进程级状态：单写者座位表、共享统计表、状态路由席位。
 * 单测直接对 `new Context()` 调 apply，root fiber 永不卸载，ctx.effect
 * 托管的席位不会自动归还，所以每个用例结束后在这里清零。
 */
import { afterEach } from "node:test";
import { __resetSingleWriterForTests } from "../src/single-writer-guard.js";
import { __resetSharedStatsForTests } from "../src/shared-stats.js";
import { __resetStatusRouteForTests } from "../src/status-route.js";

export function resetProcessState() {
    __resetSingleWriterForTests();
    __resetSharedStatsForTests();
    __resetStatusRouteForTests();
}

afterEach(() => resetProcessState());
