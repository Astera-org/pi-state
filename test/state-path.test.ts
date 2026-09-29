// The state path lookup chain: explicit statePath, ./.pi-state/state.json (when it
// exists), then ~/.pi-state/state.json (created when absent).

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installPiState, type PiExtensionAPI, type PiToolDefinition } from "../src/entrypoint/index.js";
import { projectPaths } from "../src/entrypoint/projectpaths.js";
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

async function writeState(root: string, version: number): Promise<void> {
	await mkdir(join(root, ".pi-state"), { recursive: true });
	await writeFile(join(root, ".pi-state", "state.json"), `{"version":${version},"doc":{}}`, "utf8");
}

const scopedHomeState = async () => (await projectPaths("state.json", homeDir)).homePath;

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
});

afterEach(async () => {
	process.chdir(originalCwd);
	await rm(projectDir, { recursive: true, force: true });
	await rm(homeDir, { recursive: true, force: true });
});

const resolve = (extra: { statePath?: string } = {}) =>
	resolveStatePath({ homeDir, log: (m) => logs.push(m), ...extra });

async function installedTools(extra: { statePath?: string } = {}) {
	const pi = fakePi();
	await installPiState(pi, { homeDir, env: {}, log: (m) => logs.push(m), ...extra });
	const get = async () => JSON.parse((await pi.tools.get("state_get")!.execute("g", {})).content[0]!.text);
	const commit = (version: number) =>
		pi.tools.get("state_commit")!.execute("c", { patch: { objective: "x" }, version });
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

	test("the working-directory file is used when it exists", async () => {
		await writeState(projectDir, 3);
		await writeHomeState(7);
		expect(await resolve()).toBe(".pi-state/state.json");
		expect(logs[0]).not.toContain(homeDir);
		expect((await (await installedTools()).get()).version).toBe(3);
	});

	test("the home file is used when only it exists", async () => {
		await writeHomeState(7);
		expect(await resolve()).toBe(await scopedHomeState());
		expect((await (await installedTools()).get()).version).toBe(7);
	});

	test("an explicit statePath is used unconditionally", async () => {
		await writeState(projectDir, 3);
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
			expect(dirname(dirname(second))).toBe(dirname(dirname(first)));
			process.chdir(projectDir);
			expect(await resolve()).toBe(first);
		} finally {
			process.chdir(projectDir);
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	test("a symlinked working directory resolves to the same home file as its target", async () => {
		const link = join(homeDir, "link");
		await symlink(projectDir, link);
		const direct = await resolve();
		process.chdir(link);
		expect(await resolve()).toBe(direct);
	});

	test("state written for one working directory is not read from another", async () => {
		await (await installedTools()).commit(0);
		const otherDir = await mkdtemp(join(tmpdir(), "pi-state-project-"));
		try {
			process.chdir(otherDir);
			expect((await (await installedTools()).get()).exists).toBe(false);
		} finally {
			process.chdir(projectDir);
			await rm(otherDir, { recursive: true, force: true });
		}
	});
});
