/**
 * State-loop configuration, successful-commit caching, exact doc/version extraction,
 * preamble generation, and transcript records. stateboundary.ts delivers the result.
 * Malformed configuration disables the mode. Success requires pi's isError=false.
 * `sproot-state-window` is a persisted record type used by transcript readers.
 */
/**
 * Caller-supplied configuration. This module, stateboundary.ts, and pairing.ts read
 * no environment variables. Kill-switch and cycle-count parsing fail closed.
 */
export interface StateWindowOptions {
    /**
     * Whether the bounded-prompt mode is turned on for this session. A caller that finds no
     * configuration, or an unrecognized spelling, must resolve this to `false`.
     */
    enabled: boolean;
    /**
     * The operator kill switch in its raw spelling: unset/empty, a recognized affirmative
     * (`1`/`true`/`yes`/`on`, trimmed and case-folded), a recognized negative
     * (`0`/`false`/`no`/`off`), or anything else. Parsed here: only an affirmative or
     * empty/unset allows the mode; a negative or unrecognized value refuses.
     */
    killSwitch?: string;
    /**
     * N, raw: unset/empty means the default depth. Otherwise it must be a plain base-10 integer
     * within 0..MAX_TOOL_CYCLES; anything else turns the mode off. See parseToolCycles.
     */
    cycles?: string;
}
/** The trailing tool-cycle depth used when N is not configured. Constant; Σ carries anything older. */
export declare const DEFAULT_TOOL_CYCLES = 4;
/**
 * Maximum trailing cycles. At roughly 500–2000 tokens per cycle, 20 cycles occupy
 * 10–40k tokens. Some external callers use the same write-boundary ceiling.
 */
export declare const MAX_TOOL_CYCLES = 20;
/**
 * The names a `state_commit` tool result is accepted under: the local tool name registered by
 * `src/entrypoint`, and the MCP-style `mcp__sproot__state_commit` for callers that front this
 * module with an MCP-backed tool.
 *
 * Names are matched exactly, not by suffix: `mcp__sproot-engram__state_commit` is a different
 * tool and is not eligible to become Σ.
 */
export declare const STATE_COMMIT_TOOL_NAMES: readonly string[];
/**
 * Payload keys: version is a JSON number and doc a JSON object. Both reach the
 * prompt as exact sliced bytes. Success is determined separately by pi's isError flag.
 */
export declare const STATE_COMMIT_VERSION_KEY = "version";
export declare const STATE_COMMIT_DOC_KEY = "doc";
/** The custom entry type appended (pi.appendEntry) for every boundary record. Persisted format; do not rename. */
export declare const STATE_WINDOW_ENTRY_TYPE = "sproot-state-window";
/**
 * Preamble stating that earlier turns are absent and providing the next commit's CAS
 * version. The version is copied from the payload's exact bytes.
 */
export declare function stateWindowPreamble(version: string): string;
export interface StateWindowConfig {
    /** N, already parsed and validated. */
    cycles: number;
}
/**
 * Parses a base-10 integer in 0..MAX_TOOL_CYCLES. Unset or empty uses
 * DEFAULT_TOOL_CYCLES. Invalid values, including surrounding whitespace, return null
 * and disable the mode; values are never clamped.
 */
export declare function parseToolCycles(raw: string | undefined): number | null;
/** Which condition refused. */
export type StateWindowCondition = "kill-switch" | "mode" | "cycles" | "state-mode" | "require-commit";
/** Why the state loop is off, when it is. */
export interface StateWindowOff {
    condition: StateWindowCondition;
    /**
     * False only for a recognized negative kill switch. Invalid switches, disabled mode,
     * and invalid cycle counts are faults.
     */
    fault: boolean;
    reason: string;
}
export declare function quoted(raw: string | undefined): string;
/**
 * The mode's configuration, or the condition that turned it off. `resolveStateWindow` is
 * derived from this function.
 */
export declare function stateWindowSetting(options: StateWindowOptions): StateWindowConfig | StateWindowOff;
/** The mode's configuration, or null when it is off (the default, kill-switched, or malformed). */
export declare function resolveStateWindow(options: StateWindowOptions): StateWindowConfig | null;
export declare function isStateCommitToolName(name: unknown): boolean;
export declare function isStateGetToolName(name: unknown): boolean;
/** A tool result's payload as text, from a string, an array of parts, or any other JSON value. */
export declare function toolResultText(content: unknown): string;
/** One finalized `state_commit` result that pi reported successful. */
export interface CachedStateCommit {
    /** The name it arrived under: one of STATE_COMMIT_TOOL_NAMES. */
    toolName: string;
    /** pi's id for the call it answered. */
    toolCallId: string;
    /** The result's content as text, as pi held it. */
    text: string;
}
/**
 * Newest successful state_commit result, or null. Success requires tool_result.isError=false;
 * serialized payload text alone cannot distinguish a retryable stale-version refusal.
 * The cache is volatile and per-process; the store is authoritative.
 *
 * Session resume replays no tool execution. seedStateCommitCache restores the cache
 * at session_start from persisted toolResult entries, including their isError flags.
 */
