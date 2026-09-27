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
import { type CachedStateCommit, DEFAULT_TOOL_CYCLES, resolveStateWindow, type Sigma, type StateWindowConfig, type StateWindowEntryData, type StateWindowFailure, type StateWindowOff, type StateWindowOptions, type StateWindowTally, stateWindowSetting } from "./statewindow.js";
export { DEFAULT_TOOL_CYCLES, resolveStateWindow, stateWindowSetting, type StateWindowConfig, type StateWindowOff, type StateWindowOptions, };
/**
 * pi's own message shape, structurally. Only the fields this module reads are named;
 * everything else on a message travels because the object is passed through by reference
 * and never rebuilt.
 */
interface PiMessage {
    role?: unknown;
    content?: unknown;
    /** `ToolResultMessage.toolCallId` — what pairs a result back to the call it answers. */
    toolCallId?: unknown;
}
/**
 * The messages pi currently CONSTRUCTS CONTEXT FROM, in order: everything after the last
 * boundary entry on this branch.
 *
 * System messages are dropped rather than carried. Not a simplification — pi replays every
 * system message it finds into one leading system message and diffs it against the prompt it
 * wants, so carrying one forward would pin the model to the sections that message happened
 * to hold. Dropping them is what makes pi re-emit the CURRENT prompt, role policy included.
 */
export declare function heldMessages(entries: readonly unknown[]): PiMessage[];
/** One `assistant(toolCall…)` message plus the contiguous run of results answering it. */
interface Cycle {
    start: number;
    /** Inclusive index of the last tool result in the cycle. */
    end: number;
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
export declare function segmentCycles(messages: readonly PiMessage[]): {
    cycles: Cycle[];
} | {
    reason: string;
};
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
export declare function sigmaMessage(sigma: Sigma, timestamp: number): PiMessage;
export interface BoundaryPlan {
    /** What `pi.replaceTranscript` is handed, in order. */
    messages: PiMessage[];
    /** The record's accounting, minus the byte counts the caller measures. */
    dropped: {
        messages: number;
        cycles: number;
        roles: Record<string, number>;
    };
    /**
     * Why the trailing window was narrowed below N, or undefined when it was not. Carried to
     * the record so a run that is quietly at N=0 is readable as that rather than as a
     * configuration nobody chose.
     */
    narrowed?: string;
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
export declare function boundaryMessages(sigma: Sigma, cycles: number, held: readonly PiMessage[], timestamp: number): BoundaryPlan;
/** The slice of pi's extension API this module drives. */
export interface BoundaryAPI {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
    replaceTranscript?(messages: unknown[], options?: unknown): void;
    appendEntry?(customType: string, data?: unknown): void;
}
type BoundaryRecord = (data: (StateWindowEntryData & StateWindowTally) | StateWindowFailure) => void;
export interface BoundaryDeps {
    /** The branch entries this context is on, or null when this pi exposes none. */
    branch?: (ctx: unknown) => readonly unknown[] | null;
    /** Σ, read at CALL time so a rebind of the process cache is always seen. */
    sigma?: () => CachedStateCommit | null;
    now?: () => number;
    log?: (message: string) => void;
}
/**
 * Write one boundary for an accepted commit, and return the record describing it.
 *
 * Pure except for the two calls it makes on `pi`, so the whole decision is unit-testable
 * against a fake: what the replacement holds, what it says was dropped, and every path that
 * refuses. A refusal never throws and never costs the turn — pi keeps the transcript it
 * already had, which is the large-prompt outcome rather than a broken one.
 */
export declare function writeBoundary(pi: BoundaryAPI, cfg: StateWindowConfig, tally: StateWindowTally, deps: BoundaryDeps, ctx: unknown): (StateWindowEntryData & StateWindowTally) | StateWindowFailure;
/** The `source` stamped on every boundary entry, so pi's own UI names who wrote it. */
export declare const STATE_BOUNDARY_SOURCE = "pi-state-loop";
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
export declare function stateBoundaryNotInstalled(off: StateWindowOff): string;
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
export declare function installStateBoundary(pi: BoundaryAPI, options: StateWindowOptions, record?: BoundaryRecord, deps?: BoundaryDeps): void;
//# sourceMappingURL=stateboundary.d.ts.map