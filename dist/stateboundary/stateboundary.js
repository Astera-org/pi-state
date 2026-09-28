/**
 * Delivers Σ through pi's transcript boundary.
 *
 * What Σ is lives in `statewindow.ts` and is imported from it: the `tool_result` cache and
 * its `isError` selection, the escape-aware extraction of `doc`/`version` from the payload
 * bytes, the preamble sentence, fail-closed configuration parsing, and the
 * `sproot-state-window` transcript record (STATE_WINDOW_ENTRY_TYPE). This module handles
 * delivery: one `pi.replaceTranscript([Σ, O, N])` per turn that accepted at least one commit,
 * carrying the newest Σ.
 *
 * A boundary is a session entry pi constructs context from, so the bound survives reload and
 * branch navigation and is what pi's accounting measures. The session file still grows: a
 * boundary bounds what the model sees, not what is stored.
 *
 * Properties of the design:
 *
 *   - No preamble message is emitted. pi rebuilds the system message from its own options when
 *     the transcript carries none (`getCurrentSystemMessage` returns undefined, so
 *     `diffSystemPromptSections` emits the full set), so a role policy delivered with
 *     `--append-system-prompt` is still sent after the boundary.
 *   - Kept messages are pi's own message objects, taken verbatim from the session, so a kept
 *     cycle is already paired. pi never applies a replacement between a tool call and its
 *     result.
 *   - Σ is written, not located in an existing body.
 *
 * Failure mode: a replacement pi cannot send leaves the agent unable to take a turn, so every
 * path that cannot produce a well-formed trailing window falls back to Σ alone, which needs
 * no pairing, and records the reason.
 */
import { pairCycles } from "./pairing.js";
import { DEFAULT_TOOL_CYCLES, observeStateCommitResult, resolveStateWindow, sigmaFromResult, stateCommitCache, stateWindowPreamble, stateWindowSetting, } from "./statewindow.js";
export { DEFAULT_TOOL_CYCLES, resolveStateWindow, stateWindowSetting, };
/** Entry types that end context construction (pi's `isContextBoundaryEntry`). */
const BOUNDARY_ENTRY_TYPES = new Set(["transcript", "compaction"]);
/**
 * The messages pi currently constructs context from, in order: everything after the last
 * boundary entry on this branch.
 *
 * System messages are dropped: pi replays every system message it finds into one leading
 * system message and diffs it against the wanted prompt, so dropping them makes pi re-emit
 * the current prompt, role policy included.
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
 * The tool-call ids an assistant message asked for, in order, or null when it asked for none.
 *
 * pi's `AssistantMessage.content` is `(TextContent | ThinkingContent | ToolCall)[]` and
 * `ToolCall` carries its own `id`, so one assistant message can hold N calls (parallel
 * calls), each answered by its own `toolResult` message bearing a matching `toolCallId`.
 *
 * A call with no usable id returns `"unverifiable"`, not null: the caller must refuse rather
 * than treat the message as call-free.
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
    // Signalled in the return value: a short id list would pass the zero-results case through
    // pairCycles (no ids to iterate, arity check reduced to `0 !== 0`).
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
 * Segment the held messages into complete tool cycles, refusing anything not fully paired.
 *
 * Adapts pi's message shape to `pairCycles` and renders refusals as `{ reason }`. The
 * `"unverifiable"` judgement (a call content block with no usable id) is made in
 * `toolCallIdsOf`.
 *
 * A refusal is not an error: the caller keeps Σ alone, which needs no pairing.
 */
export function segmentCycles(messages) {
    const paired = pairCycles(nativeShape(messages));
    if ("refusal" in paired)
        return { reason: nativeReason(paired.refusal) };
    return { cycles: paired.cycles };
}
/**
 * Σ as a single user message: the preamble sentence followed by the committed document's
 * exact bytes.
 *
 * `content` is a plain string, so `doc` and `version` reach the prompt as the exact sliced
 * bytes; a JavaScript parse/serialize round trip would lose arbitrary-precision numbers and
 * the canonical byte form. pi's `UserMessage.content` is
 * `string | (TextContent | ImageContent)[]`, and nothing between here and the provider
 * parses it.
 *
 * `timestamp` is supplied by the caller, which keeps this function pure.
 */
