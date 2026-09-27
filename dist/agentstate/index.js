// The pure merge + validation core of an agent's durable working state (Sigma). No I/O:
// it takes a stored document and a patch and answers with the document that should
// replace it, or a refusal naming exactly what was wrong.
export { carriesNothing, isEmptyValue, readCarriage } from "./carriage.js";
export { AgentStateSchemaError, MalformedPatchError, NestedListError, NumberRangeError, TooLargeError, TooManyItemsError, TrailingContentError, TypeMismatchError, UnknownKeyError, } from "./errors.js";
export { JsonNumber } from "./json.js";
export { merge } from "./merge.js";
export { canonicalNumber, MAX_NUMBER_BYTES } from "./number.js";
export { canonicalize, DEFAULT_MAX_STATE_BYTES, declaredGuide, declaredKeys, declaredSummary, declaredTypes, described, fieldSpec, Kind, MAX_DESC_BYTES, MAX_STATE_BYTES_CEILING, marshal, parsePatch, parseSchema, schemaCap, size, unmarshal, validateSchema, } from "./schema.js";
//# sourceMappingURL=index.js.map