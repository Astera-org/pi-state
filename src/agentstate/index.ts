// The pure merge + validation core of an agent's durable working state (Sigma). No I/O:
// it takes a stored document and a patch and answers with the document that should
// replace it, or a refusal naming exactly what was wrong.

export type { Carriage } from "./carriage.js";
export { carriesNothing, isEmptyValue, readCarriage } from "./carriage.js";
export {
	AgentStateSchemaError,
	MalformedPatchError,
	NestedListError,
	NumberRangeError,
	TooLargeError,
	TooManyItemsError,
	TrailingContentError,
	TypeMismatchError,
	UnknownKeyError,
} from "./errors.js";
export type { DocObject, DocValue } from "./json.js";
export { JsonNumber } from "./json.js";
export { merge } from "./merge.js";
export { canonicalNumber, MAX_NUMBER_BYTES } from "./number.js";
export type { Field, Schema } from "./schema.js";
export {
	canonicalize,
	DEFAULT_AUTO_MAX_STATE_BYTES_CEILING,
	DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT,
	DEFAULT_BYTES_PER_TOKEN,
	DEFAULT_MAX_STATE_BYTES,
	declaredKeys,
	declaredSummary,
	declaredTypes,
	fieldSpec,
	Kind,
	MAX_DESC_BYTES,
	marshal,
	parsePatch,
	parseSchema,
	resolveAutoMaxStateBytes,
	schemaCap,
	size,
	unmarshal,
	validateSchema,
} from "./schema.js";
