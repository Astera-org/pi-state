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
export const DEFAULT_TOOL_CYCLES = 4;

/** The ceiling on N. A complete tool cycle is roughly 500–2000 tokens, so 20 cycles is 10–40k tokens. */
export const MAX_TOOL_CYCLES = 20;

/**
 * The names a `state_commit` tool result is accepted under: the local tool name registered by
 * `src/entrypoint`, and the MCP-style `mcp__sproot__state_commit` for callers that front this
 * module with an MCP-backed tool.
 *
 * Names are matched exactly, not by suffix: `mcp__sproot-engram__state_commit` is a different
 * tool and is not eligible to become Σ.
 */
export const STATE_COMMIT_TOOL_NAMES: readonly string[] = ["state_commit", "mcp__sproot__state_commit"];

/**
 * The members Σ is extracted from in a successful `state_commit` payload: the committed
 * version and the committed document.
 *
 * A payload contract, not a success predicate (success is pi's `isError`, see
 * observeStateCommitResult): a success renders `version` as a JSON number and `doc` as a JSON
 * object. The sliced bytes of both reach the prompt, never a reserialization (see
 * sigmaFromResult).
 */
export const STATE_COMMIT_VERSION_KEY = "version";
export const STATE_COMMIT_DOC_KEY = "doc";

/** The custom entry type appended (pi.appendEntry) for every boundary record. Persisted format; do not rename. */
export const STATE_WINDOW_ENTRY_TYPE = "sproot-state-window";

/** Prefix of this module's diagnostics. */
const LOG_PREFIX = "pi-state-window";

/**
 * The preamble text placed before Σ's document. It states that earlier turns are absent and
 * names the version so the next `state_commit` has its CAS token; `version` is the payload's
 * raw bytes, quoted exactly as committed.
 */
export function stateWindowPreamble(version: string): string {
	return (
		`Your durable working state, as you last committed it with state_commit (version ${version}). ` +
		"Earlier turns of this run are not in this prompt; what follows is what survives of them.\n\n"
	);
}

export interface StateWindowConfig {
	/** N, already parsed and validated. */
	cycles: number;
}

const CYCLES_PATTERN = /^[0-9]+$/;

/**
 * N from configuration. Unset or empty yields DEFAULT_TOOL_CYCLES. Otherwise the value must
 * be a plain base-10 integer within 0..MAX_TOOL_CYCLES; anything else (a negative, a huge
 * number, `4oops`, a value with surrounding whitespace) returns null, which turns the mode
 * off. Values are never clamped or defaulted.
 */
export function parseToolCycles(raw: string | undefined): number | null {
	if (raw === undefined || raw === "") return DEFAULT_TOOL_CYCLES;
	if (!CYCLES_PATTERN.test(raw)) return null;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n > MAX_TOOL_CYCLES) return null;
	return n;
}

const KILL_SWITCH_AFFIRMATIVES = new Set(["1", "true", "yes", "on"]);
const KILL_SWITCH_NEGATIVES = new Set(["0", "false", "no", "off"]);

/**
 * How the kill switch reads: `allow` (unset, empty or an affirmative), `off` (a recognized
 * negative, the operator's decision) or `unrecognized` (any other value). `off` and
 * `unrecognized` both refuse; only `unrecognized` is a fault.
 */
function killSwitch(raw: string | undefined): "allow" | "off" | "unrecognized" {
	if (raw === undefined) return "allow";
	const value = raw.trim().toLowerCase();
	if (value === "" || KILL_SWITCH_AFFIRMATIVES.has(value)) return "allow";
	return KILL_SWITCH_NEGATIVES.has(value) ? "off" : "unrecognized";
}

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

/** The longest raw value quoted into a diagnostic. */
const MAX_QUOTED = 60;

function quoted(raw: string | undefined): string {
	if (raw === undefined) return "(unset)";
	return JSON.stringify(raw.length > MAX_QUOTED ? `${raw.slice(0, MAX_QUOTED)}…` : raw);
}

/**
 * The mode's configuration, or the condition that turned it off. `resolveStateWindow` is
 * derived from this function.
 */
