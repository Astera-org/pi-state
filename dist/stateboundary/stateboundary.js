/**
 * Deliver Σ through pi's TRANSCRIPT BOUNDARY instead of a request rewrite.
 *
 * The sibling of `statewindow.ts` and deliberately its narrowest possible
 * variation: everything about WHAT Σ is stays in that module and is imported from it —
 * the `tool_result` cache and its `isError` selection, the escape-aware carving
 * of `doc`/`version` out of the payload's own bytes, the preamble sentence, the
 * configuration's fail-closed parsing, and the `sproot-state-window` transcript record
 * (STATE_WINDOW_ENTRY_TYPE). What changes here is DELIVERY, and delivery alone:
 *
 *   statewindow.ts   (retired half) every outgoing POST /chat/completions was rewritten
 *                    into [P(+Σ), O, N trailing tool cycles]
 *   this module      one `pi.replaceTranscript([Σ, O, N])` per TURN that accepted at least
 *                    one commit, carrying the newest Σ
 *
 * WHY THAT IS NOT THE SAME FEATURE TWICE. A rewrite is per-request and invisible to pi: pi
 * holds the whole transcript, reports context from the provider's `usage`, and its own
 * accounting never sees the smaller prompt. A boundary is a session entry pi CONSTRUCTS
 * CONTEXT FROM, so the bound is pi's own: it survives reload and branch navigation, it is
 * what pi's accounting measures, and pi will never compact a transcript the model never
 * saw. The session file still grows — a boundary bounds what the model sees, not what is
 * stored.
 *
 * THREE THINGS THE BOUNDARY REMOVES BY CONSTRUCTION, rather than by getting them right:
 *
 *   - A `System message must be at the beginning` 400. This module never emits a
 *     preamble message at all. pi rebuilds the system message from its OWN options when the
 *     transcript no longer carries one (`getCurrentSystemMessage` returns undefined, so
 *     `diffSystemPromptSections` emits the full set), which is why a role policy delivered
 *     with `--append-system-prompt` is still in the request after the boundary.
 *   - The unmatched-`tool_call_id` 400. pi never applies a replacement between a tool call
 *     and its result, and the messages this module keeps are pi's OWN message objects taken
 *     verbatim out of the session, so a kept cycle is paired because it was already paired.
 *   - Re-deriving which body message is Σ. A retired rewrite matched on id AND the
 *     cached result's exact text, because a fetch wrapper only ever sees an
 *     already-serialized body. Here Σ is written, not found.
 *
 * FAIL CLOSED, in this module's own direction. `statewindow.ts`'s retired request-rewrite
 * half failed by forwarding the ORIGINAL body — the prompt stays large and nothing is
 * corrupted. The failure available here is different: a replacement pi cannot send is an
 * agent that cannot take a turn. So every path that cannot produce a well-formed trailing
 * window falls back to Σ ALONE, which needs no pairing and is always well-formed, and says
 * so on the record. A smaller prompt than the role asked for is a degraded turn; a
 * mis-paired one is a 400.
 */
import { pairCycles } from "./pairing.js";
import { DEFAULT_TOOL_CYCLES, observeStateCommitResult, resolveStateWindow, sigmaFromResult, stateCommitCache, stateWindowPreamble, stateWindowSetting, } from "./statewindow.js";
export { DEFAULT_TOOL_CYCLES, resolveStateWindow, stateWindowSetting, };
/**
 * The entry types that END context construction — pi's own `isContextBoundaryEntry`. A
 * branch walk that ignored them would hand back messages pi itself no longer sends, and the
 * trailing window would then be cut out of a transcript the model has not seen since the
 * last boundary.
 */
