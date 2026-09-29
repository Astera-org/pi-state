// `desc` reaches the model as each `patch` property's `description`.

import { expect, test } from "vitest";
import { declaredKeys, parseSchema } from "../src/agentstate/index.js";
import { defaultSchema } from "../src/entrypoint/defaultschema.js";
import { stateCommitInputSchema } from "../src/entrypoint/patchschema.js";

function patchProperties(schema: ReturnType<typeof parseSchema>): Record<string, Record<string, unknown>> {
	const input = stateCommitInputSchema(schema) as { properties: { patch: { properties: never } } };
	return input.properties.patch.properties;
}

test("each described key's patch property carries its desc as description", () => {
	const props = patchProperties(
		parseSchema(
			`{"keys":{"objective":{"type":"string","desc":"what the change must achieve"},` +
				`"files":{"type":"object","desc":"path → why it was touched"}}}`,
		),
	);
	expect(props.objective.description).toBe("what the change must achieve");
	expect(props.files.description).toBe("path → why it was touched");
});

test("a key without desc has no description", () => {
	const props = patchProperties(parseSchema(`{"keys":{"notes":{"type":"list","maxItems":3}}}`));
	expect("description" in props.notes).toBe(false);
});

test("every default-schema key carries a description", () => {
	const schema = defaultSchema();
	const props = patchProperties(schema);
	const names = declaredKeys(schema);
	expect(names).toHaveLength(8);
	for (const name of names) expect(props[name].description).toBe(schema.keys[name].desc);
});
