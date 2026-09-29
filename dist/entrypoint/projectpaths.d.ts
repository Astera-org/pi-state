/**
 * The location of `file` (`schema.json` or `state.json`):
 * `<agentDir>/pi-state/<projectKey>/[<sessionId>/]<file>`.
 * A `sessionId` outside `[A-Za-z0-9][A-Za-z0-9._-]*` throws.
 */
export declare function projectPath(file: string, homeDir?: string, sessionId?: string): Promise<string>;
//# sourceMappingURL=projectpaths.d.ts.map