export function sigmaMessage(sigma, timestamp) {
    return {
        role: "user",
        content: stateWindowPreamble(sigma.versionText) + sigma.doc,
        timestamp,
    };
}
/**
 * The replacement for one accepted commit: Σ, then the newest user turn (O), then the last N
 * complete tool cycles that trail it.
 *
 * Σ comes first because it is the oldest content in the new transcript, and a user message
 * preceding the turn it precedes is an ordering every provider accepts. Messages are pi's
 * own objects, passed by reference and never rebuilt, so kept cycles stay paired and no
 * message field is lost.
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
    // The cut lands on a cycle start, so the kept run cannot open on a tool result whose call
    // was cut away; checked anyway because that would be a provider 400.
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
            // "steer" applies the replacement at the end of the current turn, before the next LLM
            // call. "followUp" waits for the run to settle, letting another turn go out on the
            // unbounded transcript; "nextTurn" waits for a prompt a self-driving agent may never
            // receive.
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
        // Always `rehomed`: the window states describe where Σ sat in an outgoing request body.
        // `in-window` would claim a body position that no longer exists, and the no-Σ states
        // are unreachable because a null Σ has already returned.
        state: "rehomed",
        stateVersion: sigma.version,
        ...tally,
    };
}
/** The `source` stamped on every boundary entry, so pi's own UI names who wrote it. */
export const STATE_BOUNDARY_SOURCE = "pi-state-loop";
/**
 * The install-time report for an off configuration.
 *
 * `resolveStateWindow` refuses on three conditions; this message names which one applied.
 *
 * The bracket is a wire format: `[condition=… fault=…]` is machine-parseable from stderr. The
 * lead words are for humans and are not parsed. `fault` distinguishes a defect from an
 * operator-set kill switch (a negative control arm sets it on purpose).
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
 * Register the boundary on pi's `tool_result` and `turn_end` events.
 *
 * `tool_result` notices an accepted commit (pi's `isError` is available only there), but at
 * that moment pi has not persisted the result:
 *
 *   tool_result  […, user, assistant(toolCall:X)]
 *   turn_end     […, user, assistant(toolCall:X), toolResult(X)]
 *
 * Planning at `tool_result` would read a branch whose last cycle is unpaired, so
 * `segmentCycles` would refuse it and every commit would fall back to Σ alone. Therefore
 * `tool_result` arms and `turn_end` plans, when the branch is complete. A test fixture whose
 * `getBranch` already contains the finished cycle does not exercise this ordering; the
 * recording in `test/testdata/turn-event-ordering` does.
 *
 * Invariant: one boundary per turn that accepted at least one commit, carrying the newest Σ.
 * Parallel `state_commit` calls in one assistant message produce two `toolResult`s and one
 * `turn_end`; Σ is CAS-versioned, so the later commit supersedes the earlier. A turn that
 * committed nothing writes nothing.
 *
 * An off configuration logs its condition (see stateBoundaryNotInstalled).
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
 * Whether this `tool_result` event is an accepted `state_commit` whose result is the Σ now
 * in the cache.
 *
 * The id alone is insufficient: `tool_call_id` is not unique across turns (pi replays a
 * repeated one verbatim, onto failed results too), and the cache retains the previous Σ when
 * a commit is refused. A later result reusing the id of an accepted commit, whether a refused
 * commit or an unrelated successful `read`, would otherwise match the standing Σ.
 *
 * The event is therefore first put through `observeStateCommitResult` (exact tool name,
 * literal `isError === false`, usable id), then compared on id and text. Text equality holds
 * when the cache handler runs before this one; if that ordering breaks, the texts differ and
 * no boundary is written.
 *
 * The tool name is not compared again: `observeStateCommitResult` has already restricted it
 * to the accepted set, and a second comparison would reject the same commit cached under a
 * different accepted spelling (`state_commit` vs the `mcp__sproot__` form).
 */
function answeredBy(event, sigma) {
    const observed = observeStateCommitResult(event);
    if (observed === null)
        return false;
    return observed.toolCallId === sigma.toolCallId && observed.text === sigma.text;
}
//# sourceMappingURL=stateboundary.js.map