interface StateCommitCache {
    /** Record one `tool_result` event. Anything that is not a proven success is ignored. */
    observe(event: unknown): void;
    latest(): CachedStateCommit | null;
}
/**
 * Returns a successful commit result or null. Requires an exact accepted tool name,
 * literal isError=false, and a non-empty call id. Missing flags refuse.
 */
export declare function observeStateCommitResult(event: unknown): CachedStateCommit | null;
export declare function newStateCommitCache(): StateCommitCache;
/** The process-wide cache. Safe to capture, including its methods: both resolve the current binding when called. */
export declare function stateCommitCache(): StateCommitCache;
/** Drop what the process has cached. For tests. */
export declare function resetStateCommitCache(): void;
/**
 * Replays entry messages through the live-result gate in branch order. Persisted
 * toolResult messages use the same toolName, toolCallId, content, and isError fields.
 * Malformed entries and unsuccessful results are ignored.
 */
export declare function seedStateCommitCacheFromEntries(cache: StateCommitCache, entries: readonly unknown[]): void;
/** The slice of pi's extension API this registration needs. */
interface ToolResultAPI {
    on(event: "tool_result", handler: (event: unknown, ctx: unknown) => unknown): void;
}
/**
 * Restores the cache on every session_start (/new, /fork, /resume, reload).
 * SessionManager.open loads entries before session_start. Persisted entries have shape
 * `{type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError}}`;
 * isError survives JSON serialization and reload.
 *
 * A readable branch replaces the cache. With an unreadable branch, only a matching
 * non-null session id retains it; a different, unreadable, or unrecorded id clears it.
 */
export declare function seedStateCommitCache(ctx: unknown, log?: (message: string) => void): void;
/**
 * Register the cache on pi's `tool_result` event. The handler returns undefined, leaving the
 * event unmodified. `observe` is total over `unknown` and does not throw.
 */
export declare function installStateCommitCache(pi: ToolResultAPI): void;
/**
 * The exact bytes of a top-level member's value in a JSON object text, or null when the text
 * is not an object or has no such member.
 *
 * A scanner that tracks string boundaries and backslash escapes, so a `}` or `"doc":` inside
 * a string value does not end the span early. Duplicate keys resolve to the last one,
 * matching JSON.parse.
 */
export declare function rawJsonMember(text: string, key: string): string | null;
/**
 * Extracts Σ from a successful cached result. Returns null unless version is a JSON
 * number and doc starts with an object. Checks use sliced bytes without parsing the payload.
 *
 * The prompt receives exact doc/version bytes. JSON.parse rounds 9999999999999999 to
 * 10000000000000000; reserialization can exceed the measured canonical byte cap.
 * Numeric version is for StateWindowEntryData only; the prompt uses versionText.
 */
export declare function sigmaFromResult(cached: CachedStateCommit | null): Sigma | null;
/**
 * The entry appended for every boundary. Custom entries are not part of LLM context; the
 * record shows that a turn was bounded and what it dropped.
 */
export interface StateWindowEntryData {
    /** N as configured. */
    cycles: number;
    messagesBefore: number;
    messagesAfter: number;
    bytesBefore: number;
    bytesAfter: number;
    droppedMessages: number;
    /** Complete tool cycles removed. */
    droppedCycles: number;
    /** Dropped message counts by their own role spelling. */
    droppedRoles?: Record<string, number>;
    /**
     * How Σ reached the prompt. Only `rehomed` is written: a boundary is written from the cache
     * and `stateboundary.ts` returns before recording when Σ is null. The other values are part
     * of the persisted format and remain valid when reading existing transcripts.
     *
     *   in-window kept where it stood inside a surviving cycle.
     *   absent    no `state_commit` result at all.
     *   unproven  results arrived and none proved a commit (a refusal-only turn, or a result
     *             shape this module cannot read); `absent` means the agent has not committed.
     */
    state: "in-window" | "rehomed" | "absent" | "unproven";
    /** The version Σ proved it committed. Absent on `absent` and `unproven`. */
    stateVersion?: number;
}
/**
 * Per-process cumulative totals on every success or refusal entry. Reset on restart;
 * not authoritative.
 */
export interface StateWindowTally {
    /** Boundary attempts since install. */
    requests: number;
    rewrites: number;
    refusals: number;
}
type StateWindowEntry = StateWindowEntryData & StateWindowTally;
/** Failure record for an enabled mode that could not produce a boundary. */
export type StateWindowFailure = {
    failed: true;
    reason: string;
} & StateWindowTally;
/** Σ, ready for the prompt: the raw bytes plus the result that carried them. */
export interface Sigma {
    toolCallId: string;
    /** The cached result's exact text, from which `doc` and `version` were extracted. */
    text: string;
    /** For the transcript record only; the prompt gets versionText. */
    version: number;
    versionText: string;
    doc: string;
}
/**
 * Persist one boundary record, or the failure marker, into the transcript under
 * STATE_WINDOW_ENTRY_TYPE. If `appendEntry` is missing or throws, only the record is lost.
 */
export declare function recordStateWindowIntoTranscript(pi: {
    appendEntry?: (customType: string, data?: unknown) => void;
}, data: StateWindowEntry | StateWindowFailure, log?: (message: string) => void): void;
export {};
//# sourceMappingURL=statewindow.d.ts.map