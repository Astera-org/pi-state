/**
 * Shared Σ machinery for the state loop. `stateboundary.ts` delivers Σ by replacing pi's
 * transcript; this module defines what Σ is:
 *
 *   - Configuration, parsed fail-closed (resolveStateWindow) from a plain options object. A
 *     malformed value never selects a default and never enables anything: it turns the mode
 *     off. Mapping environment variables to the options object is the caller's concern.
 *   - The `tool_result` cache and its selection of the newest state_commit result pi reported
 *     successful (observeStateCommitResult). Success is pi's `isError`, never derived from
 *     the result text.
 *   - Byte-exact extraction of `doc` and `version` from the result's payload (rawJsonMember
 *     and its scanner). Σ reaches the prompt as sliced bytes, so an arbitrary-precision
 *     version is quoted exactly as committed.
 *   - The preamble sentence Σ is delivered under (stateWindowPreamble).
 *   - The `sproot-state-window` transcript record (STATE_WINDOW_ENTRY_TYPE).
 *
 * `STATE_WINDOW_ENTRY_TYPE` is a persisted format: transcripts on disk and tooling that reads
 * them carry the string `sproot-state-window`.
 */
/**
 * What a caller resolves its environment into before calling this module. No `process.env`
 * read happens in this file, `stateboundary.ts` or `pairing.ts`. The caller decides how its
 * environment spells each option. Fail-closed parsing (the kill switch's asymmetric
 * accept/refuse rule and the cycle count's strict integer grammar) is shared here; the
 * `enabled` gate is resolved by the caller.
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
 * The ceiling on N. A complete tool cycle is roughly 500–2000 tokens, so 20 cycles is
 * 10–40k tokens; a higher ceiling would allow the unbounded growth this mode exists to
 * remove. Matches the write-boundary ceiling some external callers use.
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
 * The members Σ is extracted from in a successful `state_commit` payload: the committed
 * version and the committed document.
 *
 * A payload contract, not a success predicate (success is pi's `isError`, see
 * observeStateCommitResult): a success renders `version` as a JSON number and `doc` as a JSON
 * object. The sliced bytes of both reach the prompt, never a reserialization (see
 * sigmaFromResult).
 */
export declare const STATE_COMMIT_VERSION_KEY = "version";
export declare const STATE_COMMIT_DOC_KEY = "doc";
/** The custom entry type appended (pi.appendEntry) for every boundary record. Persisted format; do not rename. */
export declare const STATE_WINDOW_ENTRY_TYPE = "sproot-state-window";
/**
 * The preamble text placed before Σ's document. It states that earlier turns are absent
 * (a state document with no account of the missing history reads as a corrupted transcript)
 * and names the version so the next `state_commit` has its CAS token; `version` is the
 * payload's raw bytes, quoted exactly as committed.
 */
export declare function stateWindowPreamble(version: string): string;
export interface StateWindowConfig {
    /** N, already parsed and validated. */
    cycles: number;
}
/**
 * N from configuration. Unset or empty yields DEFAULT_TOOL_CYCLES. Otherwise the value must
 * be a plain base-10 integer within 0..MAX_TOOL_CYCLES; anything else (a negative, a huge
 * number, `4oops`, a value with surrounding whitespace) returns null, which turns the mode
 * off. Values are never clamped or replaced by the default, since either would run the mode
 * at a depth nobody configured.
 */
export declare function parseToolCycles(raw: string | undefined): number | null;
/** Which of the three conditions refused. */
export type StateWindowCondition = "kill-switch" | "mode" | "cycles";
/** Why the state loop is off, when it is. */
export interface StateWindowOff {
    condition: StateWindowCondition;
    /**
     * Whether this is a fault rather than a choice. False only for a recognized negative kill
     * switch; an unreadable kill switch, a mode that is not enabled and an unparseable cycle
     * count are faults.
     */
    fault: boolean;
    reason: string;
}
/**
 * The mode's configuration, or the condition that turned it off. `resolveStateWindow` is
 * derived from this function.
 */
export declare function stateWindowSetting(options: StateWindowOptions): StateWindowConfig | StateWindowOff;
/** The mode's configuration, or null when it is off (the default, kill-switched, or malformed). */
export declare function resolveStateWindow(options: StateWindowOptions): StateWindowConfig | null;
export declare function isStateCommitToolName(name: unknown): boolean;
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
 * The newest successful `state_commit` result, or null. Σ is read from it.
 *
 * Success is taken from pi's `tool_result` event `isError` flag. A stale-version CAS refusal
 * (`StaleStateVersionError` in `src/backend`) is an expected, retryable outcome, not a fault,
 * and the serialized tool message carries no error flag, so it cannot be distinguished from
 * a success by its text.
 *
 * Volatile and per-process: rebuilt by the run, never the authority for anything (the store
 * is).
 *
 * A resumed session reloads its transcript but replays no tool execution, so the live event
 * stream alone would leave the cache empty. seedStateCommitCache fills it at `session_start`
 * from the persisted entries: pi persists `isError` on every `toolResult` entry and reloads
 * it verbatim, so the flag remains the only success signal.
 */
