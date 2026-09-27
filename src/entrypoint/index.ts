// The standalone pi extension entrypoint (ENG-1487's "no external server, no Postgres,
// no MCP round trip" bar): registers `state_get` and `state_commit` as LOCAL pi tools
// backed by the file backend (`../backend`), and installs the transcript boundary
// (`../stateboundary`). No MCP `connect()`, no receipt file, no external provider
// registration, no logprobs capture — this extension's whole job is Σ, alone.
//
// The two tools are registered under their BARE names (`state_get`, `state_commit`), not
// MCP-prefixed: there is no MCP server here to prefix a name after, and
// `STATE_COMMIT_TOOL_NAMES` (statewindow.ts) already recognizes the bare name as one of
// the two spellings a `state_commit` result may arrive under, so the Σ cache and the
// boundary need no change to observe a local tool's results.

import {
	type DocObject,
	type DocValue,
	declaredKeys,
	declaredTypes,
	JsonNumber,
	marshal,
	type Schema,
	schemaCap,
} from "../agentstate/index.js";
import { commitFileState, readFileState } from "../backend/index.js";
import {
	type BoundaryAPI,
	installStateBoundary,
	installStateCommitCache,
	recordStateWindowIntoTranscript,
	seedStateCommitCache,
} from "../stateboundary/index.js";
import { stateWindowOptionsFromEnv } from "./env.js";
import { DEFAULT_SCHEMA_PATH, loadSchemaFile } from "./loadschema.js";
import { stateCommitInputSchema } from "./patchschema.js";

/** Where the state file lives, relative to pi's working directory, unless overridden —
 * beside the schema file `loadschema.ts`'s DEFAULT_SCHEMA_PATH names, under the one
 * directory this extension owns. */
export const DEFAULT_STATE_PATH = ".pi-state/state.json";

// --- the slice of pi's extension API this entrypoint depends on -------------------
// Declared structurally, so this file typechecks and unit-tests with no `pi` package
// installed.

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
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<PiToolResult>;
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

// --- patch conversion ---------------------------------------------------------------
//
// pi coerces a tool call's arguments against the JSON Schema `parameters` advertises
// (typebox/`coerceWithJsonSchema`) BEFORE `execute` is reached, so what arrives here is
// already a plain parsed JS value — a JS `number`, not the exact source digits
// `agentstate`'s own parser keeps. THIS IS A REAL, DOCUMENTED GAP: an MCP `state_commit`
// backed by `json.RawMessage` straight off the wire lets an arbitrary-precision number
// survive it exactly; a local pi tool's arguments have already been through one lossy JS
// round trip by the time any extension sees them, and no pi extension API hands back the
// raw bytes to undo that. `String(v)` is the best available rendering of what pi already
// parsed — see the README.

function toDocValue(v: unknown): DocValue {
	if (v === null) return null;
	if (typeof v === "boolean" || typeof v === "string") return v;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new Error(`patch number ${v} is not finite`);
		return new JsonNumber(String(v));
	}
	if (Array.isArray(v)) return v.map(toDocValue);
	if (typeof v === "object") {
		const out: DocObject = {};
		for (const [key, value] of Object.entries(v as Record<string, unknown>)) out[key] = toDocValue(value);
		return out;
	}
	throw new Error(`patch value of type ${typeof v} is not representable in a state document`);
}

function toPatchDoc(raw: unknown): DocObject {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		const got = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
		throw new Error(`patch must be a JSON object, got ${got}`);
	}
	const out: DocObject = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) out[key] = toDocValue(value);
	return out;
}

// --- the two tools --------------------------------------------------------------------

function stateGetEnvelope(schema: Schema, stored: Awaited<ReturnType<typeof readFileState>>): string {
	const keys = JSON.stringify(declaredKeys(schema));
	const types = JSON.stringify(declaredTypes(schema));
	const cap = schemaCap(schema);
	if (!stored.exists) {
		return `{"ok":true,"version":0,"doc":{},"exists":false,"note":"no state yet — commit with version 0 to create it","declaredKeys":${keys},"declaredTypes":${types},"maxStateBytes":${cap}}`;
	}
	return `{"ok":true,"version":${stored.version},"doc":${marshal(stored.doc)},"exists":true,"declaredKeys":${keys},"declaredTypes":${types},"maxStateBytes":${cap}}`;
}

function stateGetTool(schema: Schema, statePath: string): PiToolDefinition {
	return {
		name: "state_get",
		label: "state_get",
		description:
			"Read your durable working state (Σ) and the schema it must fit — call this before your first state_commit.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({
			content: [{ type: "text", text: stateGetEnvelope(schema, await readFileState(statePath)) }],
		}),
	};
}

function stateCommitTool(schema: Schema, statePath: string): PiToolDefinition {
	return {
		name: "state_commit",
		label: "state_commit",
		description:
			"Commit a patch to your durable working state (Σ). A null value at a key deletes it. Requires the version you last read (0 if you have none yet) as a compare-and-set token: a commit decided against an older version is refused.",
		parameters: stateCommitInputSchema(schema),
		execute: async (_toolCallId, params) => {
			const args = (params ?? {}) as { patch?: unknown; version?: unknown };
			if (args.version === undefined || args.version === null) {
				throw new Error(
					"state_commit requires version: the version you read with state_get (0 if you have no state yet)",
				);
			}
			const version = Number(args.version);
			if (!Number.isInteger(version) || version < 0) {
				throw new Error(`version must be a non-negative integer, got ${JSON.stringify(args.version)}`);
			}
			const patch = toPatchDoc(args.patch ?? {});
			const result = await commitFileState(statePath, schema, patch, version);
			const text = `{"ok":true,"version":${result.version},"doc":${marshal(result.doc)},"declaredTypes":${JSON.stringify(declaredTypes(schema))},"maxStateBytes":${schemaCap(schema)}}`;
			return { content: [{ type: "text", text }] };
		},
	};
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
export async function installPiState(pi: PiExtensionAPI, opts: PiStateOptions = {}): Promise<void> {
	if (typeof pi.replaceTranscript !== "function") {
		throw new Error(
			"[pi-state] this pi exposes no replaceTranscript — pi-state cannot bound the prompt on this host, so it refuses to install rather than run a state loop that can never take effect",
		);
	}
	const log = opts.log ?? ((message: string) => console.error(message));
	const schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA_PATH;
	const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
	const schema = await loadSchemaFile(schemaPath);

	pi.registerTool(stateGetTool(schema, statePath));
	pi.registerTool(stateCommitTool(schema, statePath));

	// BEFORE the boundary's own handler, so the cache has already observed a result by the
	// time the boundary asks what Σ is — both are `tool_result` handlers pi runs in
	// registration order (see stateboundary.ts's `installStateBoundary` doc comment).
	installStateCommitCache(pi);
	const options = stateWindowOptionsFromEnv(opts.env ?? process.env);
	const record = (data: Parameters<typeof recordStateWindowIntoTranscript>[1]) =>
		recordStateWindowIntoTranscript(pi, data, log);
	installStateBoundary(pi, options, record, { log });
	pi.on("session_start", (_event, ctx) => {
		seedStateCommitCache(ctx, log);
	});
}

export default installPiState;
