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
import { type CachedStateCommit, DEFAULT_TOOL_CYCLES, resolveStateWindow, type Sigma, type StateWindowConfig, type StateWindowEntryData, type StateWindowFailure, type StateWindowOff, type StateWindowOptions, type StateWindowTally, stateWindowSetting } from "./statewindow.js";
export { DEFAULT_TOOL_CYCLES, resolveStateWindow, stateWindowSetting, type StateWindowConfig, type StateWindowOff, type StateWindowOptions, };
/**
 * pi's message shape, structurally. Only the fields this module reads are named; messages are
 * passed through by reference and never rebuilt.
 */
interface PiMessage {
    role?: unknown;
    content?: unknown;
    /** `ToolResultMessage.toolCallId` — what pairs a result back to the call it answers. */
    toolCallId?: unknown;
}
/**
 * Messages after the last context boundary on this branch, in order. System messages
 * are omitted to trigger pi's full prompt reconstruction, including role policy.
 */
export declare function heldMessages(entries: readonly unknown[]): PiMessage[];
/** One `assistant(toolCall…)` message plus the contiguous run of results answering it. */
interface Cycle {
    start: number;
    /** Inclusive index of the last tool result in the cycle. */
    end: number;
}
/**
 * Adapts pi messages to pairCycles and returns complete cycles or a refusal reason.
 * Unusable call ids refuse pairing; the caller falls back to Σ alone.
 */
export declare function segmentCycles(messages: readonly PiMessage[]): {
    cycles: Cycle[];
} | {
    reason: string;
};
/**
 * Σ as a user message containing the preamble and exact committed bytes.
 * String content reaches the provider without parsing, preserving number precision
 * and canonical byte size. The caller supplies the timestamp.
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
    /** Why the trailing window was narrowed below N, or undefined when it was not. */
    narrowed?: string;
}
/**
 * Replacement order: Σ, newest user turn (O), then its last N complete tool cycles.
 * Retained pi message objects preserve every field and tool pairing.
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
    /** Σ, read at call time so a rebind of the process cache is seen. */
    sigma?: () => CachedStateCommit | null;
    now?: () => number;
    log?: (message: string) => void;
}
/**
 * Write one boundary for an accepted commit, and return the record describing it.
 *
 * Pure except for the calls it makes on `pi`. A refusal never throws; pi keeps its existing
 * transcript.
 */
export declare function writeBoundary(pi: BoundaryAPI, cfg: StateWindowConfig, tally: StateWindowTally, deps: BoundaryDeps, ctx: unknown): (StateWindowEntryData & StateWindowTally) | StateWindowFailure;
/** The `source` stamped on every boundary entry, so pi's own UI names who wrote it. */
export declare const STATE_BOUNDARY_SOURCE = "pi-state-loop";
/**
 * Install-time refusal report. `[condition=… fault=…]` is parsed from stderr;
 * the leading text is for display. fault=false identifies an operator-set kill switch.
 */
export declare function stateBoundaryNotInstalled(off: StateWindowOff): string;
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
export declare function installStateBoundary(pi: BoundaryAPI, options: StateWindowOptions, record?: BoundaryRecord, deps?: BoundaryDeps): void;
//# sourceMappingURL=stateboundary.d.ts.map