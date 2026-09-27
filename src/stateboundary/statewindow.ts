/**
 * WHAT Σ IS — the state loop's shared Σ machinery. This module is deliberately not a
 * delivery mechanism itself: `stateboundary.ts` bounds the prompt by replacing pi's
 * transcript, and everything IT needs to answer "what is Σ" lives here:
 *
 *   - the configuration, parsed FAIL CLOSED (resolveStateWindow) from a plain options
 *     object rather than the environment. A malformed value never selects a default and
 *     never enables anything: it turns the mode off. An experimental prompt bound that
 *     switches itself on from a typo is the failure this whole feature exists to avoid.
 *     Turning an environment variable into that options object — whatever a given caller
 *     names its variables — is a separate, thin concern that lives outside this module.
 *   - the `tool_result` cache and its selection of the newest state_commit result PI
 *     REPORTED SUCCESSFUL (observeStateCommitResult). Success is pi's own `isError`,
 *     never something re-derived from the result text — see that function for why the
 *     text could not answer it.
 *   - the byte-exact carving of `doc` and `version` out of the result's own payload
 *     (rawJsonMember and its scanner). Σ reaches the prompt as sliced bytes, so an
 *     arbitrary-precision version is quoted back exactly as committed rather than
 *     through a JavaScript number.
 *   - the preamble sentence Σ is delivered under (stateWindowPreamble).
 *   - the `sproot-state-window` transcript record (STATE_WINDOW_ENTRY_TYPE below).
 *
 * THE NAME STAYS `statewindow`, and `STATE_WINDOW_ENTRY_TYPE` STAYS `sproot-state-window`,
 * even though this repo has no sproot adapter of its own: both are carried over unrenamed
 * from where this mechanism was first built, in the private Astera-org/sproot repo, purely
 * because the entry-type STRING is a captured format — transcripts already on disk (and
 * any tooling that reads them by that name) carry it verbatim, and renaming the constant
 * would only orphan those rows, not change anything this module does. Nothing else here
 * carries such a contract: nothing in this file reads an environment variable by name any
 * more, so there is no other sproot-specific spelling left to rename.
 *
 * THIS MODULE ALSO USED TO POWER A SECOND DELIVERY MECHANISM, now retired: a fetch
 * interceptor that rewrote every outgoing `POST /chat/completions` body into
 * `[P(+Σ), O, N trailing tool cycles]`, for a host with no `replaceTranscript`-style hook
 * of its own. This repo never runs that interceptor — `stateboundary.ts`'s transcript
 * boundary is the only delivery path here — but it is worth naming the two KNOWN
 * EXPOSURES it had, both consequences of bounding a request pi could not see: pi's held
 * transcript growing to V8's old-space limit, and a provider reporting zero or absent
 * `usage` dropping pi into local estimation over that transcript. Neither is a property of
 * this module any more — a boundary is a session entry pi constructs context from, so the
 * bound is pi's own — and `stateboundary.ts`'s header states what does and does not carry
 * over.
 */

/**
 * What a caller resolves its own environment into before calling into this module. NO
 * `process.env` read happens anywhere in this file or in `stateboundary.ts`/`pairing.ts` —
 * a caller (this repo's own `src/entrypoint`, or any other host with its own variable
 * names) decides how its environment spells each of these and hands over the result. That
 * keeps the fail-closed PARSING that matters — the kill switch's asymmetric accept/refuse rule,
 * and the cycle count's strict integer grammar — in one place shared by every caller,
 * while the trivial "is the mode on for this session at all" gate is resolved by the
 * caller, which is the only side that knows what its own variable is even called.
 */
