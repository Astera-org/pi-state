import { type BoundaryAPI } from "../stateboundary/index.js";
/** Where the state file lives, relative to pi's working directory, unless overridden —
 * beside the schema file `loadschema.ts`'s DEFAULT_SCHEMA_PATH names, under the one
 * directory this extension owns. */
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
 * Install the standalone state loop: register the two tools, wire the file backend as
 * their implementation, and install the transcript boundary.
 *
 * Refuses LOUDLY — throws, rather than the boundary ladder's usual quiet log-and-skip —
 * when this `pi` exposes no `replaceTranscript`. Every other reason `installStateBoundary`
 * declines to install (the kill switch off, a bad cycle count) is a legitimate
 * configuration choice on a `pi` that COULD run the loop; a missing `replaceTranscript`
 * means this host fundamentally cannot, no matter how it is configured, so this checks it
 * before doing anything else — before the schema file is even read — rather than letting
 * the boundary's own installer discover it later and log it as just another off switch.
 */
export declare function installPiState(pi: PiExtensionAPI, opts?: PiStateOptions): Promise<void>;
export default installPiState;
//# sourceMappingURL=index.d.ts.map