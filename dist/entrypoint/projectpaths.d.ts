/**
 * The lookup locations for `file` (`schema.json` or `state.json`): the path relative to
 * the working directory, and `<agentDir>/pi-state/<projectKey>/[<sessionId>/]<file>`.
 * A `sessionId` that is not a single path segment throws.
 */
export declare function projectPaths(file: string, homeDir?: string, sessionId?: string): Promise<{
    cwdPath: string;
    homePath: string;
}>;
//# sourceMappingURL=projectpaths.d.ts.map