export interface StateWindowOptions {
	/**
	 * Whether the bounded-prompt mode is turned on for this session at all. A caller that
	 * finds no such configuration, or an unrecognized spelling of one, must resolve this to
	 * `false` — this module never treats an absent or malformed `enabled` as a default-on.
	 */
	enabled: boolean;
	/**
	 * The operator kill switch, in whatever raw spelling the caller's environment carries —
	 * unset/empty, a recognized affirmative (`1`/`true`/`yes`/`on`, trimmed and
	 * case-folded), a recognized negative (`0`/`false`/`no`/`off`), or anything else. Parsed
	 * here, not by the caller, so the asymmetric fail-closed rule (permissive toward off,
	 * strict toward on) is enforced identically by every caller rather than re-implemented
	 * per adapter.
	 */
	killSwitch?: string;
	/**
	 * N, raw: unset/empty means the default depth: not configured is not malformed.
	 * Otherwise it must be a plain base-10 integer within 0..MAX_TOOL_CYCLES; anything
	 * else — a negative, a huge number, `4oops`, a value with surrounding whitespace —
	 * turns the mode off. See parseToolCycles for the parsing contract.
	 */
	cycles?: string;
}

/** N — how many trailing tool cycles survive. See parseToolCycles for the parsing contract. */

/**
 * The depth used when N is not configured at all. Enough for the model to see
 * the tool round trips it just made, and a CONSTANT — the whole point of the
 * mode is that this does not grow with the run. Σ, not the tail, is what
 * carries anything older.
 */
export const DEFAULT_TOOL_CYCLES = 4;

/**
 * The ceiling on N. 20 is not arbitrary: a complete tool cycle runs ~500–2000 tokens, so
 * 20 trailing cycles is already 10–40k tokens of context. Twice that would be 32–128k —
 * the growth this mode exists to remove. (It also matches a write-boundary check on the
 * sproot side, where this mechanism originated, so a caller adapting sproot's own
 * configuration can carry the number over unchanged — but nothing in this module depends
 * on that agreement holding.)
 */
export const MAX_TOOL_CYCLES = 20;

/**
 * The ONLY two names a `state_commit` tool result can arrive under: the bare local-tool
 * name this repo's own entrypoint registers (`src/entrypoint`), and one MCP-style name —
 * `mcp__sproot__state_commit` — kept recognized for a caller that fronts this same shared
 * module with an MCP-backed `state_commit` tool of its own (this repo does not; its tools
 * are always local, never MCP). Recognizing that second spelling here costs a standalone
 * caller nothing, since a tool actually named that way never appears in this repo's own
 * runs.
 *
 * A suffix match would be wrong, not merely loose: `mcp__sproot-engram__state_commit`
 * names a DIFFERENT tool and must stay ineligible to become the agent's Σ, so both
 * accepted names are matched exactly.
 */
export const STATE_COMMIT_TOOL_NAMES: readonly string[] = ["state_commit", "mcp__sproot__state_commit"];

/**
 * The two members Σ is carved out of a successful `state_commit` payload: the
 * committed version, and the committed document itself.
 *
 * These are a PAYLOAD contract, not a success predicate. Whether a result
 * succeeded is pi's `isError` (observeStateCommitResult); what these
 * two keys owe is only that a success renders `version` as a JSON number and
 * `doc` as a JSON object, because the raw bytes of both are what reach the
 * prompt. What is re-homed here is the sliced bytes and never a
 * reserialization (see sigmaFromResult).
 */
export const STATE_COMMIT_VERSION_KEY = "version";
export const STATE_COMMIT_DOC_KEY = "doc";

/**
 * The custom entry type this module appends (pi.appendEntry) for every rewrite. The
 * string stays `sproot-state-window` rather than following this package's own name
 * because it is a CAPTURED FORMAT: existing transcripts already have entries on disk
 * under that name, and renaming it would orphan those rows rather than relabel them.
 */
export const STATE_WINDOW_ENTRY_TYPE = "sproot-state-window";

/** The prefix this module's own diagnostics log under. */
const LOG_PREFIX = "pi-state-window";

