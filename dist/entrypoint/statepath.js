// Resolves the state file location, following the lookup chain of `loadschema.ts`'s
// `resolveSchema`.
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/** State path relative to pi's working directory, beside DEFAULT_SCHEMA_PATH. */
export const DEFAULT_STATE_PATH = ".pi-state/state.json";
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return false;
        throw err;
    }
}
/**
 * Finds the state file, in order:
 *
 * 1. `opts.statePath`, when set.
 * 2. `./.pi-state/state.json` (DEFAULT_STATE_PATH, relative to pi's working directory),
 *    when it exists.
 * 3. `~/.pi-state/state.json`, whether or not it exists: a state file that exists in
 *    neither location is created there, never in the working directory.
 *
 * Logs which location was used.
 */
export async function resolveStatePath(opts) {
    if (opts.statePath !== undefined)
        return opts.statePath;
    if (await exists(DEFAULT_STATE_PATH)) {
        opts.log(`[pi-state] state: ${DEFAULT_STATE_PATH}`);
        return DEFAULT_STATE_PATH;
    }
    const homePath = join(opts.homeDir ?? homedir(), DEFAULT_STATE_PATH);
    opts.log(`[pi-state] state: ${homePath}`);
    return homePath;
}
//# sourceMappingURL=statepath.js.map