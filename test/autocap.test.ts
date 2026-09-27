// Unit tests for entrypoint/autocap.ts: the layer that resolves auto sizing (the
// default for a schema with no maxStateBytes) into a concrete maxStateBytes from
// whatever this entrypoint can learn about pi's active model (or the env-var stopgap
// when it can't).

import { describe, expect, test } from "vitest";
import type { Schema } from "../src/agentstate/index.js";
import {
	applyAutoMaxStateBytes,
	contextWindowFromModelHolder,
	contextWindowTokensFromEnv,
} from "../src/entrypoint/autocap.js";

describe("contextWindowTokensFromEnv", () => {
	test("reads a positive integer", () => {
		expect(contextWindowTokensFromEnv({ PI_STATE_CONTEXT_WINDOW_TOKENS: "200000" })).toBe(200000);
	});

	test("floors a fractional value", () => {
		expect(contextWindowTokensFromEnv({ PI_STATE_CONTEXT_WINDOW_TOKENS: "200000.7" })).toBe(200000);
	});

	test.each([
		["unset", {}],
		["empty", { PI_STATE_CONTEXT_WINDOW_TOKENS: "" }],
		["zero", { PI_STATE_CONTEXT_WINDOW_TOKENS: "0" }],
		["negative", { PI_STATE_CONTEXT_WINDOW_TOKENS: "-1" }],
		["not a number", { PI_STATE_CONTEXT_WINDOW_TOKENS: "lots" }],
	])("is undefined when %s", (_name, env) => {
		expect(contextWindowTokensFromEnv(env)).toBeUndefined();
	});
});

describe("contextWindowFromModelHolder", () => {
	test("reads .model.contextWindow off an ExtensionContext-shaped value (session_start)", () => {
		expect(contextWindowFromModelHolder({ model: { contextWindow: 128000 } })).toBe(128000);
	});

	test("reads .model.contextWindow off a ModelSelectEvent-shaped value directly", () => {
		expect(contextWindowFromModelHolder({ model: { contextWindow: 64000 }, source: "set" })).toBe(64000);
	});

	test.each([
		["no model", {}],
		["a null model", { model: null }],
		["a model with no contextWindow", { model: {} }],
		["a non-numeric contextWindow", { model: { contextWindow: "big" } }],
		["a zero contextWindow", { model: { contextWindow: 0 } }],
		["a negative contextWindow", { model: { contextWindow: -1 } }],
		["a non-object value", "not an object"],
		["null", null],
	])("is undefined given %s", (_name, value) => {
		expect(contextWindowFromModelHolder(value)).toBeUndefined();
	});
});

describe("applyAutoMaxStateBytes", () => {
	// Auto sizing is the DEFAULT for a schema with no maxStateBytes — not an opt-in — so
	// the bare `{ keys: {} }` schema below is already "auto", exactly like a real
	// schema file that says nothing about its cap.
	function autoSchema(overrides: Partial<Schema> = {}): Schema {
		return { keys: {}, ...overrides };
	}

	test("resolves maxStateBytes from the context window at the default percent", () => {
		const schema = autoSchema();
		const logs: string[] = [];
		applyAutoMaxStateBytes(schema, undefined, 200000, (m) => logs.push(m));
		expect(schema.maxStateBytes).toBe(520000); // 65% of 200000 tokens * 4 bytes/token
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("520000 bytes");
	});

	test("an explicit autoMaxStateBytesPercent overrides the default", () => {
		const schema = autoSchema({ autoMaxStateBytesPercent: 50 });
		applyAutoMaxStateBytes(schema, undefined, 200000, () => {});
		expect(schema.maxStateBytes).toBe(400000);
	});

	test("no-ops when the schema file itself declared an explicit maxStateBytes", () => {
		const schema = autoSchema({ maxStateBytes: 4096 });
		const logs: string[] = [];
		applyAutoMaxStateBytes(schema, 4096, 200000, (m) => logs.push(m));
		expect(schema.maxStateBytes).toBe(4096);
		expect(logs).toHaveLength(0);
	});

	test("no-ops when the context window is unresolved", () => {
		const schema = autoSchema();
		applyAutoMaxStateBytes(schema, undefined, undefined, () => {});
		expect(schema.maxStateBytes).toBeUndefined();
	});

	test("recomputes and logs again when a later, different context window arrives", () => {
		const schema = autoSchema();
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		applyAutoMaxStateBytes(schema, undefined, 100000, log); // install-time env-var guess
		applyAutoMaxStateBytes(schema, undefined, 200000, log); // live session_start report
		expect(schema.maxStateBytes).toBe(520000);
		expect(logs).toHaveLength(2);
	});

	test("is a silent no-op (no re-log) when called again with the same context window", () => {
		const schema = autoSchema();
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		applyAutoMaxStateBytes(schema, undefined, 200000, log);
		applyAutoMaxStateBytes(schema, undefined, 200000, log);
		expect(logs).toHaveLength(1);
	});
});