/**
 * What a re-homed Σ says to the model. It has to say something: the window
 * removes turns the model produced, and a bare state blob with no account of
 * the missing history reads as a corrupted transcript. The version is named so
 * the agent's next `state_commit` has the CAS token in front of it — as the
 * payload's own raw bytes, so an arbitrary-precision one is quoted back exactly
 * as committed rather than through a JavaScript number.
 *
 * It opens on its own sentence because it is APPENDED to the preamble message
 * the request already carried: the model reads its operator prompt, then this.
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
 * N from configuration. Unset or empty: DEFAULT_TOOL_CYCLES — not configured is
 * not malformed. Otherwise the value must be a plain base-10 integer within
 * 0..MAX_TOOL_CYCLES; ANYTHING else — a negative, a huge number, `4oops`,
 * `abc`, a value with surrounding whitespace — returns null, which turns the
 * mode OFF. Neither clamping nor falling back to the default is acceptable
 * here: both let a malformed value run the mode at a depth nobody chose.
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
 * How the kill switch reads. THREE answers, not two, and the third is the whole of
 * the asymmetry `stateWindowSetting` is built on: `off` is an operator who turned the
 * mode off, `unrecognized` is a value this module does not accept. Both refuse — that
 * half is unchanged and deliberate — but only one of them is somebody's decision, and a
 * diagnostic that cannot tell them apart reports an operator's own kill switch as a fault.
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
	 * Whether this is a FAULT rather than a choice. A recognized negative kill switch is the
	 * operator's own configuration and false here; everything else — a kill switch this
	 * module cannot read, a mode that is not turned on, a cycle count that will not parse —
	 * is something nobody chose, and the harness refuses a run on it.
	 */
	fault: boolean;
	reason: string;
}

/** The longest raw value quoted back into a diagnostic. These carry a switch or a small integer. */
const MAX_QUOTED = 60;

function quoted(raw: string | undefined): string {
	if (raw === undefined) return "(unset)";
	return JSON.stringify(raw.length > MAX_QUOTED ? `${raw.slice(0, MAX_QUOTED)}…` : raw);
}

/**
 * The mode's configuration, or WHICH condition turned it off.
 *
 * `resolveStateWindow` below is derived from this one definition. A second function that
 * re-read the options to explain a null would be free to disagree with the one that
 * produced it — and "the diagnostic names a condition that is not the one that refused" is
 * a worse failure than the silence it replaced.
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

/**
 * The mode's configuration, or null when it is off — which is the default, the
 * kill-switched case, and EVERY malformed case.
 */
export function resolveStateWindow(options: StateWindowOptions): StateWindowConfig | null {
	const setting = stateWindowSetting(options);
	return "condition" in setting ? null : setting;
}

export function isStateCommitToolName(name: unknown): boolean {
	return typeof name === "string" && STATE_COMMIT_TOOL_NAMES.includes(name);
}

/** A tool result's payload as text, across the two content shapes openai-completions clients emit. */
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

/** One finalized `state_commit` result that pi reported SUCCESSFUL. */
export interface CachedStateCommit {
	/** The name it arrived under — one of STATE_COMMIT_TOOL_NAMES, kept for diagnosis. */
	toolName: string;
	/** pi's id for the call it answered: how the window locates Σ inside a request body. */
	toolCallId: string;
	/** The result's content as text, as pi held it BEFORE any dialect serialized it. */
	text: string;
}

/**
 * The newest successful `state_commit` result, or null — what the window reads
 * Σ out of.
 *
 * This replaces re-deriving success by parsing the result text, and the reason the text
 * could not answer it is worth keeping: a stale-version CAS refusal (see `src/backend`'s
 * `StaleStateVersionError`) is the designed, expected, retryable concurrency path of a
 * healthy backend under contention, not a fault — and the openai-completions
 * dialect builds its wire tool message as `{role, content, tool_call_id}` with
 * NO error flag, because the OpenAI Chat Completions format has none. A fetch
 * wrapper only ever sees that already serialized body, so a refusal reached it
 * as ordinary tool content and the only available selection was a positive
 * marker in the text — which a refusal quoting the agent's own patch back at
 * it could forge.
 *
 * `tool_result` fires earlier, where the flag still exists: pi's agent core
 * calls `afterToolCall` with the executed result's `isError` from
 * `finalizeExecutedToolCall`, BEFORE `createToolResultMessage` builds the
 * message the dialect later serializes. It fires for a tool registered through
 * `registerTool`, and a `tools/call` the server marked
 * `isError` arrives here as `isError: true` because callTool throws on it and
 * the core catches a throwing `execute` into exactly that.
 *
 * VOLATILE AND PER-PROCESS, which is the whole of what it claims: it is rebuilt
 * by the run itself and is never the authority for anything (the store is).
 *
 * A pi that RESUMES a session reloads its transcript but replays no tool
 * execution, so the live event stream alone would leave this EMPTY on a respawn
 * while the reloaded body still carried the old results — bounded and stateless,
 * which is the worst available outcome. seedStateCommitCache closes that at
 * `session_start`, and it needs no text predicate to do it: pi PERSISTS `isError`
 * on every `toolResult` entry and reloads it verbatim, so the flag is still the
 * only thing consulted (see that function for where each half was read).
 */
