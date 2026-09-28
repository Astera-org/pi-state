import { type Schema } from "../agentstate/index.js";
/** A new copy of the built-in schema on every call: `applyAutoMaxStateBytes` writes
 * `maxStateBytes` into the schema it is given, so installs must not share one. */
export declare function defaultSchema(): Schema;
//# sourceMappingURL=defaultschema.d.ts.map