import { type DocObject, type Schema } from "../agentstate/index.js";
/** The compare-and-set refusal, worded exactly like sproot's `store.ErrAgentStateStaleVersion`
 * (internal/store/memory_agentstate.go, postgres_agentstate.go) — so an agent's error-handling
 * does not depend on which backend sits underneath it. */
export declare class StaleStateVersionError extends Error {
    readonly expectedVersion: number;
    readonly storedVersion: number;
    constructor(expectedVersion: number, storedVersion: number);
}
export interface StoredState {
    exists: boolean;
    version: number;
    doc: DocObject;
}
export interface CommitResult {
    version: number;
    doc: DocObject;
}
/** Reads the state file, or the "before the first commit" shape `state_get` documents
 * when it is missing OR corrupt: `exists: false, version: 0, doc: {}`. A file this
 * backend never wrote (truncated, hand-edited, from an incompatible version) is not
 * distinguished from a missing one — both mean there is nothing yet to trust. */
export declare function readFileState(path: string): Promise<StoredState>;
/** Applies `patch` to the document at `path` under `schema`, refusing if `expectVersion`
 * is not the stored version (a first commit must name 0, same as an absent file). Every
 * refusal `merge` itself can raise (unknown key, type mismatch, over the byte cap, ...)
 * propagates unchanged; this layer adds only the compare-and-set and the write. */
export declare function commitFileState(path: string, schema: Schema, patch: DocObject, expectVersion: number): Promise<CommitResult>;
//# sourceMappingURL=filebackend.d.ts.map