interface StateCommitCache {
	/** Record one `tool_result` event. Everything that is not a proven success is ignored. */
	observe(event: unknown): void;
	latest(): CachedStateCommit | null;
}

/**
 * What `observe` would store for one `tool_result` event, or null. Split out from
 * the cache so every refusal below is driven by a test against an event rather
 * than asserted in prose.
 *
 * EVERY gate fails closed, and `isError` is checked against the literal `false`
 * rather than for falsiness: an absent flag is a pi that no longer reports one,
 * which is precisely the condition under which this module must not claim a
 * success. The tool-name gate is STATE_COMMIT_TOOL_NAMES' exact-name set, so the
 * same-named `mcp__sproot-engram__state_commit` stays ineligible here exactly as
 * it is in the body.
 */
export function observeStateCommitResult(event: unknown): CachedStateCommit | null {
	if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
	const e = event as { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
	if (!isStateCommitToolName(e.toolName)) return null;
	if (e.isError !== false) return null;
	if (typeof e.toolCallId !== "string" || e.toolCallId === "") return null;
	// FROZEN: `text` is the bytes Σ is carved from. A holder that could edit it could
	// rewrite the agent's durable state after the fact.
	return Object.freeze({ toolName: e.toolName as string, toolCallId: e.toolCallId, text: toolResultText(e.content) });
}

export function newStateCommitCache(): StateCommitCache {
	let newest: CachedStateCommit | null = null;
	return Object.freeze({
		observe(event: unknown): void {
			const seen = observeStateCommitResult(event);
			// A result that is not a proven state_commit success leaves the previous Σ
			// standing: the newest SUCCESS is Σ, and a refusal after one must not
			// shadow it — the ordinary retry flow would otherwise cost the agent the
			// state it already has.
			if (seen !== null) newest = seen;
		},
		latest: () => newest,
	});
}

/**
 * The process's Σ and the session it belongs to, behind an accessor that always
 * resolves the CURRENT binding.
 *
 * TWO DEFECT CLASSES ARE CLOSED HERE BY SHAPE, both of which were first "fixed" at
 * each individual site and found again at the next one.
 *
 * ONE — a partial update. Σ is per-CONVERSATION, so "what is cached" and "whose it
 * is" are a single fact. Held as two variables, a path can update the cache and
 * forget the identity: the clear path did exactly that, and the damage surfaces
 * three steps later, when a session that committed after an unreadable replacement
 * has its OWN Σ wiped by its next unreadable reload. No predicate was wrong; an
 * assignment was missing, and every test that stopped at the clear was green. A
 * struct of mutable fields did not fix that — `bound.sigma = x` still type-checks
 * with no identity in sight, so the guarantee was a convention. `rebind` takes
 * BOTH and is the only way in, so the partial update is now a compile error.
 *
 * TWO — a captured binding. Three sites resolved the cache and could hold it across
 * a replacement: the `tool_result` handler, a fetch wrapper's Σ supplier, and
 * anything a caller built out of `stateCommitCache()`. Each was correct where it
 * stood and each would silently freeze on an orphaned cache the moment a seed
 * rebound — live commits landing in one cache while a reader served another. Fixing
 * them one at a time is what produced the third. Nothing now hands out the inner
 * cache: `observe` and `latest` belong to the façade and read the closed-over
 * variable at CALL time, so capturing the façade, or either method off it, stays
 * correct across every rebinding. There is no value a caller can hold that goes
 * stale.
 *
 * WHICH GUARANTEE IS WHICH, because "unwritable" was claimed once already and was
 * only a convention:
 *   - The partial update is a COMPILE ERROR. `bound.sigma = x` does not typecheck
 *     (no such property) and `rebind` takes both arguments or none.
 *   - The stale capture is structurally impossible at RUNTIME: every accessor
 *     dereferences the current binding when called.
 *   - Rebinding from OUTSIDE is impossible at RUNTIME: stateCommitCache() returns a
 *     FROZEN two-method view, not the binding. `rebind` and `sessionId` are not
 *     properties of it at all, and the view's own methods cannot be reassigned —
 *     an earlier version returned `bound` itself, where narrowing the TYPE left
 *     `stateCommitCache().observe = …` both compiling and working, which recreated
 *     the orphan-cache defect one layer out. A type narrowing is not a barrier.
 *
 * `observe` deliberately does not rebind: a live commit adds to the session already
 * identified here, it does not change which session that is.
 */
interface BoundStateCommitCache extends StateCommitCache {
	/** The session id the contents belong to, or null when never established. */
	sessionId(): string | null;
	/** Replace the contents AND the identity. There is no way to replace one. */
	rebind(sigma: StateCommitCache, sessionId: string | null): void;
}

function newBoundStateCommitCache(): BoundStateCommitCache {
	let sigma = newStateCommitCache();
	let sessionId: string | null = null;
	// FROZEN: the methods close over `sigma`, so reassigning one would substitute a
	// reader that never sees a rebinding — the same orphan the capture sites caused.
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

// `const`, and frozen. NOT EXTERNALLY REACHABLE and therefore NOT covered by a test:
// nothing outside this module can obtain `bound` (stateCommitCache() returns the view),
// so deleting its freeze fails nothing. It is kept as defence against a future edit
// INSIDE this file, and is named here as that rather than counted as a guarantee — an
// untestable freeze presented as one is the decoration this ticket kept finding.
const bound = newBoundStateCommitCache();

/**
 * What every caller outside this module gets: two methods, frozen, delegating to
 * the current binding. Not the binding — `rebind` and `sessionId` are absent from
 * it at runtime, so nothing outside can replace the contents or the identity, and
 * nothing can swap a method for one that reads a stale cache.
 */
const view: StateCommitCache = Object.freeze({
	observe: (event: unknown) => bound.observe(event),
	latest: () => bound.latest(),
});

/**
 * The process-wide cache. Safe to capture, and safe to pull a method off: both
 * resolve the current binding when called.
 */
export function stateCommitCache(): StateCommitCache {
	return view;
}

/** Drop what the process has cached. For tests, which must not leak Σ into each other. */
export function resetStateCommitCache(): void {
	bound.rebind(newStateCommitCache(), null);
}

/**
 * Seed a cache from a session's own entries — the transcript pi just reloaded.
 *
 * Pure over the entry list, and it introduces NO second predicate: a persisted
 * `toolResult` message carries `toolName`, `toolCallId`, `content` and `isError`
 * under exactly those names, which is the shape observeStateCommitResult already
 * reads, so each entry's message is handed to the same gate a live event goes
 * through. Replaying the branch in order therefore lands on exactly the Σ the
 * live run would have cached.
 *
 * Entries that are not messages, and messages that are not successful
 * state_commit results, are ignored by that gate rather than by a check here.
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
 * The entries of the session branch this context is on, or null when this pi
 * exposes no way to read them.
 *
 * `ExtensionContext.sessionManager` is a ReadonlySessionManager, and `getBranch()`
 * walks the parent chain from the current leaf over the IN-MEMORY index — so this
 * reads no file, and does not depend on whether pi has flushed the transcript yet.
 * The BRANCH, not `getEntries()`: a forked-away branch's commit is not this
 * conversation's Σ. Not `buildContextEntries()` either — that is the
 * compaction-aware view, and Σ surviving a compaction that dropped its cycle is
 * the point rather than an accident.
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
 * `getSessionId` is the CONVERSATION's identity, which is what Σ belongs to: pi
 * assigns a fresh one for a new session and for a fork, and takes it from the
 * opened file's header on a resume, so it differs across exactly the replacements
 * that must not share a Σ and holds across a reload of the same session. The file
 * path is not used instead — a session moved on disk is still the same
 * conversation, and this question is about the conversation.
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
 * WHY THIS IS SOUND WITHOUT PARSING ANYTHING. pi persists a finalized tool call as
 * `{type:"message", message:{role:"toolResult", toolCallId, toolName, content,
 * isError, …}}` — `_persist` writes `JSON.stringify(entry)` of the whole entry,
 * and the loader is a bare `JSON.parse` per line with no field filtering. So the
 * flag that only existed inside pi at execution time is still there after a reload.
 *
 * Called on EVERY `session_start` — which is re-entrant (`/new`, `/fork`,
 * `/resume`, reload) — because a session replacement swaps the transcript, and a Σ
 * cached from the session being replaced is not this one's. `SessionManager.open`
 * loads the entries before the runtime that emits `session_start` is built, so the
 * entries are there when this runs.
 *
 * WHEN THE BRANCH CANNOT BE READ, RETENTION IS TIED TO IDENTITY. Keeping what is
 * already cached is right for a session that was merely RELOADED and wrong for one
 * that was REPLACED — and those two arrive through the same event. Keeping
 * unconditionally would carry session A's Σ into session B and inject another
 * conversation's durable state into this one; clearing unconditionally would turn a
 * pi with no branch API into the statelessness this function exists to prevent. So
 * the cache is kept only while `getSessionId` SAYS this is the session the cache was
 * established for, and any answer short of that — a different id, an unreadable one,
 * or none recorded yet — clears. An unverifiable claim about identity is not a
 * licence to keep the contents.
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
	// The identity is recorded WITH the clear. It is the id of the session the cache
	// is now empty FOR, so a later reload of THIS session can prove itself unchanged
	// and keep whatever it commits in between. Dropping it would make that session's
	// own next reload unable to identify itself, and wipe its Σ.
	bound.rebind(newStateCommitCache(), id);
	log?.(
		`[${LOG_PREFIX}] this pi exposes no readable session branch and this session is not the one the cache was built for — cleared Σ rather than carry another session's into it`,
	);
}

/**
 * Register the cache on pi's `tool_result` event. The handler returns undefined
 * so pi's runner records the event as unmodified: this OBSERVES a tool result
 * and never rewrites one. pi catches and reports a handler that throws, but
 * observe is total over `unknown`, so there is nothing to throw.
 */
export function installStateCommitCache(pi: ToolResultAPI): void {
	pi.on("tool_result", (event) => {
		bound.observe(event);
	});
}

/**
 * The exact bytes of a TOP-LEVEL member's value in a JSON object text, or null
 * when the text is not an object or has no such member.
 *
 * This is a SCANNER, not a regex: it tracks string boundaries and backslash
 * escapes, so a `}` or a `"doc":` sitting inside a string value cannot end the
 * span early. Duplicate keys resolve to the LAST one, matching JSON.parse, so
 * the sliced bytes always belong to the value the predicate validated.
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
 * Σ carved out of a cached successful `state_commit` result, or null when the
 * payload is not one this module can carry.
 *
 * SUCCESS IS NOT DECIDED HERE — it was decided by pi, and this only runs on a
 * result pi already reported with `isError === false`. What is left is
 * extraction, and it fails closed: a payload whose `version` does not slice out
 * as a JSON number, or whose `doc` does not slice out as a JSON object, is a
 * contract drift with the `state_commit` result shape any caller must produce
 * (see `src/entrypoint/index.ts`'s `stateCommitTool`) rather than a Σ to
 * re-home, and re-homing the wrong bytes would replace the agent's memory with
 * them. The two checks are on the SLICED BYTES, so they need no parse of the
 * whole payload.
 *
 * What is returned for the prompt is the RAW BYTES of `doc` and `version`,
 * sliced out of the result text, never a reserialization. This repo's own
 * `agentstate` core preserves arbitrary-precision numbers (`JsonNumber`, mirroring
 * Go's `json.Number` in the mechanism's original implementation) and caps the
 * document's exact canonical bytes; a JavaScript round trip survives neither.
 * `JSON.parse` turns `9999999999999999` into `10000000000000000`, and a document
 * capped at exactly 4096 bytes came back 4097 — the agent's memory reaching the
 * model with DIFFERENT VALUES than were committed, and a cap measured on one
 * representation paid on another. `version` is the one place a number is also
 * produced, and it is for the transcript RECORD alone
 * (StateWindowEntryData.stateVersion); the `versionText` string is what the
 * prompt gets.
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
 * The entry appended for every rewrite. Custom entries participate in no LLM
 * context, so this record costs nothing in prompt — it is the feature's only
 * evidence that a turn was bounded, and what it dropped.
 */
export interface StateWindowEntryData {
	/** N as configured for this request. */
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
	 * How Σ reached the prompt. **Only `rehomed` is written today** — a boundary is
	 * written from the cache every time, so `stateboundary.ts` returns before there is
	 * anything to record when Σ is null, and there is no body position for `in-window`
	 * to name. The other three are kept because this is a CAPTURED FORMAT: existing
	 * transcripts already carry records with these values, from the retired fetch
	 * rewrite this union originally described, and tooling that reads those transcripts
	 * by this field still expects all four values to be valid.
	 *
	 *   in-window kept where it stood inside a surviving cycle (rewrite only).
	 *   absent    no `state_commit` result in that request at all — the ordinary
	 *             first steps of a run, before the agent has committed anything.
	 *   unproven  results arrived and NONE proved a commit. A refusal-only turn read
	 *             this way, and so did a result shape the module could no longer read —
	 *             where `absent` would have said, of the same body, that the agent
	 *             simply had not committed yet.
	 */
	state: "in-window" | "rehomed" | "absent" | "unproven";
	/** The version Σ proved it committed. Absent on both no-Σ states above. */
	stateVersion?: number;
}

/**
 * The running tally stamped on EVERY entry this module appends, success or
 * refusal.
 *
 * A refusal is otherwise only a trace seed row that nothing counts, so a
 * serializer drift that made the module refuse every turn would look exactly
 * like a healthy quiet run: the prompt would grow as it does today and nothing
 * would say so. Carrying the counts on the record that is already being written
 * makes "47 requests, 47 refusals" readable from a single entry, at no prompt
 * cost and with no new surface.
 *
 * The counters are per-WRAPPER and per-process: derived, discardable, and never
 * the authority for anything. A restart restarts them, which is why each entry
 * carries the totals rather than a delta.
 */
export interface StateWindowTally {
	/** Completions POSTs this mode owned since the wrapper was installed. */
	requests: number;
	rewrites: number;
	refusals: number;
}

type StateWindowEntry = StateWindowEntryData & StateWindowTally;

/**
 * The marker appended INSTEAD of a record when the mode was ON and the window
 * could not be produced. Without it, "asked and failed" is indistinguishable
 * from "nobody asked" everywhere downstream. The body forwarded alongside it is
 * the ORIGINAL, byte for byte.
 */
export type StateWindowFailure = { failed: true; reason: string } & StateWindowTally;

/** Σ, ready for the prompt: the raw bytes, plus how to recognize the result that carried them. */
export interface Sigma {
	toolCallId: string;
	/** The cached result's exact text — the bytes `doc` and `version` were carved from. */
	text: string;
	/** For the transcript record only — the prompt gets versionText. */
	version: number;
	versionText: string;
	doc: string;
}

/**
 * Persist one rewrite's record — or the marker saying the window could not be
 * produced — into the transcript, under STATE_WINDOW_ENTRY_TYPE. A pi whose API predates
 * appendEntry, or whose appendEntry throws, loses only the record: the request and the
 * turn are untouched either way.
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
