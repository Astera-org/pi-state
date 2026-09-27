import { type Schema } from "../agentstate/index.js";
/** The `patch` argument's own schema: the declared key set, closed. */
export declare function patchSchema(schema: Schema): Record<string, unknown>;
/** `state_commit`'s whole input schema: `patch` (schema-derived) plus the CAS `version`. */
export declare function stateCommitInputSchema(schema: Schema): Record<string, unknown>;
//# sourceMappingURL=patchschema.d.ts.map