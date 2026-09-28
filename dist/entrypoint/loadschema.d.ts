import { type Schema } from "../agentstate/index.js";
/** Schema path relative to pi's working directory, beside DEFAULT_STATE_PATH. */
export declare const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";
export interface ResolveSchemaOptions {
    /** An explicit schema file. When set, it is the only source consulted. */
    schemaPath?: string;
    /** Defaults to `os.homedir()`. Exposed for tests. */
    homeDir?: string;
    log: (message: string) => void;
}
/**
 * Finds the schema, in order:
 *
 * 1. `opts.schemaPath`, when set; a missing file throws.
 * 2. `./.pi-state/schema.json` (DEFAULT_SCHEMA_PATH, relative to pi's working directory).
 * 3. `~/.pi-state/schema.json`.
 * 4. The built-in default (defaultschema.ts).
 *
 * Only a missing file (ENOENT) falls through to the next source; a file that exists but
 * cannot be read or parsed throws. Logs which source was used.
 */
export declare function resolveSchema(opts: ResolveSchemaOptions): Promise<Schema>;
//# sourceMappingURL=loadschema.d.ts.map