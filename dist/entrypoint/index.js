// The pi extension entrypoint: registers `state_get` and `state_commit` as local pi tools
// backed by the file backend (`../backend`), and installs the transcript boundary
// (`../stateboundary`).
//
// The tools are registered under their bare names (`state_get`, `state_commit`), one of
// the spellings `STATE_COMMIT_TOOL_NAMES` (statewindow.ts) recognizes for a
// `state_commit` result.
import { declaredKeys, declaredTypes, JsonNumber, marshal, schemaCap, } from "../agentstate/index.js";
import { commitFileState, readFileState } from "../backend/index.js";
import { installPaperMode, installStateBoundary, installStateCommitCache, paperSetting, recordStateWindowIntoTranscript, seedStateCommitCache, stateBoundaryNotInstalled, stateModeSetting, } from "../stateboundary/index.js";
import { applyAutoMaxStateBytes, contextWindowFromModelHolder, contextWindowTokensFromEnv } from "./autocap.js";
import { ENV_STATE_MODE, paperOptionsFromEnv, stateWindowOptionsFromEnv } from "./env.js";
import { resolveSchema } from "./loadschema.js";
import { stateCommitInputSchema } from "./patchschema.js";
import { resolveStatePath } from "./statepath.js";
// pi coerces arguments before execute. Patch numbers arrive as JS numbers and are
// stored as String(v); arbitrary-precision digits may already be lost. See README.
function toDocValue(v) {
    if (v === null)
        return null;
    if (typeof v === "boolean" || typeof v === "string")
        return v;
    if (typeof v === "number") {
        if (!Number.isFinite(v))
            throw new Error(`patch number ${v} is not finite`);
        return new JsonNumber(String(v));
    }
    if (Array.isArray(v))
        return v.map(toDocValue);
    if (typeof v === "object") {
        const out = {};
        for (const [key, value] of Object.entries(v))
            out[key] = toDocValue(value);
        return out;
    }
    throw new Error(`patch value of type ${typeof v} is not representable in a state document`);
}
function toPatchDoc(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        const got = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
        throw new Error(`patch must be a JSON object, got ${got}`);
    }
    const out = {};
    for (const [key, value] of Object.entries(raw))
        out[key] = toDocValue(value);
    return out;
}
// --- the two tools --------------------------------------------------------------------
function stateGetEnvelope(schema, stored) {
    const keys = JSON.stringify(declaredKeys(schema));
    const types = JSON.stringify(declaredTypes(schema));
    const cap = schemaCap(schema);
    if (!stored.exists) {
        return `{"ok":true,"version":0,"doc":{},"exists":false,"note":"no state yet — commit with version 0 to create it","declaredKeys":${keys},"declaredTypes":${types},"maxStateBytes":${cap}}`;
    }
    return `{"ok":true,"version":${stored.version},"doc":${marshal(stored.doc)},"exists":true,"declaredKeys":${keys},"declaredTypes":${types},"maxStateBytes":${cap}}`;
}
function stateGetTool(schema, statePath) {
    return {
        name: "state_get",
        label: "state_get",
        description: "Read your durable working state (Σ) and the schema it must fit — call this before your first state_commit.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({
            content: [{ type: "text", text: stateGetEnvelope(schema, await readFileState(statePath)) }],
        }),
    };
}
function stateCommitTool(schema, statePath) {
    return {
        name: "state_commit",
        label: "state_commit",
        description: "Commit a patch to your durable working state (Σ). A null value at a key deletes it. Requires the version you last read (0 if you have none yet) as a compare-and-set token: a commit decided against an older version is refused.",
        parameters: stateCommitInputSchema(schema),
        execute: async (_toolCallId, params) => {
            const args = (params ?? {});
            if (args.version === undefined || args.version === null) {
                throw new Error("state_commit requires version: the version you read with state_get (0 if you have no state yet)");
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
 * Installs the state loop: registers the two tools backed by the file backend and
 * installs the transcript boundary.
 *
 * In boundary mode, throws when `pi` exposes no `replaceTranscript`. The check runs first,
 * before the schema is resolved. Paper mode does not use `replaceTranscript` and skips the
 * check. (The mode logs and skips for its other decline reasons, such as the kill switch,
 * an invalid cycle count, `PI_STATE_MODE`, or `PI_STATE_REQUIRE_COMMIT`.)
 */
export async function installPiState(pi, opts = {}) {
    const env = opts.env ?? process.env;
    const mode = stateModeSetting(env[ENV_STATE_MODE]);
    if (mode === "boundary" && typeof pi.replaceTranscript !== "function") {
        throw new Error("[pi-state] this pi exposes no replaceTranscript — pi-state cannot bound the prompt on this host, so it refuses to install rather than run a state loop that can never take effect");
    }
    const log = opts.log ?? ((message) => console.error(message));
    const statePath = await resolveStatePath({ statePath: opts.statePath, homeDir: opts.homeDir, log });
    const schema = await resolveSchema({ schemaPath: opts.schemaPath, homeDir: opts.homeDir, log });
    // Captured before anything assigns schema.maxStateBytes; applyAutoMaxStateBytes needs
    // the value the schema file declared.
    const declaredMaxStateBytes = schema.maxStateBytes;
    // Install-time resolution: before a session starts, only the env var is available.
    applyAutoMaxStateBytes(schema, declaredMaxStateBytes, contextWindowTokensFromEnv(env), log);
    pi.registerTool(stateGetTool(schema, statePath));
    pi.registerTool(stateCommitTool(schema, statePath));
    // Registered before the boundary: both are `tool_result` handlers run in registration
    // order, and the cache must observe a result before the boundary reads Σ (see
    // stateboundary.ts's `installStateBoundary`).
    installStateCommitCache(pi);
    if (mode === "paper") {
        const setting = paperSetting(paperOptionsFromEnv(env));
        if ("condition" in setting)
            log(stateBoundaryNotInstalled(setting));
        else
            installPaperMode(pi, setting, { log });
    }
    else if (typeof mode === "object") {
        log(stateBoundaryNotInstalled(mode));
    }
    else {
        const record = (data) => recordStateWindowIntoTranscript(pi, data, log);
        installStateBoundary(pi, stateWindowOptionsFromEnv(env), record, { log });
    }
    pi.on("session_start", (_event, ctx) => {
        seedStateCommitCache(ctx, log);
        // A model's contextWindow takes precedence over the env var (see autocap.ts).
        const contextWindowTokens = contextWindowFromModelHolder(ctx) ?? contextWindowTokensFromEnv(env);
        applyAutoMaxStateBytes(schema, declaredMaxStateBytes, contextWindowTokens, log);
    });
    pi.on("model_select", (event) => {
        const contextWindowTokens = contextWindowFromModelHolder(event) ?? contextWindowTokensFromEnv(env);
        applyAutoMaxStateBytes(schema, declaredMaxStateBytes, contextWindowTokens, log);
    });
}
export default installPiState;
//# sourceMappingURL=index.js.map