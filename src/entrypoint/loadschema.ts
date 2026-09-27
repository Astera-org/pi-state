// Loads the operator-authored state schema from a file in pi's working directory, in the
// exact grammar `agentstate.parseSchema` accepts. There is no server or database backing
// this extension, so the schema — what Sigma's keys are, their types, and the byte cap —
// lives beside the state file it governs, in the one directory this extension owns.

import { readFile } from "node:fs/promises";
import { parseSchema, type Schema } from "../agentstate/index.js";

/** Where this entrypoint looks for the schema file, relative to pi's working directory,
 * unless a caller overrides it. `.pi-state/` mirrors this repo's own name and keeps every
 * file this extension owns under one directory a user can `.gitignore` or inspect as a
 * unit — `schema.json` sits beside the state file this same directory holds
 * (see `../backend`'s DEFAULT_STATE_PATH sibling in entrypoint/index.ts). */
export const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";

/** Reads and parses the schema file. There is no sane default for a missing one — a
 * schema with no keys refuses every non-empty patch — so this fails loudly with an
 * actionable message rather than installing a state loop that can never commit anything.
 * A schema file that exists but does not parse (parseSchema's own AgentStateSchemaError)
 * propagates unchanged: it is the same "unusable schema" refusal sproot's stateLoopPolicy
 * gives, and defence in depth is someone else's job here since there is no server-side
 * write boundary to have already validated it. */
export async function loadSchemaFile(path: string): Promise<Schema> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`[pi-state] no schema file at ${path} — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit`,
			);
		}
		throw err;
	}
	return parseSchema(raw);
}
