/**
 * Replaces pi's transcript once per turn with an accepted commit: newest Σ, newest user
 * turn, and trailing tool cycles. statewindow.ts supplies the cache, extraction, and config.
 *
 * Boundaries survive reload and branch navigation and are included in pi's context
 * accounting. The session file continues to grow.
 *
 * No system message is emitted: pi rebuilds it, including --append-system-prompt policy.
 * Retained messages preserve object identity and tool pairing. pi applies replacements
 * only between complete cycles. An invalid trailing window falls back to Σ alone and
 * records the reason; an unsendable replacement prevents further turns.
 */
import { pairCycles } from "./pairing.js";
import { DEFAULT_TOOL_CYCLES, observeStateCommitResult, resolveStateWindow, sigmaFromResult, stateCommitCache, stateWindowPreamble, stateWindowSetting, } from "./statewindow.js";
export { DEFAULT_TOOL_CYCLES, resolveStateWindow, stateWindowSetting, };
/** Entry types that end context construction (pi's `isContextBoundaryEntry`). */
const BOUNDARY_ENTRY_TYPES = new Set(["transcript", "compaction"]);
/**
 * Messages after the last context boundary on this branch, in order. System messages
 * are omitted to trigger pi's full prompt reconstruction, including role policy.
 */
export function heldMessages(entries) {
    let start = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry !== null && typeof entry === "object" && BOUNDARY_ENTRY_TYPES.has(entry.type)) {
            start = i + 1;
        }
    }
    const out = [];
    for (let i = start; i < entries.length; i++) {
        const entry = entries[i];
        if (entry === null || typeof entry !== "object" || entry.type !== "message")
            continue;
        const message = entry.message;
        if (message === null || typeof message !== "object")
            continue;
        if (message.role === "system")
            continue;
        out.push(message);
    }
    return out;
}
/**
 * Call ids from an assistant's ToolCall content blocks, in order; null for no calls.
 * Each parallel call requires a toolResult with a matching toolCallId.
 * Returns "unverifiable" if any call lacks a usable id.
 */
function toolCallIdsOf(message) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return null;
    const ids = [];
    let sawCall = false;
    let missing = false;
    for (const block of message.content) {
        if (block === null || typeof block !== "object")
            continue;
        const b = block;
        if (b.type !== "toolCall")
            continue;
        sawCall = true;
        if (typeof b.id === "string" && b.id !== "")
            ids.push(b.id);
        else
            missing = true;
    }
    if (!sawCall)
        return null;
    // Missing ids must refuse even when there are zero results to check.
    if (missing)
        return "unverifiable";
    return ids;
}
/** pi's native message shape, as `pairCycles` reads it. */
function nativeShape(messages) {
    return {
        length: messages.length,
        isResult: (i) => messages[i].role === "toolResult",
        callIds: (i) => toolCallIdsOf(messages[i]),
        resultId: (i) => {
            const id = messages[i].toolCallId;
            return typeof id === "string" && id !== "" ? id : null;
        },
    };
}
/** Renders a pairing refusal using pi's field names. */
function nativeReason(r) {
    switch (r.code) {
        case "stray-result":
            return `the tool result at message ${r.at} answers no tool call before it`;
        case "unverifiable-call":
            return `the assistant message at ${r.at} carries a tool call with no id, so this cycle cannot be verified`;
        case "result-without-id":
            return `the tool result at message ${r.at} carries no toolCallId`;
        case "answered-twice":
            return `the tool result at message ${r.at} answers ${r.id} twice`;
        case "unanswered-call":
            return `the tool call ${r.id} at message ${r.at} has no matching tool result`;
        case "unrequested-result":
            return `a tool result after message ${r.at} answers ${r.id}, which that message did not request`;
    }
}
/**
 * Adapts pi messages to pairCycles and returns complete cycles or a refusal reason.
 * Unusable call ids refuse pairing; the caller falls back to Σ alone.
 */
export function segmentCycles(messages) {
    const paired = pairCycles(nativeShape(messages));
    if ("refusal" in paired)
        return { reason: nativeReason(paired.refusal) };
    return { cycles: paired.cycles };
}
/**
 * Σ as a user message containing the preamble and exact committed bytes.
 * String content reaches the provider without parsing, preserving number precision
 * and canonical byte size. The caller supplies the timestamp.
 */
