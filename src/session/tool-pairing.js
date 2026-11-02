/**
 * 工具调用配对检查（插件自带，beta.6）。
 *
 * 为什么不直接用 `@deepseek-ai/dsh-compaction` 导出的同名函数：
 * 插件本身不声明这个依赖，运行时按 Node 解析规则向上找，会落到 profile 外层
 * `~/.dsh/profiles/node_modules` 里的那一份。用户机器上那一份是 junction 到
 * 全局 CLI 版 dsh（0.1.0-rc.7）的，它按 `session.events[seq]` 读事件；
 * 而桌面宿主（0.2.1-rc.2）的 Session 没有 `events`，只有 `eventAt(seq)`，
 * 于是每次都报 "Cannot read properties of undefined (reading '<seq>')"，
 * 第 4 层压力摘要从未成功。
 *
 * 这里按桌面宿主 0.2.1-rc.2 的实现照抄，只用两代宿主都有的 `eventAt`
 * （没有 `eventAt` 时才退回 `events[seq]`），不再依赖外部解析到哪个版本。
 */

const balanceCacheBySession = new WeakMap();

function eventDelta(event) {
    switch (event.type) {
        case "assistant/message":
            return event.data.message.content.filter((block) => block.type === "tool-call").length;
        case "tool/result":
            return -1;
        default:
            return 0;
    }
}

function eventOf(session, seq) {
    if (typeof session.eventAt === "function") return session.eventAt(seq);
    return session.events?.[seq];
}

function extendCache(session, cache, seqs) {
    const processed = cache.cutBalanced.length - 1;
    const tail = seqs.slice(processed);
    const pendingCuts = [];
    let inProgressToolCalls = cache.inProgressToolCalls;
    for (const seq of tail) {
        const event = eventOf(session, seq);
        if (event === undefined || event.seq !== seq) {
            throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`);
        }
        inProgressToolCalls += eventDelta(event);
        if (inProgressToolCalls < 0) {
            throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`);
        }
        pendingCuts.push(inProgressToolCalls === 0);
    }
    tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset));
    cache.cutBalanced = cache.cutBalanced.concat(pendingCuts);
    cache.inProgressToolCalls = inProgressToolCalls;
    return cache;
}

function balanceCache(session) {
    const surface = session.surface;
    const seqs = surface.nodes;
    const generation = surface.replaceGeneration;
    const cached = balanceCacheBySession.get(session);
    if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
        const rebuilt = extendCache(session, {
            generation,
            cutBalanced: [true],
            indexBySeq: new Map(),
            inProgressToolCalls: 0,
        }, seqs);
        balanceCacheBySession.set(session, rebuilt);
        return rebuilt;
    }
    if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs);
    return cached;
}

function cutBalance(cache, seq, offset) {
    const index = cache.indexBySeq.get(seq);
    const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset];
    if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
    return balanced;
}

/** 某表面节点之前的切口是否配平（没有未回答的工具调用跨过它）。 */
export function toolPairingBalancedBefore(session, seq) {
    return cutBalance(balanceCache(session), seq, 0);
}

/** 某表面节点之后的切口是否配平。 */
export function toolPairingBalancedAfter(session, seq) {
    return cutBalance(balanceCache(session), seq, 1);
}
