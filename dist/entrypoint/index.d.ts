import { type BoundaryAPI } from "../stateboundary/index.js";
/** Default state file location, relative to pi's working directory; beside
 * `loadschema.ts`'s DEFAULT_SCHEMA_PATH. */
export declare const DEFAULT_STATE_PATH = ".pi-state/state.json";
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
    /** Defaults to `loadschema.ts`'s DEFAULT_SCHEMA_PATH (`.pi-state/schema.json`). */
    schemaPath?: string;
    /** Defaults to DEFAULT_STATE_PATH (`.pi-state/state.json`). */
    statePath?: string;
    /** Defaults to `process.env`. Exposed for tests. */
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/**
 * Installs the state loop: registers the two tools backed by the file backend and
 * installs the transcript boundary.
 *
 * Throws when `pi` exposes no `replaceTranscript`. The check runs first, before the
 * schema file is read. (`installStateBoundary` only logs and skips for its other
 * decline reasons, such as the kill switch or an invalid cycle count.)
 */
export declare function installPiState(pi: PiExtensionAPI, opts?: PiStateOptions): Promise<void>;
export default installPiState;
//# sourceMappingURL=index.d.ts.map