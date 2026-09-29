import { type BoundaryAPI } from "../stateboundary/index.js";
export interface PiTextContent {
    type: "text";
    text: string;
}
export interface PiToolResult {
    content: PiTextContent[];
    details?: unknown;
}
export interface PiToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<PiToolResult>;
}
export interface PiExtensionAPI extends BoundaryAPI {
    registerTool(tool: PiToolDefinition): void;
}
export interface PiStateOptions {
    /** An explicit schema file; a missing one is an error. When unset, the schema is looked
     * up as described at `loadschema.ts`'s `resolveSchema`. */
    schemaPath?: string;
    /** Home directory of the `<home>/.pi/agent` fallback (used when `PI_CODING_AGENT_DIR`
     * is unset), where `pi-state/<key>/{schema,state}.json` are looked up after the working
     * directory. Defaults to `os.homedir()`. Exposed for tests. */
    homeDir?: string;
    /** An explicit state file. When unset, the path is resolved as described at
     * `statepath.ts`'s `resolveStatePath`. */
    statePath?: string;
    /** Defaults to `process.env`. Exposed for tests. */
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/**
 * Installs the state loop: registers the two tools backed by the file backend and
 * installs the transcript boundary.
 *
 * In boundary mode, throws when `pi` exposes no `replaceTranscript`. The check runs first,
 * before the schema is resolved. Paper mode does not use `replaceTranscript` and skips the
 * check. (The mode logs and skips for its other decline reasons, such as the kill switch,
 * an invalid cycle count, `PI_STATE_MODE`, or `PI_STATE_REQUIRE_COMMIT`.)
 */
export declare function installPiState(pi: PiExtensionAPI, opts?: PiStateOptions): Promise<void>;
export default installPiState;
//# sourceMappingURL=index.d.ts.map