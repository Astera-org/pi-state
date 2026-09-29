// The state path lookup chain: explicit statePath, then
// <agent dir>/pi-state/<key>/<sessionId>/state.json (created when absent).

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installPiState, type PiExtensionAPI, type PiToolDefinition } from "../src/entrypoint/index.js";
import { projectPath } from "../src/entrypoint/projectpaths.js";
import { resolveStatePath } from "../src/entrypoint/statepath.js";

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

const SESSION = "session-a";
const ctxFor = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

const scopedHomeState = async (sessionId = SESSION) => projectPath("state.json", homeDir, sessionId);

async function writeHomeState(version: number): Promise<void> {
	const path = await scopedHomeState();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `{"version":${version},"doc":{}}`, "utf8");
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

const resolve = (extra: { statePath?: string; sessionId?: string } = {}) =>
	resolveStatePath({ homeDir, sessionId: SESSION, log: (m) => logs.push(m), ...extra });

async function installedTools(extra: { statePath?: string; sessionId?: string } = {}) {
	const { sessionId = SESSION, ...opts } = extra;
	const pi = fakePi();
	await installPiState(pi, { homeDir, env: {}, log: (m) => logs.push(m), ...opts });
	const ctx = ctxFor(sessionId);
	const get = async () =>
		JSON.parse((await pi.tools.get("state_get")!.execute("g", {}, undefined, undefined, ctx)).content[0]!.text);
	const commit = (version: number, objective = "x") =>
		pi.tools.get("state_commit")!.execute("c", { patch: { objective }, version }, undefined, undefined, ctx);
	return { get, commit };
}

describe("state path lookup chain", () => {
	test("no state files anywhere: resolves under the home directory", async () => {
		expect(await resolve()).toBe(await scopedHomeState());
		expect(logs).toEqual([expect.stringContaining(homeDir)]);
	});

	test("no state files anywhere: the first commit creates the file under the home directory only", async () => {
		const { get, commit } = await installedTools();
		expect((await get()).exists).toBe(false);
		await commit(0);
		expect(existsSync(await scopedHomeState())).toBe(true);
		expect(existsSync(join(projectDir, ".pi-state"))).toBe(false);
		expect((await get()).version).toBe(1);
	});

	test("the home file is used when only it exists", async () => {
		await writeHomeState(7);
		expect(await resolve()).toBe(await scopedHomeState());
		expect((await (await installedTools()).get()).version).toBe(7);
	});

	test("an explicit statePath is used unconditionally", async () => {
		await writeHomeState(7);
		const statePath = join(projectDir, "explicit.json");
		expect(await resolve({ statePath })).toBe(statePath);
		expect(logs).toEqual([]);
		const { get, commit } = await installedTools({ statePath });
		expect((await get()).exists).toBe(false);
		await commit(0);
		expect(existsSync(statePath)).toBe(true);
	});

	test("different working directories get different home files, and the same one a stable file", async () => {
		const first = await resolve();
		expect(await resolve()).toBe(first);
		const otherDir = await mkdtemp(join(tmpdir(), "pi-state-project-"));
		try {
			process.chdir(otherDir);
			const second = await resolve();
			expect(second).not.toBe(first);
			expect(dirname(dirname(dirname(second)))).toBe(dirname(dirname(dirname(first))));
			process.chdir(projectDir);
			expect(await resolve()).toBe(first);
		} finally {
			process.chdir(projectDir);
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	test("two sessions in one working directory get different home files under the same project directory", async () => {
		const a = await resolve({ sessionId: "session-a" });
		const b = await resolve({ sessionId: "session-b" });
		expect(a).not.toBe(b);
		expect(dirname(dirname(a))).toBe(dirname(dirname(b)));
		expect(await resolve({ sessionId: "session-a" })).toBe(a);
	});

	test("state committed in one session is not visible to another session in the same directory", async () => {
		const a = await installedTools({ sessionId: "session-a" });
		const b = await installedTools({ sessionId: "session-b" });
		await a.commit(0, "from a");
		expect((await b.get()).exists).toBe(false);
		await b.commit(0, "from b");
		expect((await a.get()).doc.objective).toBe("from a");
		expect((await b.get()).doc.objective).toBe("from b");
	});

	test("one installation follows the session id across calls", async () => {
		const pi = fakePi();
		await installPiState(pi, { homeDir, env: {}, log: () => {} });
		const call = (id: string, name: string, params: object) =>
			pi.tools.get(name)!.execute("c", params, undefined, undefined, ctxFor(id));
		await call("session-a", "state_commit", { patch: { objective: "a" }, version: 0 });
		expect(JSON.parse((await call("session-b", "state_get", {})).content[0]!.text).exists).toBe(false);
		expect(JSON.parse((await call("session-a", "state_get", {})).content[0]!.text).doc.objective).toBe("a");
	});

	test("a context without a session id fails the tool call unless statePath is set", async () => {
		const pi = fakePi();
		await installPiState(pi, { homeDir, env: {}, log: () => {} });
		await expect(pi.tools.get("state_get")!.execute("g", {})).rejects.toThrow(/no session id/);
	});

	test("an unusable session id is rejected", async () => {
		for (const sessionId of ["../escape", "..", ".", "", "a/b", "a\\b", "a\0b"]) {
			await expect(resolve({ sessionId })).rejects.toThrow(/not usable/);
		}
	});

	test("an explicit statePath does not touch ctx", async () => {
		const pi = fakePi();
		const statePath = join(projectDir, "explicit.json");
		await installPiState(pi, { homeDir, env: {}, statePath, log: () => {} });
		const ctx = {
			sessionManager: {
				getSessionId: () => {
					throw new Error("unavailable");
				},
			},
		};
		const got = await pi.tools.get("state_get")!.execute("g", {}, undefined, undefined, ctx);
		expect(JSON.parse(got.content[0]!.text).exists).toBe(false);
	});

	test("PI_CODING_AGENT_DIR replaces ~/.pi/agent as the base directory", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", join(homeDir, "agent"));
		const path = await resolve();
		expect(path.startsWith(join(homeDir, "agent", "pi-state") + sep)).toBe(true);
		expect(path).not.toContain(join(".pi", "agent"));
	});

	test("the default base directory is <home>/.pi/agent", async () => {
		expect((await resolve()).startsWith(join(homeDir, ".pi", "agent", "pi-state") + sep)).toBe(true);
	});

	test("a symlinked working directory resolves to the same home file as its target", async () => {
		const link = join(homeDir, "link");
		await symlink(projectDir, link);
		const direct = await resolve();
		process.chdir(link);
		expect(await resolve()).toBe(direct);
	});
});
