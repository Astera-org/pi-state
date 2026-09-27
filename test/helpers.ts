// Shared fixtures for the agentstate / merge test suite: `schema()`, `patch(t, raw)` and
// `render(t, doc)` helpers.

import { type DocObject, marshal, parsePatch, type Schema } from "../src/agentstate/index.js";

/** One key of each kind, a bounded list, and a cap small enough that the over-cap case
 * is reachable without generating kilobytes of fixture. */
export function schema(): Schema {
	return {
		maxStateBytes: 256,
		keys: {
			objective: { type: "string" },
			step: { type: "number" },
			done: { type: "bool" },
			findings: { type: "object" },
			files: { type: "list", maxItems: 3 },
		},
	};
}

export function patch(raw: string): DocObject {
	return parsePatch(raw);
}

export function render(doc: DocObject): string {
	return marshal(doc);
}
