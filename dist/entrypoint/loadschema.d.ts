import { type Schema } from "../agentstate/index.js";
/** Default schema file location, relative to pi's working directory. Sits in the same
 * `.pi-state/` directory as DEFAULT_STATE_PATH (entrypoint/index.ts). */
export declare const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";
/** Reads and parses the schema file. A missing file throws (a schema with no keys refuses
 * every non-empty patch, so there is no usable default). A file that does not parse
 * throws parseSchema's error unchanged. */
export declare function loadSchemaFile(path: string): Promise<Schema>;
//# sourceMappingURL=loadschema.d.ts.map