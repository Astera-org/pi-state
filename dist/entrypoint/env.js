// Maps this package's environment variables onto `StateWindowOptions`
// (src/stateboundary/statewindow.ts), the object that module's fail-closed parsing runs
// on. `PI_STATE_LOOP` is the kill switch; `PI_STATE_MODE` selects `boundary` or `paper`;
// `PI_STATE_REQUIRE_COMMIT` sets paper mode's commit enforcement.
/**
 * State-loop kill switch. Unset, empty, or affirmative (1/true/yes/on) allows the mode.
 * Negative (0/false/no/off) disables it. Unrecognized values refuse installation.
 */
export const ENV_STATE_LOOP = "PI_STATE_LOOP";
/** N, the number of trailing tool cycles kept alongside Σ. Unset means
 * `DEFAULT_TOOL_CYCLES`; see `parseToolCycles` for the parsing contract. */
export const ENV_STATE_WINDOW_CYCLES = "PI_STATE_WINDOW_CYCLES";
/** `boundary` (default) or `paper`; see `../stateboundary/paper.ts`. Other values refuse installation. */
export const ENV_STATE_MODE = "PI_STATE_MODE";
/** Paper mode: `every` (default), `off`, or a positive integer K. Other values refuse installation. */
export const ENV_STATE_REQUIRE_COMMIT = "PI_STATE_REQUIRE_COMMIT";
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
export function paperOptionsFromEnv(env = process.env) {
    return {
        killSwitch: env[ENV_STATE_LOOP],
        cycles: env[ENV_STATE_WINDOW_CYCLES],
        requireCommit: env[ENV_STATE_REQUIRE_COMMIT],
    };
}
//# sourceMappingURL=env.js.map