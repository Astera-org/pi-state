import type { StateWindowOptions } from "../stateboundary/index.js";
/** The state loop's on/off switch. Kill-switch semantics (see `stateWindowSetting`):
 * unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it ON, a recognized
 * negative (`0`/`false`/`no`/`off`) turns it OFF as an operator choice, and anything else
 * is an unrecognized value that also refuses — fail closed rather than run at an
 * unchosen setting. Defaults to ON (rather than requiring explicit opt-in) so that
 * installing this extension with no configuration at all already bounds the prompt —
 * the ticket's acceptance bar has no env vars to set. */
export declare const ENV_STATE_LOOP = "PI_STATE_LOOP";
/** N, the number of trailing tool cycles kept alongside Σ. Unset means
 * `DEFAULT_TOOL_CYCLES`; see `parseToolCycles` for the parsing contract. */
export declare const ENV_STATE_WINDOW_CYCLES = "PI_STATE_WINDOW_CYCLES";
/** A manual stopgap for a schema's `autoMaxStateBytes` (see `../agentstate/schema.ts`):
 * the active model's context window, in tokens, for an operator to set by hand on a
 * `pi` this extension cannot otherwise learn it from. See `autocap.ts` for how this is
 * combined with what `pi` itself reports at `session_start`/`model_select` — a live
 * report always supersedes this once one arrives, since this is a manually-maintained
 * number and can go stale the moment an operator switches models. Unset or unparsable
 * (not a positive number) means "no override from here". */
export declare const ENV_STATE_CONTEXT_WINDOW_TOKENS = "PI_STATE_CONTEXT_WINDOW_TOKENS";
export declare function stateWindowOptionsFromEnv(env?: NodeJS.ProcessEnv): StateWindowOptions;
//# sourceMappingURL=env.d.ts.map