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
 * The messages pi currently constructs context from, in order: everything after the last
 * boundary entry on this branch.
 *
 * System messages are dropped: pi replays every system message it finds into one leading
 * system message and diffs it against the wanted prompt, so dropping them makes pi re-emit
 * the current prompt, role policy included.
 */
export declare function heldMessages(entries: readonly unknown[]): PiMessage[];
/** One `assistant(toolCall…)` message plus the contiguous run of results answering it. */
interface Cycle {
    start: number;
    /** Inclusive index of the last tool result in the cycle. */
    end: number;
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
export declare function segmentCycles(messages: readonly PiMessage[]): {
    cycles: Cycle[];
} | {
    reason: string;
};
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
 * The replacement for one accepted commit: Σ, then the newest user turn (O), then the last N
 * complete tool cycles that trail it.
 *
 * Σ comes first because it is the oldest content in the new transcript. Messages are pi's
 * own objects, passed by reference and never rebuilt, so kept cycles stay paired and no
 * message field is lost.
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
 * The install-time report for an off configuration.
 *
 * `resolveStateWindow` refuses on three conditions; this message names which one applied.
 *
 * The bracket is a wire format: `[condition=… fault=…]` is machine-parseable from stderr. The
 * lead words are for humans and are not parsed. `fault` distinguishes a defect from an
 * operator-set kill switch (a negative control arm sets it on purpose).
 */
export declare function stateBoundaryNotInstalled(off: StateWindowOff): string;
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
 * `segmentCycles` would refuse it. Therefore `tool_result` arms and `turn_end` plans, when the
 * branch is complete.
 *
 * Invariant: one boundary per turn that accepted at least one commit, carrying the newest Σ.
 * Parallel `state_commit` calls in one assistant message produce two `toolResult`s and one
 * `turn_end`; Σ is CAS-versioned, so the later commit supersedes the earlier. A turn that
 * committed nothing writes nothing.
 *
 * An off configuration logs its condition (see stateBoundaryNotInstalled).
 */
export declare function installStateBoundary(pi: BoundaryAPI, options: StateWindowOptions, record?: BoundaryRecord, deps?: BoundaryDeps): void;
//# sourceMappingURL=stateboundary.d.ts.map