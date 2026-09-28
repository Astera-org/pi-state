// Resolves the state schema (Sigma's keys, their types, and the byte cap): an
// operator-authored file in the exact grammar `agentstate.parseSchema` accepts, or the
// built-in default when no file exists.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSchema, type Schema } from "../agentstate/index.js";
import { defaultSchema } from "./defaultschema.js";

/** Schema path relative to pi's working directory, beside DEFAULT_STATE_PATH. */
export const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";

export interface ResolveSchemaOptions {
	/** An explicit schema file. When set, it is the only source consulted. */
	schemaPath?: string;
	/** Defaults to `os.homedir()`. Exposed for tests. */
	homeDir?: string;
	log: (message: string) => void;
}

/**
 * Reads and parses a schema. Returns undefined only for ENOENT; other read errors
 * and parse errors propagate unchanged.
 */
async function readSchemaFile(path: string): Promise<Schema | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return parseSchema(raw);
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
export async function resolveSchema(opts: ResolveSchemaOptions): Promise<Schema> {
	if (opts.schemaPath !== undefined) {
		const schema = await readSchemaFile(opts.schemaPath);
		if (schema === undefined) {
			throw new Error(
				`[pi-state] no schema file at ${opts.schemaPath} — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit`,
			);
		}
		opts.log(`[pi-state] schema: ${opts.schemaPath}`);
		return schema;
	}
	const homePath = join(opts.homeDir ?? homedir(), DEFAULT_SCHEMA_PATH);
	for (const path of [DEFAULT_SCHEMA_PATH, homePath]) {
		const schema = await readSchemaFile(path);
		if (schema !== undefined) {
			opts.log(`[pi-state] schema: ${path}`);
			return schema;
		}
	}
	opts.log("[pi-state] schema: built-in default (no schema file found)");
	return defaultSchema();
}