export function sigmaMessage(sigma, timestamp) {
    return {
        role: "user",
        content: stateWindowPreamble(sigma.versionText) + sigma.doc,
        timestamp,
    };
}
/**
 * Replacement order: Σ, newest user turn (O), then its last N complete tool cycles.
 * Retained pi message objects preserve every field and tool pairing.
 */
export function boundaryMessages(sigma, cycles, held, timestamp) {
    const alone = (narrowed) => ({
        messages: [sigmaMessage(sigma, timestamp)],
        dropped: { messages: held.length, cycles: countCycles(held), roles: rolesOf(held) },
        ...(narrowed === undefined ? {} : { narrowed }),
    });
    if (cycles === 0)
        return alone();
    const segmented = segmentCycles(held);
    if ("reason" in segmented)
        return alone(segmented.reason);
    // O is the newest user message; the trailing cycles are the work after it.
    let o = -1;
    for (let i = held.length - 1; i >= 0; i--) {
        if (held[i].role === "user") {
            o = i;
            break;
        }
    }
    const tailStart = o === -1 ? held.length : o + 1;
    const tailCycles = segmented.cycles.filter((c) => c.start >= tailStart);
    let keepFrom = tailStart;
    if (tailCycles.length > cycles) {
        keepFrom = tailCycles[tailCycles.length - cycles].start;
    }
    const kept = [];
    if (o !== -1)
        kept.push(held[o]);
    for (let i = keepFrom; i < held.length; i++)
        kept.push(held[i]);
    // Guard against a leading tool result without its call, which causes a provider 400.
    const opener = kept.find((m) => m !== held[o]);
    if (opener !== undefined && opener.role === "toolResult") {
        return alone("the trailing window would open on a tool result whose call was cut away");
    }
    // O is kept, so it is excluded from the dropped count although it precedes the cut.
    const droppedSlice = held.slice(0, keepFrom).filter((_, i) => i !== o);
    return {
        messages: [sigmaMessage(sigma, timestamp), ...kept],
        dropped: {
            messages: droppedSlice.length,
            cycles: segmented.cycles.filter((c) => c.start < keepFrom).length,
            roles: rolesOf(droppedSlice),
        },
    };
}
function countCycles(messages) {
    const segmented = segmentCycles(messages);
    return "reason" in segmented ? 0 : segmented.cycles.length;
}
function rolesOf(messages) {
    const roles = {};
    for (const m of messages) {
        const role = typeof m.role === "string" && m.role !== "" ? m.role : "(none)";
        roles[role] = (roles[role] ?? 0) + 1;
    }
    return roles;
}
/**
 * The UTF-8 byte count of the JSON serialization of a set of messages. `bytesBefore` and
 * `bytesAfter` on the record are the held branch and the replacement respectively.
 * `Buffer.byteLength` over `JSON.stringify` counts without allocating an encoded copy.
 */
function messagesBytes(messages) {
    return Buffer.byteLength(JSON.stringify(messages), "utf8");
}
/**
 * Write one boundary for an accepted commit, and return the record describing it.
 *
 * Pure except for the calls it makes on `pi`. A refusal never throws; pi keeps its existing
 * transcript.
 */
