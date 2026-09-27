import { type Schema } from "../agentstate/index.js";
/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`. Unset or not a positive number both mean "no
 * override from here" — this is a best-effort stopgap, not a validated operator setting
 * with kill-switch semantics, so it fails open (silently unresolved) rather than closed. */
export declare function contextWindowTokensFromEnv(env: NodeJS.ProcessEnv): number | undefined;
/**
 * The context window this `pi`'s active model reports, read off a `session_start`
 * event's `ExtensionContext` (its `.model`) or a `model_select` event (its `.model`
 * directly) — both structurally `{ model?: { contextWindow?: unknown } }`, which is all
 * of `ExtensionContext`/`ModelSelectEvent` this needs. Declared as `unknown` and read
 * defensively, like every other pi-shaped value this repo takes in (see
 * `stateboundary/statewindow.ts`'s `sessionManagerOf`): this file has no `pi` package
 * dependency to import the real types from.
 */
export declare function contextWindowFromModelHolder(value: unknown): number | undefined;
/**
 * Resolves `schema`'s auto sizing against `contextWindowTokens` and substitutes the
 * result into `schema.maxStateBytes` in place — mutated rather than replaced, so a
 * `Schema` object already captured by a tool's `execute` closure (see
 * `entrypoint/index.ts`'s `stateGetTool`/`stateCommitTool`) sees the update on its next
 * call, before merge or cap enforcement (`agentstate/merge.ts`) ever reads it.
 *
 * No-ops whenever: `declaredMaxStateBytes` (the schema FILE's own `maxStateBytes`,
 * captured once at load time — NOT `schema.maxStateBytes`, which this function itself
 * may have already overwritten on an earlier, less-informed call) is a positive number
 * — an explicit cap always wins over auto sizing, full stop, no matter what
 * `contextWindowTokens` says; or `contextWindowTokens` is unresolved — nothing to
 * compute from yet, so `schemaCap` keeps answering `DEFAULT_MAX_STATE_BYTES` (the
 * last-resort fallback, for when this genuinely never gets called with a resolvable
 * context window) until a later call supplies one.
 *
 * There is no "auto is off" case: a schema with no explicit `maxStateBytes` is auto
 * sizing's default target, not something that opted in.
 *
 * Safe to call repeatedly as better information arrives (env-var stopgap at install
 * time, then a live `contextWindow` at `session_start`, again at `model_select`): it
 * recomputes and only logs when the resolved byte count actually changes.
 */
export declare function applyAutoMaxStateBytes(schema: Schema, declaredMaxStateBytes: number | undefined, contextWindowTokens: number | undefined, log: (message: string) => void): void;
//# sourceMappingURL=autocap.d.ts.map