import { type DocObject, type Schema } from "../agentstate/index.js";
/** The compare-and-set refusal: a commit decided against a version that has since
 * changed. */
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
/** Reads the state file. A missing or corrupt file (truncated, hand-edited, or not in
 * this backend's format) yields the "before the first commit" shape:
 * `exists: false, version: 0, doc: {}`. */
export declare function readFileState(path: string): Promise<StoredState>;
/** Applies `patch` to the document at `path` under `schema`, refusing with
 * StaleStateVersionError if `expectVersion` is not the stored version (a first commit
 * must name 0). Refusals raised by `merge` propagate unchanged. Throws if the write lock
 * cannot be acquired within LOCK_TIMEOUT_MS. */
export declare function commitFileState(path: string, schema: Schema, patch: DocObject, expectVersion: number): Promise<CommitResult>;
//# sourceMappingURL=filebackend.d.ts.map