export function stateWindowSetting(options: StateWindowOptions): StateWindowConfig | StateWindowOff {
	const kill = killSwitch(options.killSwitch);
	if (kill !== "allow") {
		return {
			condition: "kill-switch",
			fault: kill === "unrecognized",
			reason:
				kill === "off"
					? `killSwitch=${quoted(options.killSwitch)} — the operator kill switch is off, so the state loop is not installed`
					: `killSwitch=${quoted(options.killSwitch)} is not one of 1/true/yes/on; the kill switch refuses every value it does not recognize`,
		};
	}
	if (!options.enabled) {
		return {
			condition: "mode",
			fault: true,
			reason: "enabled=false — nothing configured the state loop for this session",
		};
	}
	const cycles = parseToolCycles(options.cycles);
	if (cycles === null) {
		return {
			condition: "cycles",
			fault: true,
			reason: `cycles=${quoted(options.cycles)} is not a plain base-10 integer in 0..${MAX_TOOL_CYCLES}`,
		};
	}
	return { cycles };
}

/** The mode's configuration, or null when it is off (the default, kill-switched, or malformed). */
export function resolveStateWindow(options: StateWindowOptions): StateWindowConfig | null {
	const setting = stateWindowSetting(options);
	return "condition" in setting ? null : setting;
}

export function isStateCommitToolName(name: unknown): boolean {
	return typeof name === "string" && STATE_COMMIT_TOOL_NAMES.includes(name);
}

/** A tool result's payload as text, from a string, an array of parts, or any other JSON value. */
export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
					return (part as { text: string }).text;
				}
				return JSON.stringify(part) ?? "";
			})
			.join("\n");
	}
	if (content === null || content === undefined) return "";
	return JSON.stringify(content) ?? "";
}

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
export function observeStateCommitResult(event: unknown): CachedStateCommit | null {
	if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
	const e = event as { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
	if (!isStateCommitToolName(e.toolName)) return null;
	if (e.isError !== false) return null;
	if (typeof e.toolCallId !== "string" || e.toolCallId === "") return null;
	// Frozen: `text` is the bytes Σ is extracted from.
	return Object.freeze({ toolName: e.toolName as string, toolCallId: e.toolCallId, text: toolResultText(e.content) });
}

export function newStateCommitCache(): StateCommitCache {
	let newest: CachedStateCommit | null = null;
	return Object.freeze({
		observe(event: unknown): void {
			const seen = observeStateCommitResult(event);
			// A result that is not a proven state_commit success leaves the previous Σ standing: the
			// newest success is Σ, and a later refusal must not shadow it.
			if (seen !== null) newest = seen;
		},
		latest: () => newest,
	});
}

/**
 * The process's Σ and the session it belongs to, behind an accessor that always resolves the
 * current binding.
 *
 * Σ is per-conversation, so the cached contents and their session id are one fact. `rebind`
 * takes both and is the only way to change either; `bound.sigma = x` does not typecheck.
 *
 * `observe` and `latest` read the closed-over binding at call time, so a captured reference
 * to the accessor or either method stays correct across rebinding. The inner cache is never
 * handed out.
 *
 * Guarantees:
 *   - A partial update (contents without identity) is a compile error.
 *   - A stale capture is impossible at runtime: every accessor dereferences the current
 *     binding when called.
 *   - Rebinding from outside is impossible at runtime: stateCommitCache() returns a frozen
 *     two-method view. `rebind` and `sessionId` are not properties of it, and its methods
 *     cannot be reassigned.
 *
 * `observe` does not rebind: a live commit adds to the session already identified here.
 */
interface BoundStateCommitCache extends StateCommitCache {
	/** The session id the contents belong to, or null when never established. */
	sessionId(): string | null;
	/** Replace the contents and the identity together. */
	rebind(sigma: StateCommitCache, sessionId: string | null): void;
}

function newBoundStateCommitCache(): BoundStateCommitCache {
	let sigma = newStateCommitCache();
	let sessionId: string | null = null;
	// Frozen: the methods close over `sigma`; reassigning one would substitute a reader that never sees a rebinding.
	return Object.freeze({
		observe: (event: unknown) => sigma.observe(event),
		latest: () => sigma.latest(),
		sessionId: () => sessionId,
		rebind: (next: StateCommitCache, id: string | null) => {
			sigma = next;
			sessionId = id;
		},
	});
}

// Frozen as a guard against edits inside this file. Not externally reachable
// (stateCommitCache() returns the view), so not covered by a test.
const bound = newBoundStateCommitCache();

/**
 * The view every caller outside this module gets: two frozen methods delegating to the
 * current binding. `rebind` and `sessionId` are absent at runtime.
 */
const view: StateCommitCache = Object.freeze({
	observe: (event: unknown) => bound.observe(event),
	latest: () => bound.latest(),
});

/** The process-wide cache. Safe to capture, including its methods: both resolve the current binding when called. */
export function stateCommitCache(): StateCommitCache {
	return view;
}

/** Drop what the process has cached. For tests. */
export function resetStateCommitCache(): void {
	bound.rebind(newStateCommitCache(), null);
}

/**
 * Seed a cache from a session's entries (the transcript pi just reloaded).
 *
 * Pure over the entry list. A persisted `toolResult` message carries `toolName`,
 * `toolCallId`, `content` and `isError` under the names observeStateCommitResult reads, so
 * each entry's message goes through the same gate as a live event. Replaying the branch in
 * order yields the Σ the live run would have cached. Entries that are not messages, and
 * messages that are not successful state_commit results, are ignored by that gate.
 */
export function seedStateCommitCacheFromEntries(cache: StateCommitCache, entries: readonly unknown[]): void {
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		cache.observe((entry as { message?: unknown }).message);
	}
}

