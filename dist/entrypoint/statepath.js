// Resolves the state file location, following the lookup chain of `loadschema.ts`'s
// `resolveSchema`.
import { access } from "node:fs/promises";
import { projectPaths } from "./projectpaths.js";
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
 * 2. `./.pi-state/state.json`, relative to pi's working directory, when it exists.
 * 3. `<agentDir>/pi-state/<projectKey>/<sessionId>/state.json` (see `projectPaths`),
 *    whether or not it exists: a state file that exists in neither location is created
 *    there, never in the working directory.
 *
 * Logs which location was used.
 */
export async function resolveStatePath(opts) {
    if (opts.statePath !== undefined)
        return opts.statePath;
    if (opts.sessionId === undefined) {
        throw new Error("[pi-state] no session id available to locate the state file; set statePath");
    }
    const { cwdPath, homePath } = await projectPaths("state.json", opts.homeDir, opts.sessionId);
    if (await exists(cwdPath)) {
        opts.log(`[pi-state] state: ${cwdPath}`);
        return cwdPath;
    }
    opts.log(`[pi-state] state: ${homePath}`);
    return homePath;
}
/** `ctx.sessionManager.getSessionId()`, or undefined when `ctx` does not expose it. */
function sessionIdOf(ctx) {
    const manager = ctx?.sessionManager;
    const id = typeof manager?.getSessionId === "function" ? manager.getSessionId() : undefined;
    return typeof id === "string" ? id : undefined;
}
/**
 * Returns a resolver from a tool-execution `ctx` to the state file. pi hands `ctx` to a
 * tool only when it executes, so the session id is unavailable at install time. The result
 * is cached per session id, so the lookup runs, and logs, once per session.
 */
export function stateLocator(opts) {
    if (opts.statePath !== undefined) {
        const explicit = opts.statePath;
        return async () => explicit;
    }
    let cached;
    return (ctx) => {
        const sessionId = sessionIdOf(ctx);
        if (cached === undefined || cached.sessionId !== sessionId) {
            const path = resolveStatePath({ ...opts, sessionId });
            path.catch(() => {
                cached = undefined;
            });
            cached = { sessionId, path };
        }
        return cached.path;
    };
}
//# sourceMappingURL=statepath.js.map