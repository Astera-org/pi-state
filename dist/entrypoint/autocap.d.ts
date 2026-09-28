import { type Schema } from "../agentstate/index.js";
/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`, floored to an integer. Returns undefined
 * when it is unset or not a positive finite number. */
export declare function contextWindowTokensFromEnv(env: NodeJS.ProcessEnv): number | undefined;
/**
 * The active model's context window, read from `value.model.contextWindow` — the shape of
 * both a `session_start` `ExtensionContext` and a `model_select` event. `value` is typed
 * `unknown` and read defensively because this package has no `pi` dependency. Returns
 * undefined unless the value is a positive finite number.
 */
export declare function contextWindowFromModelHolder(value: unknown): number | undefined;
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
export declare function applyAutoMaxStateBytes(schema: Schema, declaredMaxStateBytes: number | undefined, contextWindowTokens: number | undefined, log: (message: string) => void): void;
//# sourceMappingURL=autocap.d.ts.map