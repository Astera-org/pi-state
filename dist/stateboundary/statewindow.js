/**
 * State-loop configuration, successful-commit caching, exact doc/version extraction,
 * preamble generation, and transcript records. stateboundary.ts delivers the result.
 * Malformed configuration disables the mode. Success requires pi's isError=false.
 * `sproot-state-window` is a persisted record type used by transcript readers.
 */
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
export const STATE_COMMIT_TOOL_NAMES = ["state_commit", "mcp__sproot__state_commit"];
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
export function stateWindowPreamble(version) {
    return (`Your durable working state, as you last committed it with state_commit (version ${version}). ` +
        "Earlier turns of this run are not in this prompt; what follows is what survives of them.\n\n");
}
const CYCLES_PATTERN = /^[0-9]+$/;
/**
 * Parses a base-10 integer in 0..MAX_TOOL_CYCLES. Unset or empty uses
 * DEFAULT_TOOL_CYCLES. Invalid values, including surrounding whitespace, return null
 * and disable the mode; values are never clamped.
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
 * How the kill switch reads: `allow` (unset, empty or an affirmative), `off` (a recognized
 * negative, the operator's decision) or `unrecognized` (any other value). `off` and
 * `unrecognized` both refuse; only `unrecognized` is a fault.
 */
function killSwitch(raw) {
    if (raw === undefined)
        return "allow";
    const value = raw.trim().toLowerCase();
    if (value === "" || KILL_SWITCH_AFFIRMATIVES.has(value))
        return "allow";
    return KILL_SWITCH_NEGATIVES.has(value) ? "off" : "unrecognized";
}
/** The longest raw value quoted into a diagnostic. */
const MAX_QUOTED = 60;
export function quoted(raw) {
    if (raw === undefined)
        return "(unset)";
    return JSON.stringify(raw.length > MAX_QUOTED ? `${raw.slice(0, MAX_QUOTED)}…` : raw);
}
/**
 * The mode's configuration, or the condition that turned it off. `resolveStateWindow` is
 * derived from this function.
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
/** The mode's configuration, or null when it is off (the default, kill-switched, or malformed). */
export function resolveStateWindow(options) {
    const setting = stateWindowSetting(options);
    return "condition" in setting ? null : setting;
}
export function isStateCommitToolName(name) {
    return typeof name === "string" && STATE_COMMIT_TOOL_NAMES.includes(name);
}
const STATE_GET_TOOL_NAMES = ["state_get", "mcp__sproot__state_get"];
export function isStateGetToolName(name) {
    return typeof name === "string" && STATE_GET_TOOL_NAMES.includes(name);
}
/** A tool result's payload as text, from a string, an array of parts, or any other JSON value. */
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
 * Returns a successful commit result or null. Requires an exact accepted tool name,
 * literal isError=false, and a non-empty call id. Missing flags refuse.
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
    // Frozen: `text` is the bytes Σ is extracted from.
    return Object.freeze({ toolName: e.toolName, toolCallId: e.toolCallId, text: toolResultText(e.content) });
}
export function newStateCommitCache() {
    let newest = null;
    return Object.freeze({
        observe(event) {
            const seen = observeStateCommitResult(event);
            // A result that is not a proven state_commit success leaves the previous Σ standing: the
            // newest success is Σ, and a later refusal must not shadow it.
            if (seen !== null)
                newest = seen;
        },
        latest: () => newest,
    });
}
function newBoundStateCommitCache() {
    let sigma = newStateCommitCache();
    let sessionId = null;
    // Freeze methods to preserve their reads of the current binding.
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
// Internal frozen binding; callers receive the frozen view below.
const bound = newBoundStateCommitCache();
/**
 * The view every caller outside this module gets: two frozen methods delegating to the
 * current binding. `rebind` and `sessionId` are absent at runtime.
 */
const view = Object.freeze({
    observe: (event) => bound.observe(event),
    latest: () => bound.latest(),
});
/** The process-wide cache. Safe to capture, including its methods: both resolve the current binding when called. */
export function stateCommitCache() {
    return view;
}
/** Drop what the process has cached. For tests. */
export function resetStateCommitCache() {
    bound.rebind(newStateCommitCache(), null);
}
/**
 * Replays entry messages through the live-result gate in branch order. Persisted
 * toolResult messages use the same toolName, toolCallId, content, and isError fields.
 * Malformed entries and unsuccessful results are ignored.
 */
export function seedStateCommitCacheFromEntries(cache, entries) {
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object")
            continue;
        cache.observe(entry.message);
    }
}
/**
 * Current branch entries, or null when unavailable. getBranch walks the in-memory
 * parent chain without file I/O or transcript flushing. It excludes other branches
 * and retains commits removed from context by compaction.
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
 * Session id, or null when unavailable. pi assigns a new id on /new and /fork and
 * restores it from the file header on resume. Moving the file preserves identity.
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
 * Restores the cache on every session_start (/new, /fork, /resume, reload).
 * SessionManager.open loads entries before session_start. Persisted entries have shape
 * `{type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError}}`;
 * isError survives JSON serialization and reload.
 *
 * A readable branch replaces the cache. With an unreadable branch, only a matching
 * non-null session id retains it; a different, unreadable, or unrecorded id clears it.
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
    // Record the cleared session's identity so later reloads retain its new commits.
    bound.rebind(newStateCommitCache(), id);
    log?.(`[${LOG_PREFIX}] this pi exposes no readable session branch and this session is not the one the cache was built for — cleared Σ rather than carry another session's into it`);
}
/**
 * Register the cache on pi's `tool_result` event. The handler returns undefined, leaving the
 * event unmodified. `observe` is total over `unknown` and does not throw.
 */
export function installStateCommitCache(pi) {
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
 * Extracts Σ from a successful cached result. Returns null unless version is a JSON
 * number and doc starts with an object. Checks use sliced bytes without parsing the payload.
 *
 * The prompt receives exact doc/version bytes. JSON.parse rounds 9999999999999999 to
 * 10000000000000000; reserialization can exceed the measured canonical byte cap.
 * Numeric version is for StateWindowEntryData only; the prompt uses versionText.
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
 * Persist one boundary record, or the failure marker, into the transcript under
 * STATE_WINDOW_ENTRY_TYPE. If `appendEntry` is missing or throws, only the record is lost.
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