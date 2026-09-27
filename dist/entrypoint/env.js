// Maps THIS repo's own environment variable names onto `StateWindowOptions`
// (src/stateboundary/statewindow.ts) — the caller-supplied object that module's fail-closed
// parsing runs on. This is a standalone extension with no separate "mode" variable and
// separate operator kill switch, so the two collapse into one flag here.
/** The state loop's on/off switch. Kill-switch semantics (see `stateWindowSetting`):
 * unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it ON, a recognized
 * negative (`0`/`false`/`no`/`off`) turns it OFF as an operator choice, and anything else
 * is an unrecognized value that also refuses — fail closed rather than run at an
 * unchosen setting. Defaults to ON (rather than requiring explicit opt-in) so that
 * installing this extension with no configuration at all already bounds the prompt —
 * the ticket's acceptance bar has no env vars to set. */
export const ENV_STATE_LOOP = "PI_STATE_LOOP";
/** N, the number of trailing tool cycles kept alongside Σ. Unset means
 * `DEFAULT_TOOL_CYCLES`; see `parseToolCycles` for the parsing contract. */
export const ENV_STATE_WINDOW_CYCLES = "PI_STATE_WINDOW_CYCLES";
export function stateWindowOptionsFromEnv(env = process.env) {
    return {
        enabled: true,
        killSwitch: env[ENV_STATE_LOOP],
        cycles: env[ENV_STATE_WINDOW_CYCLES],
    };
}
//# sourceMappingURL=env.js.map