// Resolves a schema's auto sizing (see `../agentstate/schema.ts`'s `maxStateBytes` and
// `autoMaxStateBytesPercent`) into a concrete `maxStateBytes` from the active model's
// context window. Applies to every schema that declares no explicit `maxStateBytes`.
//
// The context window comes from, in priority order:
//   1. `pi`'s report of the active model (`ExtensionContext.model` on `session_start`,
//      `ModelSelectEvent.model` on `model_select`; `Model.contextWindow` is a number).
//   2. `ENV_STATE_CONTEXT_WINDOW_TOKENS` (`env.ts`), used at install time (no session,
//      hence no model yet) or when `pi` reports no model.

import {
	DEFAULT_AUTO_MAX_STATE_BYTES_CEILING,
	DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT,
	resolveAutoMaxStateBytes,
	type Schema,
} from "../agentstate/index.js";
import { ENV_STATE_CONTEXT_WINDOW_TOKENS } from "./env.js";

/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`, floored to an integer. Returns undefined
 * when it is unset or not a positive finite number. */
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
 * Reads value.model.contextWindow from a session_start context or model_select event.
 * Returns undefined unless it is a positive finite number. Types are structural;
 * this package has no pi dependency.
 */
export function contextWindowFromModelHolder(value: unknown): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const model = (value as { model?: unknown }).model;
	if (model === null || typeof model !== "object") return undefined;
	const contextWindow = (model as { contextWindow?: unknown }).contextWindow;
	return isPositiveFiniteNumber(contextWindow) ? contextWindow : undefined;
}

/**
 * Sets schema.maxStateBytes in place; existing tool closures read the updated cap.
 * No-op for a positive declaredMaxStateBytes or undefined contextWindowTokens.
 * declaredMaxStateBytes must be captured at load time, before this function overwrites
 * schema.maxStateBytes. Repeated calls log only when the resolved cap changes.
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
	const sized = resolveAutoMaxStateBytes(percent, contextWindowTokens);
	const bytes =
		schema.autoMaxStateBytesPercent === undefined ? Math.min(sized, DEFAULT_AUTO_MAX_STATE_BYTES_CEILING) : sized;
	if (schema.maxStateBytes === bytes) return;
	schema.maxStateBytes = bytes;
	log(
		`[pi-state] auto-sized maxStateBytes to ${bytes} bytes (${percent}% of a ${contextWindowTokens}-token context window)`,
	);
}
