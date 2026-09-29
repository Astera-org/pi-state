export interface ResolveStatePathOptions {
    /** An explicit state file. When set, it is returned unchanged. */
    statePath?: string;
    /** The pi session's id; names the home fallback's directory. Required unless
     * `statePath` is set. */
    sessionId?: string;
    /** Defaults to `os.homedir()`. Exposed for tests. */
    homeDir?: string;
    log: (message: string) => void;
}
/**
 * Finds the state file, in order:
 *
 * 1. `opts.statePath`, when set.
 * 2. `<agentDir>/pi-state/<projectKey>/<sessionId>/state.json` (see `projectPath`),
 *    whether or not it exists: a missing state file is created there.
 *
 * Logs which location was used.
 */
export declare function resolveStatePath(opts: ResolveStatePathOptions): Promise<string>;
/**
 * Returns a resolver from a tool-execution `ctx` to the state file. pi hands `ctx` to a
 * tool only when it executes, so the session id is unavailable at install time. The result
 * is cached per session id, so the lookup runs, and logs, once per session.
 */
export declare function stateLocator(opts: Omit<ResolveStatePathOptions, "sessionId">): (ctx: unknown) => Promise<string>;
//# sourceMappingURL=statepath.d.ts.map