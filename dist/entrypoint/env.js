// Maps this package's environment variables onto `StateWindowOptions`
// (src/stateboundary/statewindow.ts), the object that module's fail-closed parsing runs
// on. A single flag, `PI_STATE_LOOP`, serves as both mode and kill switch.
/** The state loop's on/off switch. Kill-switch semantics (see `stateWindowSetting`):
 * unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it ON, a recognized
 * negative (`0`/`false`/`no`/`off`) turns it OFF as an operator choice, and anything else
 * is an unrecognized value that also refuses (fail closed). Defaults to ON, so no
 * environment variable is required. */
export const ENV_STATE_LOOP = "PI_STATE_LOOP";
/** N, the number of trailing tool cycles kept alongside Σ. Unset means
 * `DEFAULT_TOOL_CYCLES`; see `parseToolCycles` for the parsing contract. */
export const ENV_STATE_WINDOW_CYCLES = "PI_STATE_WINDOW_CYCLES";
/** The active model's context window, in tokens, for auto sizing a schema with no
 * `maxStateBytes` (see `../agentstate/schema.ts`). Used when `pi` has not reported a
 * model; a model reported at `session_start`/`model_select` takes precedence (see
 * `autocap.ts`). Unset or not a positive number means no value. */
export const ENV_STATE_CONTEXT_WINDOW_TOKENS = "PI_STATE_CONTEXT_WINDOW_TOKENS";
export function stateWindowOptionsFromEnv(env = process.env) {
    return {
        enabled: true,
        killSwitch: env[ENV_STATE_LOOP],
        cycles: env[ENV_STATE_WINDOW_CYCLES],
    };
}
//# sourceMappingURL=env.js.map