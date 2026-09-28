// Tests for the file backend: Σ storage as a JSON file for a standalone extension.
// See src/backend/filebackend.ts.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Schema } from "../src/agentstate/index.js";
import { commitFileState, readFileState, StaleStateVersionError } from "../src/backend/index.js";
import { patch } from "./helpers.js";

const testSchema: Schema = {
	maxStateBytes: 4096,
	keys: {
		objective: { type: "string" },
		step: { type: "number" },
		done: { type: "bool" },
	},
};

let dir: string;
let statePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-state-filebackend-"));
	statePath = join(dir, "state.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readFileState", () => {
	test("a missing file reads as 'before the first commit': exists false, version 0, empty doc", async () => {
		const state = await readFileState(join(dir, "nope.json"));
		expect(state).toEqual({ exists: false, version: 0, doc: {} });
	});

	test("a corrupt file reads the same way rather than throwing", async () => {
		await writeFile(statePath, "not json at all{{{", "utf8");
		const state = await readFileState(statePath);
		expect(state).toEqual({ exists: false, version: 0, doc: {} });

		await writeFile(statePath, '{"version":"oops","doc":{}}', "utf8");
		expect(await readFileState(statePath)).toEqual({ exists: false, version: 0, doc: {} });

		await writeFile(statePath, '{"version":1,"doc":"not an object"}', "utf8");
		expect(await readFileState(statePath)).toEqual({ exists: false, version: 0, doc: {} });
	});

	test("reads back a committed document exactly", async () => {
		await commitFileState(statePath, testSchema, patch(`{"objective":"ship it","step":1}`), 0);
		const state = await readFileState(statePath);
		expect(state.exists).toBe(true);
		expect(state.version).toBe(1);
		expect(state.doc.objective).toBe("ship it");
	});
});

describe("commitFileState", () => {
	test("the first commit must name version 0", async () => {
		let error: unknown;
		try {
			await commitFileState(statePath, testSchema, patch(`{"objective":"x"}`), 1);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(StaleStateVersionError);
		expect((error as StaleStateVersionError).message).toBe(
			"commit named version 1 and the stored version is 0: this agent state commit was decided against a version that has since changed — read the current state and retry",
		);
	});

	test("a correct version advances the counter and merges the patch", async () => {
		const first = await commitFileState(statePath, testSchema, patch(`{"objective":"a"}`), 0);
		expect(first.version).toBe(1);
		const second = await commitFileState(statePath, testSchema, patch(`{"step":2}`), 1);
		expect(second.version).toBe(2);
		expect(second.doc.objective).toBe("a");
		expect(String(second.doc.step)).toBe("2");
	});

	test("a stale version is refused with the CAS error's exact wording, and nothing is written", async () => {
		await commitFileState(statePath, testSchema, patch(`{"objective":"a"}`), 0);
		let error: unknown;
		try {
			await commitFileState(statePath, testSchema, patch(`{"objective":"b"}`), 0);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(StaleStateVersionError);
		expect((error as StaleStateVersionError).message).toBe(
			"commit named version 0 and the stored version is 1: this agent state commit was decided against a version that has since changed — read the current state and retry",
		);
		// The refused commit leaves the stored state unchanged.
		const state = await readFileState(statePath);
		expect(state.version).toBe(1);
		expect(state.doc.objective).toBe("a");
	});

	test("a merge refusal (e.g. an unknown key) propagates and writes nothing", async () => {
		await expect(commitFileState(statePath, testSchema, patch(`{"nope":"x"}`), 0)).rejects.toThrow(/not declared/);
		expect(await readFileState(statePath)).toEqual({ exists: false, version: 0, doc: {} });
	});

	test("two writers racing against the same stale version: exactly one wins, the other is refused", async () => {
		const results = await Promise.allSettled([
			commitFileState(statePath, testSchema, patch(`{"objective":"from-a"}`), 0),
			commitFileState(statePath, testSchema, patch(`{"objective":"from-b"}`), 0),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleStateVersionError);

		// The file is parseable and holds exactly the winner's document.
		const winnerDoc = (fulfilled[0] as PromiseFulfilledResult<{ version: number; doc: Record<string, unknown> }>)
			.value.doc;
		const onDisk = await readFileState(statePath);
		expect(onDisk.version).toBe(1);
		expect(String(onDisk.doc.objective)).toBe(String(winnerDoc.objective));

		const raw = await readFile(statePath, "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	test("five writers racing against the same stale version: exactly one wins", async () => {
		const attempts = Array.from({ length: 5 }, (_, i) =>
			commitFileState(statePath, testSchema, patch(`{"objective":"writer-${i}"}`), 0),
		);
		const results = await Promise.allSettled(attempts);
		expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
		expect(results.filter((r) => r.status === "rejected").length).toBe(4);
		for (const r of results) {
			if (r.status === "rejected") expect(r.reason).toBeInstanceOf(StaleStateVersionError);
		}
		expect((await readFileState(statePath)).version).toBe(1);
	});

	test("no leftover temp file after a race — the lock path is always cleaned up", async () => {
		await Promise.allSettled([
			commitFileState(statePath, testSchema, patch(`{"objective":"a"}`), 0),
			commitFileState(statePath, testSchema, patch(`{"objective":"b"}`), 0),
			commitFileState(statePath, testSchema, patch(`{"objective":"c"}`), 0),
		]);
		await expect(readFile(`${statePath}.tmp`, "utf8")).rejects.toThrow();
	});
});
