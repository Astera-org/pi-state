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
export const STATE_COMMIT_TOOL_NAMES = ["state_commit", "mcp__sproot__state_commit"];
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
export function stateWindowPreamble(version) {
    return (`Your durable working state, as you last committed it with state_commit (version ${version}). ` +
        "Earlier turns of this run are not in this prompt; what follows is what survives of them.\n\n");
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
export function parseToolCycles(raw) {
    if (raw === undefined || raw === "")
        return DEFAULT_TOOL_CYCLES;
    if (!CYCLES_PATTERN.test(raw))
        return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n > MAX_TOOL_CYCLES)
        return null;
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
function killSwitch(raw) {
    if (raw === undefined)
        return "allow";
    const value = raw.trim().toLowerCase();
    if (value === "" || KILL_SWITCH_AFFIRMATIVES.has(value))
        return "allow";
    return KILL_SWITCH_NEGATIVES.has(value) ? "off" : "unrecognized";
}
/** The longest raw value quoted back into a diagnostic. These carry a switch or a small integer. */
const MAX_QUOTED = 60;
function quoted(raw) {
    if (raw === undefined)
        return "(unset)";
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
export function stateWindowSetting(options) {
    const kill = killSwitch(options.killSwitch);
    if (kill !== "allow") {
        return {
            condition: "kill-switch",
            fault: kill === "unrecognized",
            reason: kill === "off"
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
export function resolveStateWindow(options) {
    const setting = stateWindowSetting(options);
    return "condition" in setting ? null : setting;
}
export function isStateCommitToolName(name) {
    return typeof name === "string" && STATE_COMMIT_TOOL_NAMES.includes(name);
}
/** A tool result's payload as text, across the two content shapes openai-completions clients emit. */
export function toolResultText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part !== null && typeof part === "object" && typeof part.text === "string") {
                return part.text;
            }
            return JSON.stringify(part) ?? "";
        })
            .join("\n");
    }
    if (content === null || content === undefined)
        return "";
    return JSON.stringify(content) ?? "";
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
export function observeStateCommitResult(event) {
    if (event === null || typeof event !== "object" || Array.isArray(event))
        return null;
    const e = event;
    if (!isStateCommitToolName(e.toolName))
        return null;
    if (e.isError !== false)
        return null;
    if (typeof e.toolCallId !== "string" || e.toolCallId === "")
        return null;
    // FROZEN: `text` is the bytes Σ is carved from. A holder that could edit it could
    // rewrite the agent's durable state after the fact.
    return Object.freeze({ toolName: e.toolName, toolCallId: e.toolCallId, text: toolResultText(e.content) });
}
export function newStateCommitCache() {
    let newest = null;
    return Object.freeze({
        observe(event) {
            const seen = observeStateCommitResult(event);
            // A result that is not a proven state_commit success leaves the previous Σ
            // standing: the newest SUCCESS is Σ, and a refusal after one must not
            // shadow it — the ordinary retry flow would otherwise cost the agent the
            // state it already has.
            if (seen !== null)
                newest = seen;
        },
        latest: () => newest,
    });
}
function newBoundStateCommitCache() {
    let sigma = newStateCommitCache();
    let sessionId = null;
    // FROZEN: the methods close over `sigma`, so reassigning one would substitute a
    // reader that never sees a rebinding — the same orphan the capture sites caused.
    return Object.freeze({
        observe: (event) => sigma.observe(event),
        latest: () => sigma.latest(),
        sessionId: () => sessionId,
        rebind: (next, id) => {
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
const view = Object.freeze({
    observe: (event) => bound.observe(event),
    latest: () => bound.latest(),
});
/**
 * The process-wide cache. Safe to capture, and safe to pull a method off: both
 * resolve the current binding when called.
 */
export function stateCommitCache() {
    return view;
}
/** Drop what the process has cached. For tests, which must not leak Σ into each other. */
export function resetStateCommitCache() {
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
export function seedStateCommitCacheFromEntries(cache, entries) {
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object")
            continue;
        cache.observe(entry.message);
    }
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
function sessionBranchEntries(ctx) {
    const manager = sessionManagerOf(ctx);
    if (manager === null || typeof manager.getBranch !== "function")
        return null;
    let entries;
    try {
        entries = manager.getBranch();
    }
    catch {
        return null;
    }
    return Array.isArray(entries) ? entries : null;
}
function sessionManagerOf(ctx) {
    if (ctx === null || typeof ctx !== "object")
        return null;
    const manager = ctx.sessionManager;
    if (manager === null || typeof manager !== "object")
        return null;
    return manager;
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
function sessionIdentity(ctx) {
    const manager = sessionManagerOf(ctx);
    if (manager === null || typeof manager.getSessionId !== "function")
        return null;
    let id;
    try {
        id = manager.getSessionId();
    }
    catch {
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
export function seedStateCommitCache(ctx, log) {
    const id = sessionIdentity(ctx);
    const entries = sessionBranchEntries(ctx);
    if (entries !== null) {
        const sigma = newStateCommitCache();
        seedStateCommitCacheFromEntries(sigma, entries);
        bound.rebind(sigma, id);
        return;
    }
    if (id !== null && id === bound.sessionId()) {
        log?.(`[${LOG_PREFIX}] this pi exposes no readable session branch, but this is still session ${id} — kept the Σ already cached`);
        return;
    }
    // The identity is recorded WITH the clear. It is the id of the session the cache
    // is now empty FOR, so a later reload of THIS session can prove itself unchanged
    // and keep whatever it commits in between. Dropping it would make that session's
    // own next reload unable to identify itself, and wipe its Σ.
    bound.rebind(newStateCommitCache(), id);
    log?.(`[${LOG_PREFIX}] this pi exposes no readable session branch and this session is not the one the cache was built for — cleared Σ rather than carry another session's into it`);
}
/**
 * Register the cache on pi's `tool_result` event. The handler returns undefined
 * so pi's runner records the event as unmodified: this OBSERVES a tool result
 * and never rewrites one. pi catches and reports a handler that throws, but
 * observe is total over `unknown`, so there is nothing to throw.
 */
export function installStateCommitCache(pi) {
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
export function rawJsonMember(text, key) {
    let i = skipWhitespace(text, 0);
    if (text[i] !== "{")
        return null;
    i++;
    let found = null;
    for (;;) {
        i = skipWhitespace(text, i);
        if (text[i] === "}")
            return found;
        if (text[i] !== '"')
            return null;
        const keyEnd = scanString(text, i);
        if (keyEnd < 0)
            return null;
        let name;
        try {
            name = JSON.parse(text.slice(i, keyEnd));
        }
        catch {
            return null;
        }
        i = skipWhitespace(text, keyEnd);
        if (text[i] !== ":")
            return null;
        const valueStart = skipWhitespace(text, i + 1);
        const valueEnd = scanValue(text, valueStart);
        if (valueEnd < 0)
            return null;
        if (name === key)
            found = text.slice(valueStart, valueEnd);
        i = skipWhitespace(text, valueEnd);
        if (text[i] === ",") {
            i++;
            continue;
        }
        if (text[i] === "}")
            return found;
        return null;
    }
}
function skipWhitespace(text, i) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r"))
        i++;
    return i;
}
/** Index just past the string starting at `i`, or -1. */
function scanString(text, i) {
    if (text[i] !== '"')
        return -1;
    i++;
    while (i < text.length) {
        if (text[i] === "\\") {
            i += 2;
            continue;
        }
        if (text[i] === '"')
            return i + 1;
        i++;
    }
    return -1;
}
/** Index just past the JSON value starting at `i`, or -1. */
function scanValue(text, i) {
    const c = text[i];
    if (c === '"')
        return scanString(text, i);
    if (c === "{" || c === "[") {
        const open = c;
        const close = c === "{" ? "}" : "]";
        let depth = 0;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') {
                const end = scanString(text, i);
                if (end < 0)
                    return -1;
                i = end;
                continue;
            }
            if (ch === open)
                depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0)
                    return i + 1;
            }
            i++;
        }
        return -1;
    }
    // number / true / false / null: runs to the next structural delimiter.
    const start = i;
    while (i < text.length && !",}] \t\n\r".includes(text[i]))
        i++;
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
export function sigmaFromResult(cached) {
    if (cached === null)
        return null;
    const doc = rawJsonMember(cached.text, STATE_COMMIT_DOC_KEY);
    if (doc === null || doc[0] !== "{")
        return null;
    const versionText = rawJsonMember(cached.text, STATE_COMMIT_VERSION_KEY);
    if (versionText === null || !JSON_NUMBER.test(versionText))
        return null;
    return { toolCallId: cached.toolCallId, text: cached.text, version: Number(versionText), versionText, doc };
}
/**
 * Persist one rewrite's record — or the marker saying the window could not be
 * produced — into the transcript, under STATE_WINDOW_ENTRY_TYPE. A pi whose API predates
 * appendEntry, or whose appendEntry throws, loses only the record: the request and the
 * turn are untouched either way.
 */
export function recordStateWindowIntoTranscript(pi, data, log) {
    if (typeof pi.appendEntry !== "function") {
        log?.(`[${LOG_PREFIX}] pi.appendEntry is unavailable — the rewrite was not recorded`);
        return;
    }
    try {
        pi.appendEntry(STATE_WINDOW_ENTRY_TYPE, data);
    }
    catch (err) {
        log?.(`[${LOG_PREFIX}] appendEntry failed — the rewrite was not recorded: ${describe(err)}`);
    }
}
function describe(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=statewindow.js.map