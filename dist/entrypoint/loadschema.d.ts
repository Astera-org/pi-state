import { type Schema } from "../agentstate/index.js";
/** Where this entrypoint looks for the schema file, relative to pi's working directory,
 * unless a caller overrides it. `.pi-state/` mirrors this repo's own name and keeps every
 * file this extension owns under one directory a user can `.gitignore` or inspect as a
 * unit — `schema.json` sits beside the state file this same directory holds
 * (see `../backend`'s DEFAULT_STATE_PATH sibling in entrypoint/index.ts). */
export declare const DEFAULT_SCHEMA_PATH = ".pi-state/schema.json";
/** Reads and parses the schema file. There is no sane default for a missing one — a
 * schema with no keys refuses every non-empty patch — so this fails loudly with an
 * actionable message rather than installing a state loop that can never commit anything.
 * A schema file that exists but does not parse (parseSchema's own AgentStateSchemaError)
 * propagates unchanged: it is the same "unusable schema" refusal sproot's stateLoopPolicy
 * gives, and defence in depth is someone else's job here since there is no server-side
 * write boundary to have already validated it. */
export declare function loadSchemaFile(path: string): Promise<Schema>;
//# sourceMappingURL=loadschema.d.ts.map