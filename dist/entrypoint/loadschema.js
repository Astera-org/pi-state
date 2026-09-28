// Loads the operator-authored state schema from a file in pi's working directory, in the
// exact grammar `agentstate.parseSchema` accepts. The schema (Sigma's keys, their types,
// and the byte cap) lives beside the state file it governs.
import { readFile } from "node:fs/promises";
import { parseSchema } from "../agentstate/index.js";
/** Default schema file location, relative to pi's working directory. Sits in the same
 * `.pi-state/` directory as DEFAULT_STATE_PATH (entrypoint/index.ts). */
export const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";
/** Reads and parses the schema file. A missing file throws (a schema with no keys refuses
 * every non-empty patch, so there is no usable default). A file that does not parse
 * throws parseSchema's error unchanged. */
export async function loadSchemaFile(path) {
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new Error(`[pi-state] no schema file at ${path} — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit`);
        }
        throw err;
    }
    return parseSchema(raw);
}
//# sourceMappingURL=loadschema.js.map