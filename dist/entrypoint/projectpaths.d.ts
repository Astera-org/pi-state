/**
 * The lookup locations for `file` (`schema.json` or `state.json`): the path relative to
 * the working directory, and `<home>/.pi-state/projects/<projectKey>/<file>`.
 */
export declare function projectPaths(file: string, homeDir?: string): Promise<{
    cwdPath: string;
    homePath: string;
}>;
//# sourceMappingURL=projectpaths.d.ts.map