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
export const DEFAULT_TOOL_CYCLES = 4;

/**
 * Maximum trailing cycles. At roughly 500–2000 tokens per cycle, 20 cycles occupy
 * 10–40k tokens. Some external callers use the same write-boundary ceiling.
 */
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
 * Payload keys: version is a JSON number and doc a JSON object. Both reach the
 * prompt as exact sliced bytes. Success is determined separately by pi's isError flag.
 */
export const STATE_COMMIT_VERSION_KEY = "version";
export const STATE_COMMIT_DOC_KEY = "doc";

/** The custom entry type appended (pi.appendEntry) for every boundary record. Persisted format; do not rename. */
export const STATE_WINDOW_ENTRY_TYPE = "sproot-state-window";

/** Prefix of this module's diagnostics. */
const LOG_PREFIX = "pi-state-window";

/**
 * Preamble stating that earlier turns are absent and providing the next commit's CAS
 * version. The version is copied from the payload's exact bytes.
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
 * Parses a base-10 integer in 0..MAX_TOOL_CYCLES. Unset or empty uses
 * DEFAULT_TOOL_CYCLES. Invalid values, including surrounding whitespace, return null
 * and disable the mode; values are never clamped.
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

/** The longest raw value quoted into a diagnostic. */
const MAX_QUOTED = 60;

export function quoted(raw: string | undefined): string {
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
 * Session-bound cache. rebind replaces contents and identity together; observe adds
 * commits to the current session. observe/latest resolve the binding at call time,
 * including through captured methods. The public frozen view exposes neither the
 * inner cache nor rebind/sessionId, preventing partial updates and stale captures.
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
	// Freeze methods to preserve their reads of the current binding.
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

// Internal frozen binding; callers receive the frozen view below.
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
 * Replays entry messages through the live-result gate in branch order. Persisted
 * toolResult messages use the same toolName, toolCallId, content, and isError fields.
 * Malformed entries and unsuccessful results are ignored.
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
 * Current branch entries, or null when unavailable. getBranch walks the in-memory
 * parent chain without file I/O or transcript flushing. It excludes other branches
 * and retains commits removed from context by compaction.
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
 * Session id, or null when unavailable. pi assigns a new id on /new and /fork and
 * restores it from the file header on resume. Moving the file preserves identity.
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
 * Restores the cache on every session_start (/new, /fork, /resume, reload).
 * SessionManager.open loads entries before session_start. Persisted entries have shape
 * `{type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError}}`;
 * isError survives JSON serialization and reload.
 *
 * A readable branch replaces the cache. With an unreadable branch, only a matching
 * non-null session id retains it; a different, unreadable, or unrecorded id clears it.
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
	// Record the cleared session's identity so later reloads retain its new commits.
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
 * Extracts Σ from a successful cached result. Returns null unless version is a JSON
 * number and doc starts with an object. Checks use sliced bytes without parsing the payload.
 *
 * The prompt receives exact doc/version bytes. JSON.parse rounds 9999999999999999 to
 * 10000000000000000; reserialization can exceed the measured canonical byte cap.
 * Numeric version is for StateWindowEntryData only; the prompt uses versionText.
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