export function writeBoundary(pi, cfg, tally, deps, ctx) {
    const fail = (reason) => ({ failed: true, reason, ...tally });
    if (typeof pi.replaceTranscript !== "function") {
        return fail("this pi exposes no replaceTranscript, so the state loop has no way to bound the prompt");
    }
    const sigma = sigmaFromResult((deps.sigma ?? (() => stateCommitCache().latest()))());
    if (sigma === null) {
        return fail("no proven state_commit result to re-home, so there is nothing to bound the transcript to");
    }
    const entries = (deps.branch ?? sessionBranchEntries)(ctx);
    if (entries === null) {
        return fail("this pi exposes no readable session branch, so what the boundary would drop cannot be accounted for");
    }
    const held = heldMessages(entries);
    const plan = boundaryMessages(sigma, cfg.cycles, held, (deps.now ?? Date.now)());
    try {
        pi.replaceTranscript(plan.messages, {
            reason: `state loop: bounded to Σ v${sigma.versionText}`,
            source: STATE_BOUNDARY_SOURCE,
            // Apply at the end of this turn, before the next LLM call. "followUp" permits
            // another unbounded turn; "nextTurn" requires another prompt.
            deliverAs: "steer",
        });
    }
    catch (err) {
        return fail(`replaceTranscript refused the boundary: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
        cycles: cfg.cycles,
        messagesBefore: held.length,
        messagesAfter: plan.messages.length,
        bytesBefore: messagesBytes(held),
        bytesAfter: messagesBytes(plan.messages),
        droppedMessages: plan.dropped.messages,
        droppedCycles: plan.dropped.cycles,
        ...(Object.keys(plan.dropped.roles).length === 0 ? {} : { droppedRoles: plan.dropped.roles }),
        // Σ is emitted from the cache. A null Σ returns before recording.
        state: "rehomed",
        stateVersion: sigma.version,
        ...tally,
    };
}
/** The `source` stamped on every boundary entry, so pi's own UI names who wrote it. */
export const STATE_BOUNDARY_SOURCE = "pi-state-loop";
/**
 * Install-time refusal report. `[condition=… fault=…]` is parsed from stderr;
 * the leading text is for display. fault=false identifies an operator-set kill switch.
 */
export function stateBoundaryNotInstalled(off) {
    const lead = off.fault ? "state loop NOT INSTALLED" : "state loop off by operator configuration";
    return `[${STATE_BOUNDARY_SOURCE}] ${lead} [condition=${off.condition} fault=${off.fault ? "yes" : "no"}]: ${off.reason}`;
}
function sessionBranchEntries(ctx) {
    if (ctx === null || typeof ctx !== "object")
        return null;
    const manager = ctx.sessionManager;
    if (manager === null || typeof manager !== "object")
        return null;
    const getBranch = manager.getBranch;
    if (typeof getBranch !== "function")
        return null;
    try {
        const entries = getBranch.call(manager);
        return Array.isArray(entries) ? entries : null;
    }
    catch {
        return null;
    }
}
/**
 * Registers tool_result to capture an accepted commit and turn_end to write its boundary.
 * The branch at tool_result lacks the result; at turn_end the cycle is complete.
 * Planning earlier would fail pairing and retain only Σ. The ordering fixture is
 * `test/testdata/turn-event-ordering`.
 *
 * Writes one boundary per turn with an accepted commit, carrying the newest Σ. Parallel
 * commits share one turn_end; turns without commits write nothing. Off configurations
 * log their condition.
 */
export function installStateBoundary(pi, options, record, deps = {}) {
    const log = deps.log ?? ((message) => console.error(message));
    const setting = stateWindowSetting(options);
    if ("condition" in setting) {
        log(stateBoundaryNotInstalled(setting));
        return;
    }
    const cfg = setting;
    const tally = { requests: 0, rewrites: 0, refusals: 0 };
    const sigmaOf = deps.sigma ?? (() => stateCommitCache().latest());
    // The commit noticed on `tool_result` and not yet bounded. Holds Σ itself because the cache
    // may have moved on by `turn_end`; the boundary describes the commit that armed it.
    let pending = null;
    pi.on("tool_result", (event) => {
        // Only an accepted commit arms the boundary; see answeredBy.
        const latest = sigmaOf();
        if (latest !== null && answeredBy(event, latest))
            pending = latest;
        // undefined leaves the tool result unmodified.
        return undefined;
    });
    pi.on("turn_end", (_event, ctx) => {
        const sigma = pending;
        if (sigma === null)
            return undefined;
        pending = null;
        tally.requests++;
        const written = writeBoundary(pi, cfg, tally, { ...deps, sigma: () => sigma }, ctx);
        if ("failed" in written) {
            tally.refusals++;
            log(`[${STATE_BOUNDARY_SOURCE}] no boundary written: ${written.reason}`);
        }
        else {
            tally.rewrites++;
        }
        // Stamped after the counters move, so the record's totals include itself.
        record?.({ ...written, ...tally });
        return undefined;
    });
}
/**
 * True for an accepted state_commit whose id and text match the cached Σ.
 * Call ids can repeat across turns and on failed or unrelated results. The event must
 * pass observeStateCommitResult, then match both id and text. Matching text requires
 * the cache handler to have observed this result before the boundary handler.
 * Accepted tool-name aliases are interchangeable.
 */
function answeredBy(event, sigma) {
    const observed = observeStateCommitResult(event);
    if (observed === null)
        return false;
    return observed.toolCallId === sigma.toolCallId && observed.text === sigma.text;
}
//# sourceMappingURL=stateboundary.js.map