const BOUNDARY_ENTRY_TYPES = new Set(["transcript", "compaction"]);
/**
 * The messages pi currently CONSTRUCTS CONTEXT FROM, in order: everything after the last
 * boundary entry on this branch.
 *
 * System messages are dropped rather than carried. Not a simplification — pi replays every
 * system message it finds into one leading system message and diffs it against the prompt it
 * wants, so carrying one forward would pin the model to the sections that message happened
 * to hold. Dropping them is what makes pi re-emit the CURRENT prompt, role policy included.
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
 * `ToolCall` carries its own `id` — so ONE assistant message can hold N calls, each answered
 * by its own `toolResult` MESSAGE bearing a matching `toolCallId`. That is not a theoretical
 * reading of the types: parallel calls are the ordinary shape of a pi turn.
 *
 * A call with no usable id makes the cycle unverifiable rather than empty — the caller must
 * refuse, not treat the message as call-free — so that case is a REFUSAL below, not a null.
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
    // A call block with no usable id makes the cycle UNVERIFIABLE, and that has to be visible in
    // the RETURN VALUE rather than recoverable from `ids.length` downstream. Returning a short
    // list would let the zero-results case through segmentCycles entirely: no ids to iterate,
    // nothing answered, and the arity check reduced to `0 !== 0`.
    if (missing)
        return "unverifiable";
    return ids;
}
/** pi's NATIVE message shape, as `pairCycles` reads it. */
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
/** THIS SIDE'S OWN WORDS for a refusal the shared core decided — pi's field names, not the wire's. */
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
 * Segment the held messages into complete tool cycles, refusing anything not already fully
 * paired.
 *
 * THE RULE IS NOT HERE. It is `pairing.ts`'s `pairCycles`, and this function is the
 * pi-native ADAPTER plus this module's vocabulary.
 *
 * `toolCallIdsOf`'s `"unverifiable"` is the one genuinely shape-specific judgement and it
 * stays on this side: a pi assistant message carries its calls as content blocks, so a block
 * with no usable id is discovered here.
 *
 * A refusal is not an error: it means this module cannot PROVE a trailing window is paired,
 * so the caller keeps Σ alone — which needs no pairing and is always well-formed.
 */
export function segmentCycles(messages) {
    const paired = pairCycles(nativeShape(messages));
    if ("refusal" in paired)
        return { reason: nativeReason(paired.refusal) };
    return { cycles: paired.cycles };
}
/**
 * Σ as the one message that carries it: the preamble sentence, then the committed document's
 * OWN BYTES.
 *
 * `content` is a plain string, which is the whole of why this delivery is admissible. Σ
 * reaches the prompt as the exact sliced bytes of `doc` and `version` — go-core preserves
 * arbitrary-precision numbers and caps the document's exact canonical bytes, and a
 * JavaScript round trip survives neither — so the carrier had to be one that treats them as
 * opaque. pi's `UserMessage.content` is `string | (TextContent | ImageContent)[]` and
 * nothing between here and the provider parses it.
 *
 * The timestamp is the caller's, not `Date.now()`: it keeps this function pure, which is
 * what lets the unit tests assert the message rather than a shape around it.
 */
export function sigmaMessage(sigma, timestamp) {
    return {
        role: "user",
        content: stateWindowPreamble(sigma.versionText) + sigma.doc,
        timestamp,
    };
}
/**
 * The replacement for one accepted commit: Σ, then the newest user turn, then the last N
 * complete tool cycles that trail it.
 *
 * The shape is `statewindow.ts`'s retired `[P(+Σ), O, N]` minus P, because pi supplies P
 * itself. The ORDER is Σ first: Σ is the oldest thing in the new transcript (it summarizes
 * everything before it), and a user message before the turn it precedes is the ordering
 * every provider accepts.
 *
 * Messages are pi's own objects, passed through by reference and never rebuilt. That is the
 * pairing guarantee: a kept cycle is paired because it was already paired, and no field of
 * a message this module did not write can be lost by it.
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
    // O — the newest user message. Everything after it is the work the agent has done since it
    // was last spoken to, which is what the trailing cycles are.
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
    // A kept run that opens on a tool result would be one whose tool call was cut away. The
    // cut lands on a cycle START so this cannot happen by construction — which is exactly why
    // it is checked rather than assumed: the check costs nothing and the failure it would
    // catch is a provider 400 on a live agent.
    const opener = kept.find((m) => m !== held[o]);
    if (opener !== undefined && opener.role === "toolResult") {
        return alone("the trailing window would open on a tool result whose call was cut away");
    }
    // O is kept, so it is not among the dropped even though it sits before the cut.
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
 * The UTF-8 byte count of what a set of messages would serialize to. `bytesBefore` and
 * `bytesAfter` on the record are HELD versus SENT, and under a boundary both sides are still
 * observable to this module: held is the branch it just read, sent is the replacement it
 * just wrote.
 *
 * `Buffer.byteLength` over `JSON.stringify`, not an encode: it counts without allocating a
 * second copy of what it measures.
 */