/** The slice of pi's extension API this registration needs. */
interface ToolResultAPI {
	on(event: "tool_result", handler: (event: unknown, ctx: unknown) => unknown): void;
}

/**
 * The entries of the session branch this context is on, or null when this pi exposes no way
 * to read them.
 *
 * `getBranch()` on `ExtensionContext.sessionManager` walks the parent chain from the current
 * leaf over the in-memory index, so it reads no file and does not depend on transcript
 * flushing. It is used instead of `getEntries()` (which includes other branches) and
 * `buildContextEntries()` (compaction-aware; Σ must survive a compaction that dropped its
 * cycle).
 */
function sessionBranchEntries(ctx: unknown): readonly unknown[] | null {
	const manager = sessionManagerOf(ctx);
	if (manager === null || typeof manager.getBranch !== "function") return null;
	let entries: unknown;
	try {
		entries = (manager.getBranch as () => unknown)();
	} catch {
		return null;
	}
	return Array.isArray(entries) ? entries : null;
}

function sessionManagerOf(ctx: unknown): Record<string, unknown> | null {
	if (ctx === null || typeof ctx !== "object") return null;
	const manager = (ctx as { sessionManager?: unknown }).sessionManager;
	if (manager === null || typeof manager !== "object") return null;
	return manager as Record<string, unknown>;
}

/**
 * This context's session id, or null when it cannot be established.
 *
 * `getSessionId` identifies the conversation Σ belongs to: pi assigns a fresh id for a new
 * session and for a fork, and reads it from the file header on a resume. It therefore
 * differs across replacements that must not share a Σ and holds across a reload of the same
 * session. The file path is not used, since a session moved on disk is the same
 * conversation.
 */