interface StateCommitCache {
    /** Record one `tool_result` event. Anything that is not a proven success is ignored. */
    observe(event: unknown): void;
    latest(): CachedStateCommit | null;
}
/**
 * What `observe` would store for one `tool_result` event, or null.
 *
 * Every gate fails closed. `isError` is compared to the literal `false`, so an absent flag is
 * not a success. The tool name must be in STATE_COMMIT_TOOL_NAMES (exact match), and the
 * call id must be a non-empty string.
 */
export declare function observeStateCommitResult(event: unknown): CachedStateCommit | null;
export declare function newStateCommitCache(): StateCommitCache;
/** The process-wide cache. Safe to capture, including its methods: both resolve the current binding when called. */
export declare function stateCommitCache(): StateCommitCache;
/** Drop what the process has cached. For tests. */
export declare function resetStateCommitCache(): void;
/**
 * Seed a cache from a session's entries (the transcript pi just reloaded).
 *
 * Pure over the entry list. A persisted `toolResult` message carries `toolName`,
 * `toolCallId`, `content` and `isError` under the names observeStateCommitResult reads, so
 * each entry's message goes through the same gate as a live event. Replaying the branch in
 * order yields the Σ the live run would have cached. Entries that are not messages, and
 * messages that are not successful state_commit results, are ignored by that gate.
 */
export declare function seedStateCommitCacheFromEntries(cache: StateCommitCache, entries: readonly unknown[]): void;
/** The slice of pi's extension API this registration needs. */
interface ToolResultAPI {
    on(event: "tool_result", handler: (event: unknown, ctx: unknown) => unknown): void;
}
/**
 * Re-derive the process cache from the session pi has just opened.
 *
 * pi persists a finalized tool call as
 * `{type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError, …}}`
 * (`_persist` writes `JSON.stringify(entry)`; the loader is a bare `JSON.parse` per line),
 * so `isError` is present after a reload.
 *
 * Called on every `session_start`, which is re-entrant (`/new`, `/fork`, `/resume`, reload):
 * a session replacement swaps the transcript, and a Σ cached from the replaced session is not
 * this one's. `SessionManager.open` loads the entries before the runtime that emits
 * `session_start` is built, so they are available here.
 *
 * When the branch cannot be read, retention is tied to identity. A reload of the same session
 * keeps the cache; a replacement must clear it, and both arrive through the same event. The
 * cache is kept only when `getSessionId` matches the session the cache was established for; a
 * different, unreadable or unrecorded id clears.
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
 * Σ extracted from a cached successful `state_commit` result, or null when the payload cannot
 * be carried.
 *
 * Success was already decided by pi (`isError === false`). Extraction fails closed: null when
 * `version` does not slice out as a JSON number or `doc` does not slice out as a JSON object
 * (a drift from the `state_commit` result shape produced by `stateCommitTool` in
 * `src/entrypoint/index.ts`). Both checks run on the sliced bytes, without parsing the whole
 * payload.
 *
 * The prompt receives the raw bytes of `doc` and `version`, never a reserialization: the
 * `agentstate` core preserves arbitrary-precision numbers (`JsonNumber`) and caps the
 * document's exact canonical bytes, and a JavaScript round trip changes both (`JSON.parse`
 * turns `9999999999999999` into `10000000000000000`, and a re-serialized document can exceed
 * the byte cap it was measured against). `version` as a number is used only for
 * the transcript record (StateWindowEntryData.stateVersion); the prompt gets `versionText`.
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
 * The running tally stamped on every entry, success or refusal. Each entry carries totals,
 * not a delta, so a run that refuses every turn is distinguishable from a healthy one
 * from a single entry.
 *
 * Counters are per-process and reset on restart; they are never authoritative.
 */
export interface StateWindowTally {
    /** Boundary attempts since install. */
    requests: number;
    rewrites: number;
    refusals: number;
}
type StateWindowEntry = StateWindowEntryData & StateWindowTally;
/**
 * The marker appended instead of a record when the mode was on and the boundary could not
 * be produced. It distinguishes "attempted and failed" from "not attempted".
 */
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