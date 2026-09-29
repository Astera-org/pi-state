// The schema lookup chain: explicit schemaPath,
// <agent dir>/pi-state/<key>/schema.json, then the built-in default.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { declaredKeys, declaredTypes, MAX_DESC_BYTES } from "../src/agentstate/index.js";
import { defaultSchema } from "../src/entrypoint/defaultschema.js";
import { installPiState, type PiExtensionAPI, type PiToolDefinition } from "../src/entrypoint/index.js";
import { resolveSchema } from "../src/entrypoint/loadschema.js";
import { projectPath } from "../src/entrypoint/projectpaths.js";

const DEFAULT_KEYS = [
	"active_files",
	"cmd_summary",
	"findings",
	"objective",
	"open_questions",
	"plan",
	"tested_hypotheses",
	"working_dir",
];

function fakePi(): PiExtensionAPI & { tools: Map<string, PiToolDefinition> } {
	const tools = new Map<string, PiToolDefinition>();
	return {
		tools,
		on: () => {},
		registerTool: (tool) => tools.set(tool.name, tool),
		replaceTranscript: () => {},
		appendEntry: () => {},
	};
}

const schemaJson = (key: string) => JSON.stringify({ keys: { [key]: { type: "string" } } });

async function writeHomeSchema(body: string): Promise<void> {
	const path = await projectPath("schema.json", homeDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body, "utf8");
}

let projectDir: string;
let homeDir: string;
let originalCwd: string;
let logs: string[];

beforeEach(async () => {
	originalCwd = process.cwd();
	projectDir = await mkdtemp(join(tmpdir(), "pi-state-project-"));
	homeDir = await mkdtemp(join(tmpdir(), "pi-state-home-"));
	process.chdir(projectDir);
	logs = [];
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	process.chdir(originalCwd);
	await rm(projectDir, { recursive: true, force: true });
	await rm(homeDir, { recursive: true, force: true });
});

const resolve = (extra: { schemaPath?: string } = {}) => resolveSchema({ homeDir, log: (m) => logs.push(m), ...extra });

describe("schema lookup chain", () => {
	test("no schema files anywhere: the built-in default installs", async () => {
		const pi = fakePi();
		await installPiState(pi, {
			homeDir,
			statePath: join(projectDir, "state.json"),
			env: {},
			log: (m) => logs.push(m),
		});
		const got = await pi.tools.get("state_get")!.execute("g", {});
		const payload = JSON.parse(got.content[0]!.text);
		expect(payload.declaredKeys).toEqual(DEFAULT_KEYS);
		expect(payload.declaredTypes).toMatchObject({ objective: "string", plan: "list[8]", findings: "list[16]" });
		expect(logs.some((m) => /built-in default/.test(m))).toBe(true);
	});

	test("with only a home file, the home file is used", async () => {
		await writeHomeSchema(schemaJson("from_home"));
		expect(declaredKeys(await resolve())).toEqual(["from_home"]);
		expect(logs).toEqual([expect.stringContaining(homeDir)]);
	});

	test("working directories each get their own home file", async () => {
		await writeHomeSchema(schemaJson("from_first"));
		const otherDir = await mkdtemp(join(tmpdir(), "pi-state-project-"));
		try {
			process.chdir(otherDir);
			expect(declaredKeys(await resolve())).toEqual(Object.keys(defaultSchema().keys).sort());
			await writeHomeSchema(schemaJson("from_second"));
			expect(declaredKeys(await resolve())).toEqual(["from_second"]);
			process.chdir(projectDir);
			expect(declaredKeys(await resolve())).toEqual(["from_first"]);
		} finally {
			process.chdir(projectDir);
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	test("an explicit schemaPath that does not exist throws, even when a home file exists", async () => {
		await writeHomeSchema(schemaJson("from_home"));
		await expect(resolve({ schemaPath: join(projectDir, "nope.json") })).rejects.toThrow(/no schema file at/);
	});

	test("an explicit schemaPath is used in preference to the lookup chain", async () => {
		await writeHomeSchema(schemaJson("from_home"));
		const explicit = join(projectDir, "explicit.json");
		await writeFile(explicit, schemaJson("from_explicit"), "utf8");
		expect(declaredKeys(await resolve({ schemaPath: explicit }))).toEqual(["from_explicit"]);
		expect(logs).toEqual([expect.stringContaining(explicit)]);
	});

	test("a malformed home file throws and does not fall back to the default", async () => {
		await writeHomeSchema(JSON.stringify({ keys: { x: { type: "bogus" } } }));
		await expect(resolve()).rejects.toThrow();
	});

	test("the replaceTranscript check still runs before any schema lookup", async () => {
		await writeHomeSchema("{ not json");
		const pi = { ...fakePi(), replaceTranscript: undefined };
		await expect(installPiState(pi, { homeDir })).rejects.toThrow(/replaceTranscript/);
	});
});

describe("the built-in default schema", () => {
	test("declares the documented keys and types, with no explicit maxStateBytes", () => {
		const schema = defaultSchema();
		expect(schema.maxStateBytes).toBeUndefined();
		expect(declaredKeys(schema)).toEqual(DEFAULT_KEYS);
		expect(declaredTypes(schema)).toEqual({
			objective: "string",
			plan: "list[8]",
			findings: "list[16]",
			tested_hypotheses: "list[12]",
			active_files: "list[12]",
			working_dir: "string",
			cmd_summary: "string",
			open_questions: "list[8]",
		});
	});

	test("every desc is present and at most MAX_DESC_BYTES bytes", () => {
		for (const field of Object.values(defaultSchema().keys)) {
			expect(field.desc).toBeTruthy();
			expect(Buffer.byteLength(field.desc!, "utf8")).toBeLessThanOrEqual(MAX_DESC_BYTES);
		}
	});

	test("each call returns a fresh copy", () => {
		const a = defaultSchema();
		a.maxStateBytes = 123;
		delete a.keys.plan;
		const b = defaultSchema();
		expect(b.maxStateBytes).toBeUndefined();
		expect(b.keys.plan).toBeDefined();
	});

	test("auto sizing applies to it", async () => {
		const pi = fakePi();
		await installPiState(pi, {
			homeDir,
			statePath: join(projectDir, "state.json"),
			env: { PI_STATE_CONTEXT_WINDOW_TOKENS: "100000" },
			log: () => {},
		});
		const payload = JSON.parse((await pi.tools.get("state_get")!.execute("g", {})).content[0]!.text);
		expect(payload.maxStateBytes).toBe(200000);
	});
});