function sessionIdentity(ctx: unknown): string | null {
	const manager = sessionManagerOf(ctx);
	if (manager === null || typeof manager.getSessionId !== "function") return null;
	let id: unknown;
	try {
		id = (manager.getSessionId as () => unknown)();
	} catch {
		return null;
	}
	return typeof id === "string" && id !== "" ? id : null;
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
export function seedStateCommitCache(ctx: unknown, log?: (message: string) => void): void {
	const id = sessionIdentity(ctx);
	const entries = sessionBranchEntries(ctx);
	if (entries !== null) {
		const sigma = newStateCommitCache();
		seedStateCommitCacheFromEntries(sigma, entries);
		bound.rebind(sigma, id);
		return;
	}
	if (id !== null && id === bound.sessionId()) {
		log?.(
			`[${LOG_PREFIX}] this pi exposes no readable session branch, but this is still session ${id} — kept the Σ already cached`,
		);
		return;
	}
	// The identity is recorded with the clear: it is the session the cache is now empty for, so
	// a later reload of this session keeps whatever it commits in between.
	bound.rebind(newStateCommitCache(), id);
	log?.(
		`[${LOG_PREFIX}] this pi exposes no readable session branch and this session is not the one the cache was built for — cleared Σ rather than carry another session's into it`,
	);
}

/**
 * Register the cache on pi's `tool_result` event. The handler returns undefined, leaving the
 * event unmodified. `observe` is total over `unknown` and does not throw.
 */
export function installStateCommitCache(pi: ToolResultAPI): void {
	pi.on("tool_result", (event) => {
		bound.observe(event);
	});
}

/**
 * The exact bytes of a top-level member's value in a JSON object text, or null when the text
 * is not an object or has no such member.
 *
 * A scanner that tracks string boundaries and backslash escapes, so a `}` or `"doc":` inside
 * a string value does not end the span early. Duplicate keys resolve to the last one,
 * matching JSON.parse.
 */
export function rawJsonMember(text: string, key: string): string | null {
	let i = skipWhitespace(text, 0);
	if (text[i] !== "{") return null;
	i++;
	let found: string | null = null;
	for (;;) {
		i = skipWhitespace(text, i);
		if (text[i] === "}") return found;
		if (text[i] !== '"') return null;
		const keyEnd = scanString(text, i);
		if (keyEnd < 0) return null;
		let name: string;
		try {
			name = JSON.parse(text.slice(i, keyEnd)) as string;
		} catch {
			return null;
		}
		i = skipWhitespace(text, keyEnd);
		if (text[i] !== ":") return null;
		const valueStart = skipWhitespace(text, i + 1);
		const valueEnd = scanValue(text, valueStart);
		if (valueEnd < 0) return null;
		if (name === key) found = text.slice(valueStart, valueEnd);
		i = skipWhitespace(text, valueEnd);
		if (text[i] === ",") {
			i++;
			continue;
		}
		if (text[i] === "}") return found;
		return null;
	}
}

function skipWhitespace(text: string, i: number): number {
	while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
	return i;
}

/** Index just past the string starting at `i`, or -1. */
function scanString(text: string, i: number): number {
	if (text[i] !== '"') return -1;
	i++;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === '"') return i + 1;
		i++;
	}
	return -1;
}

/** Index just past the JSON value starting at `i`, or -1. */
function scanValue(text: string, i: number): number {
	const c = text[i];
	if (c === '"') return scanString(text, i);
	if (c === "{" || c === "[") {
		const open = c;
		const close = c === "{" ? "}" : "]";
		let depth = 0;
		while (i < text.length) {
			const ch = text[i]!;
			if (ch === '"') {
				const end = scanString(text, i);
				if (end < 0) return -1;
				i = end;
				continue;
			}
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth === 0) return i + 1;
			}
			i++;
		}
		return -1;
	}
	// number / true / false / null: runs to the next structural delimiter.
	const start = i;
	while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
	return i > start ? i : -1;
}

/** A JSON number, as the sliced `version` bytes must spell one. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

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
 * turns `9999999999999999` into `10000000000000000`). `version` as a number is used only for
 * the transcript record (StateWindowEntryData.stateVersion); the prompt gets `versionText`.
 */
export function sigmaFromResult(cached: CachedStateCommit | null): Sigma | null {
	if (cached === null) return null;
	const doc = rawJsonMember(cached.text, STATE_COMMIT_DOC_KEY);
	if (doc === null || doc[0] !== "{") return null;
	const versionText = rawJsonMember(cached.text, STATE_COMMIT_VERSION_KEY);
	if (versionText === null || !JSON_NUMBER.test(versionText)) return null;
	return { toolCallId: cached.toolCallId, text: cached.text, version: Number(versionText), versionText, doc };
}

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
	 *   unproven  results arrived and none proved a commit.
	 */
	state: "in-window" | "rehomed" | "absent" | "unproven";
	/** The version Σ proved it committed. Absent on `absent` and `unproven`. */
	stateVersion?: number;
}

/**
 * The running tally stamped on every entry, success or refusal. Each entry carries totals,
 * not a delta.
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

/** The marker appended instead of a record when the mode was on and the boundary could not be produced. */
export type StateWindowFailure = { failed: true; reason: string } & StateWindowTally;

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
export function recordStateWindowIntoTranscript(
	pi: { appendEntry?: (customType: string, data?: unknown) => void },
	data: StateWindowEntry | StateWindowFailure,
	log?: (message: string) => void,
): void {
	if (typeof pi.appendEntry !== "function") {
		log?.(`[${LOG_PREFIX}] pi.appendEntry is unavailable — the rewrite was not recorded`);
		return;
	}
	try {
		pi.appendEntry(STATE_WINDOW_ENTRY_TYPE, data);
	} catch (err) {
		log?.(`[${LOG_PREFIX}] appendEntry failed — the rewrite was not recorded: ${describe(err)}`);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
