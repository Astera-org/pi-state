/** State path relative to pi's working directory, beside DEFAULT_SCHEMA_PATH. */
export declare const DEFAULT_STATE_PATH = ".pi-state/state.json";
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
 * 2. `./.pi-state/state.json` (DEFAULT_STATE_PATH, relative to pi's working directory),
 *    when it exists.
 * 3. `~/.pi-state/state.json`, whether or not it exists: a state file that exists in
 *    neither location is created there, never in the working directory.
 *
 * Logs which location was used.
 */
export declare function resolveStatePath(opts: ResolveStatePathOptions): Promise<string>;
//# sourceMappingURL=statepath.d.ts.map