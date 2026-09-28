// Resolves a schema's auto sizing (see `../agentstate/schema.ts`'s `maxStateBytes` and
// `autoMaxStateBytesPercent`) into a concrete `maxStateBytes` from the active model's
// context window. Applies to every schema that declares no explicit `maxStateBytes`.
//
// The context window comes from, in priority order:
//   1. `pi`'s report of the active model (`ExtensionContext.model` on `session_start`,
//      `ModelSelectEvent.model` on `model_select`; `Model.contextWindow` is a number).
//   2. `ENV_STATE_CONTEXT_WINDOW_TOKENS` (`env.ts`), used at install time (no session,
//      hence no model yet) or when `pi` reports no model.
import { DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT, resolveAutoMaxStateBytes } from "../agentstate/index.js";
import { ENV_STATE_CONTEXT_WINDOW_TOKENS } from "./env.js";
/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`, floored to an integer. Returns undefined
 * when it is unset or not a positive finite number. */
export function contextWindowTokensFromEnv(env) {
    const raw = env[ENV_STATE_CONTEXT_WINDOW_TOKENS];
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
function isPositiveFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}
/**
 * The active model's context window, read from `value.model.contextWindow` — the shape of
 * both a `session_start` `ExtensionContext` and a `model_select` event. `value` is typed
 * `unknown` and read defensively because this package has no `pi` dependency. Returns
 * undefined unless the value is a positive finite number.
 */
export function contextWindowFromModelHolder(value) {
    if (value === null || typeof value !== "object")
        return undefined;
    const model = value.model;
    if (model === null || typeof model !== "object")
        return undefined;
    const contextWindow = model.contextWindow;
    return isPositiveFiniteNumber(contextWindow) ? contextWindow : undefined;
}
/**
 * Resolves `schema`'s auto sizing against `contextWindowTokens` and sets
 * `schema.maxStateBytes` in place, so a `Schema` already captured by the tools'
 * `execute` closures sees the new cap on its next call.
 *
 * No-op when `declaredMaxStateBytes` is positive, or when `contextWindowTokens` is
 * undefined (`schemaCap` then returns `DEFAULT_MAX_STATE_BYTES`).
 * `declaredMaxStateBytes` is the schema file's own `maxStateBytes`, captured at load
 * time; it must not be read from `schema.maxStateBytes`, which this function overwrites.
 *
 * Idempotent and safe to call repeatedly (install, `session_start`, `model_select`); it
 * logs only when the resolved byte count changes.
 */
export function applyAutoMaxStateBytes(schema, declaredMaxStateBytes, contextWindowTokens, log) {
    if ((declaredMaxStateBytes ?? 0) > 0)
        return;
    if (contextWindowTokens === undefined)
        return;
    const percent = schema.autoMaxStateBytesPercent ?? DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT;
    const bytes = resolveAutoMaxStateBytes(percent, contextWindowTokens);
    if (schema.maxStateBytes === bytes)
        return;
    schema.maxStateBytes = bytes;
    log(`[pi-state] auto-sized maxStateBytes to ${bytes} bytes (${percent}% of a ${contextWindowTokens}-token context window)`);
}
//# sourceMappingURL=autocap.js.map