function messagesBytes(messages) {
    return Buffer.byteLength(JSON.stringify(messages), "utf8");
}
/**
 * Write one boundary for an accepted commit, and return the record describing it.
 *
 * Pure except for the two calls it makes on `pi`, so the whole decision is unit-testable
 * against a fake: what the replacement holds, what it says was dropped, and every path that
 * refuses. A refusal never throws and never costs the turn — pi keeps the transcript it
 * already had, which is the large-prompt outcome rather than a broken one.
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
            // `deliverAs: "steer"` — the end of the current turn, before the next LLM call. Not
            // "followUp" (which waits for the run to settle and would let another turn go out on
            // the unbounded transcript) and not "nextTurn" (which waits for a prompt that a
            // self-driving agent may never receive).
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
        // ALWAYS `rehomed`. The window's four states answer "where did Σ come from in this
        // request", which only a reader of an outgoing body can ask; a boundary is written from
        // the cache every time, so the honest answer is the same one every time. `in-window`
        // would claim a body position that no longer exists, and the two no-Σ states are
        // unreachable here — this function has already returned on a null Σ.
        state: "rehomed",
        stateVersion: sigma.version,
        ...tally,
    };
}
/** The `source` stamped on every boundary entry, so pi's own UI names who wrote it. */
export const STATE_BOUNDARY_SOURCE = "pi-state-loop";
/**
 * The install-time report: this module's ONE remaining silent failure, given a voice.
 *
 * `installStateBoundary` used to `return` on an off configuration with no log, no record
 * and no counter, and `resolveStateWindow` refuses on THREE conditions that were
 * indistinguishable from outside it. So a run could register its tools, take its turns
 * and have its commits accepted while the boundary was never installed at all — which is
 * exactly what an operator measured (0 boundaries, `retention.refusals` 0, nothing logged
 * anywhere) and could not diagnose. Every OTHER failure path in this module already logs a
 * reason and writes a record; this one now names the condition too.
 *
 * THE BRACKET IS A WIRE FORMAT, not decoration: `[condition=… fault=…]` is meant to be
 * machine-parseable off stderr by an automated harness that drives a run and wants to
 * refuse one whose bounded arm silently never installed, with the same loudness a
 * missing dependency would get. The lead words are for the human and nothing parses
 * them. The `fault` flag is what keeps the asymmetry `stateWindowSetting` is built on
 * visible on the wire: a negative control arm sets the kill switch ON PURPOSE, and a
 * harness that read that as a defect would refuse every run that carried its own
 * control.
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
 * Register the boundary on pi's `tool_result` event — the same event the Σ cache observes,
 * and deliberately the same one.
 *
 * TWO EVENTS, AND THE SPLIT IS THE WHOLE POINT. `tool_result` answers "was a commit
 * accepted" — pi's `isError` exists nowhere later — but at that moment pi HAS NOT
 * PERSISTED THE RESULT. The branch at `tool_result` ends at the assistant message that
 * made the call:
 *
 *   tool_result  […, user, assistant(toolCall:X)]
 *   turn_end     […, user, assistant(toolCall:X), toolResult(X)]
 *
 * Planning there therefore reads a branch whose last cycle is UNPAIRED, `segmentCycles`
 * refuses it, and every accepted commit falls back to Σ alone — the retention half silently
 * never runs. That is not a hypothetical: this module shipped that way, and nothing caught it.
 * The unit tests fed hand-built `getBranch` fixtures that always contained the finished cycle,
 * and a bytes probe passed on Σ-alone because Σ-alone still carries Σ byte-exact. A total
 * collapse of retention was invisible to every instrument aimed at it.
 *
 * So: NOTICE on `tool_result`, PLAN on `turn_end`, where the branch is complete.
 *
 * WHAT THE INVARIANT ACTUALLY IS, because an earlier comment here overstated it as "one
 * boundary per accepted commit" and that is false. Two `state_commit` calls CAN land in one
 * turn — parallel tool calls are the ordinary pi shape: two calls in one assistant message
 * produce two `toolResult`s and one `turn_end`. What holds is ONE BOUNDARY PER TURN THAT
 * ACCEPTED AT LEAST ONE COMMIT, CARRYING THE NEWEST Σ. That is correct rather than a
 * rounding: Σ is CAS-versioned, so the later commit supersedes the earlier, and writing two
 * boundaries would make the first meaningless the instant the second landed. A turn that
 * committed nothing writes nothing.
 *
 * AND IT SAYS SO WHEN IT INSTALLS NOTHING — see stateBoundaryNotInstalled.
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
    // The commit noticed on `tool_result` and not yet bounded. Holding the Σ ITSELF rather than
    // a boolean is deliberate: by the time `turn_end` runs the cache may have moved on, and the
    // boundary must describe the commit that triggered it.
    let pending = null;
    pi.on("tool_result", (event) => {
        // Only an ACCEPTED commit arms the boundary — and that is a question about THIS EVENT.
        // See answeredBy.
        const latest = sigmaOf();
        if (latest !== null && answeredBy(event, latest))
            pending = latest;
        // undefined, so pi records the event unmodified: this observes a tool result, never
        // rewrites one.
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
        // Re-stamped after the counters moved, so the record carries the totals INCLUDING itself
        // — what makes "47 commits, 47 refusals" readable from a single entry. The tally's SHAPE
        // is `statewindow.ts`'s by import rather than by resemblance (`StateWindowTally` above),
        // so a field added there is a compile error here; what is asserted in a test is the
        // counting itself, which no type can hold.
        record?.({ ...written, ...tally });
        return undefined;
    });
}
/**
 * Whether this `tool_result` event IS an accepted `state_commit` whose result is the Σ now
 * standing in the cache.
 *
 * THE ID ALONE IS NOT THAT QUESTION, and answering it that way shipped a real defect at one
 * point: `tool_call_id` carries no cross-turn uniqueness guarantee — pi replays a repeated
 * one verbatim, onto failed results too — and the cache DELIBERATELY RETAINS the previous Σ
 * when a commit is refused, because a refusal is the designed retry path and must not erase
 * the agent's memory. Those two facts compose into the bug: after one accepted commit under
 * id `X`, every later result reusing `X` — a REFUSED commit, or an unrelated successful
 * `read` — matched the standing Σ on its id, armed the boundary, and bounded the transcript
 * on a turn that accepted nothing, against a Σ that had not moved.
 *
 * So the event is put through the SAME predicate that decides what may become Σ at all
 * (`observeStateCommitResult`: the exact tool name, a literal `isError === false`, a usable
 * id) rather than a second definition of "accepted" written here.
 *
 * Then the id AND the TEXT are compared. A cache handler registered before this one makes an
 * accepted commit already this event's own result by the time this runs; comparing `text` is
 * what establishes that rather than assuming it. If that ordering ever breaks, the texts
 * differ and no boundary is written — a prompt that stays large, which is the safe
 * direction. Two events agreeing on id AND bytes produced the same Σ, so treating them as
 * one is correct rather than a collapse.
 *
 * The tool NAME is deliberately NOT compared again: `observeStateCommitResult` has already
 * refused anything outside the accepted set, so a second comparison is unreachable — and where
 * it would bite (one commit cached under `state_commit`, the next under the `mcp__sproot__`
 * spelling, same id and same bytes) it would refuse a boundary that is legitimate.
 */
function answeredBy(event, sigma) {
    const observed = observeStateCommitResult(event);
    if (observed === null)
        return false;
    return observed.toolCallId === sigma.toolCallId && observed.text === sigma.text;
}
//# sourceMappingURL=stateboundary.js.map