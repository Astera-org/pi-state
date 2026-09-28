// The built-in schema used when no schema file is found (see loadschema.ts's
// `resolveSchema`). Declares no `maxStateBytes`, so the cap is sized automatically from
// the model's context window (autocap.ts).

import { parseSchema, type Schema } from "../agentstate/index.js";

const DEFAULT_SCHEMA_JSON = JSON.stringify({
	keys: {
		objective: { type: "string", desc: "what you are trying to accomplish, in one or two sentences" },
		plan: { type: "list", maxItems: 8, desc: "ordered remaining steps; drop each step once it is done" },
		findings: { type: "list", maxItems: 16, desc: "facts learned that later steps depend on, one short line each" },
		tested_hypotheses: {
			type: "list",
			maxItems: 12,
			desc: "hypotheses already tried, each with its outcome, so they are not retried",
		},
		active_files: { type: "list", maxItems: 12, desc: "paths of the files you are reading or editing right now" },
		working_dir: { type: "string", desc: "the directory commands currently run in" },
		cmd_summary: { type: "string", desc: "what the last few commands did and what they returned" },
		open_questions: { type: "list", maxItems: 8, desc: "unresolved questions that block or shape the next steps" },
	},
});

/** A new copy of the built-in schema on every call: `applyAutoMaxStateBytes` writes
 * `maxStateBytes` into the schema it is given, so installs must not share one. */
export function defaultSchema(): Schema {
	return parseSchema(DEFAULT_SCHEMA_JSON);
}
