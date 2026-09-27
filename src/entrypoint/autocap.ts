// Resolves a schema's auto sizing (see `../agentstate/schema.ts`'s `maxStateBytes` and
// `autoMaxStateBytesPercent`) into a concrete `maxStateBytes`, using whatever this
// entrypoint can learn about the active model's context window. Auto sizing is the
// DEFAULT for a schema that declares no `maxStateBytes` — not an opt-in — so this runs
// unconditionally whenever a schema has no explicit cap. `agentstate` itself cannot do
// this — it is pure logic with no I/O and no notion of "the current model" — so this is
// the one place in this repo that is allowed to know about `pi`'s model/session surface.
//
// Two sources, in priority order:
//   1. `pi` itself, when it reports the active model's `contextWindow` — a `session_start`
//      or `model_select` event's `ExtensionContext`/`Model` (both hold `contextWindow` in
//      this repo's own local structural types below, kept dependency-free the same way
//      `entrypoint/index.ts`'s `PiExtensionAPI` is). This is live and authoritative
//      whenever it is available.
//   2. `ENV_STATE_CONTEXT_WINDOW_TOKENS` (`env.ts`), an operator-set stopgap for install
//      time (before any session has started, so there is no live model yet) or for a
//      `pi` that, for whatever reason, does not populate `model` when this runs.
//
// `pi`'s own extension API (packages/coding-agent/src/core/extensions/types.ts in the
// pi monorepo) DOES expose `contextWindow` to extensions — `ExtensionContext.model` and
// `ModelSelectEvent.model` both carry it (`Model.contextWindow: number`, required) — so
// source 1 above is a real, live-checked API surface, not a guess.

import { DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT, resolveAutoMaxStateBytes, type Schema } from "../agentstate/index.js";
import { ENV_STATE_CONTEXT_WINDOW_TOKENS } from "./env.js";

/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`. Unset or not a positive number both mean "no
 * override from here" — this is a best-effort stopgap, not a validated operator setting
 * with kill-switch semantics, so it fails open (silently unresolved) rather than closed. */
export function contextWindowTokensFromEnv(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env[ENV_STATE_CONTEXT_WINDOW_TOKENS];
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function isPositiveFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * The context window this `pi`'s active model reports, read off a `session_start`
 * event's `ExtensionContext` (its `.model`) or a `model_select` event (its `.model`
 * directly) — both structurally `{ model?: { contextWindow?: unknown } }`, which is all
 * of `ExtensionContext`/`ModelSelectEvent` this needs. Declared as `unknown` and read
 * defensively, like every other pi-shaped value this repo takes in (see
 * `stateboundary/statewindow.ts`'s `sessionManagerOf`): this file has no `pi` package
 * dependency to import the real types from.
 */
export function contextWindowFromModelHolder(value: unknown): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const model = (value as { model?: unknown }).model;
	if (model === null || typeof model !== "object") return undefined;
	const contextWindow = (model as { contextWindow?: unknown }).contextWindow;
	return isPositiveFiniteNumber(contextWindow) ? contextWindow : undefined;
}

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
export function applyAutoMaxStateBytes(
	schema: Schema,
	declaredMaxStateBytes: number | undefined,
	contextWindowTokens: number | undefined,
	log: (message: string) => void,
): void {
	if ((declaredMaxStateBytes ?? 0) > 0) return;
	if (contextWindowTokens === undefined) return;
	const percent = schema.autoMaxStateBytesPercent ?? DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT;
	const bytes = resolveAutoMaxStateBytes(percent, contextWindowTokens);
	if (schema.maxStateBytes === bytes) return;
	schema.maxStateBytes = bytes;
	log(
		`[pi-state] auto-sized maxStateBytes to ${bytes} bytes (${percent}% of a ${contextWindowTokens}-token context window)`,
	);
}
