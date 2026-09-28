import { type Schema } from "../agentstate/index.js";
/** Reads `ENV_STATE_CONTEXT_WINDOW_TOKENS`, floored to an integer. Returns undefined
 * when it is unset or not a positive finite number. */
export declare function contextWindowTokensFromEnv(env: NodeJS.ProcessEnv): number | undefined;
/**
 * Reads value.model.contextWindow from a session_start context or model_select event.
 * Returns undefined unless it is a positive finite number. Types are structural;
 * this package has no pi dependency.
 */
export declare function contextWindowFromModelHolder(value: unknown): number | undefined;
/**
 * Sets schema.maxStateBytes in place; existing tool closures read the updated cap.
 * No-op for a positive declaredMaxStateBytes or undefined contextWindowTokens.
 * declaredMaxStateBytes must be captured at load time, before this function overwrites
 * schema.maxStateBytes. Repeated calls log only when the resolved cap changes.
 */
export declare function applyAutoMaxStateBytes(schema: Schema, declaredMaxStateBytes: number | undefined, contextWindowTokens: number | undefined, log: (message: string) => void): void;
//# sourceMappingURL=autocap.d.ts.map