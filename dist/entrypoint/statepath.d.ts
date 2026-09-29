export interface ResolveStatePathOptions {
    /** An explicit state file. When set, it is returned unchanged. */
    statePath?: string;
    /** Defaults to `os.homedir()`. Exposed for tests. */
    homeDir?: string;
    log: (message: string) => void;
}
/**
 * Finds the state file, in order:
 *
 * 1. `opts.statePath`, when set.
 * 2. `./.pi-state/state.json`, relative to pi's working directory, when it exists.
 * 3. `~/.pi-state/projects/<projectKey>/state.json` (see `projectPaths`), whether or not it exists: a state file that exists in
 *    neither location is created there, never in the working directory.
 *
 * Logs which location was used.
 */
export declare function resolveStatePath(opts: ResolveStatePathOptions): Promise<string>;
//# sourceMappingURL=statepath.d.ts.map