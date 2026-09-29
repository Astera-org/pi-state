// Resolves the state file location.
import { projectPath } from "./projectpaths.js";
/**
 * Finds the state file, in order:
 *
 * 1. `opts.statePath`, when set.
 * 2. `<agentDir>/pi-state/<projectKey>/<sessionId>/state.json` (see `projectPath`),
 *    whether or not it exists: a missing state file is created there.
 *
 * Logs which location was used.
 */
export async function resolveStatePath(opts) {
    if (opts.statePath !== undefined)
        return opts.statePath;
    if (opts.sessionId === undefined) {
        throw new Error("[pi-state] no session id available to locate the state file; set statePath");
    }
    const path = await projectPath("state.json", opts.homeDir, opts.sessionId);
    opts.log(`[pi-state] state: ${path}`);
    return path;
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