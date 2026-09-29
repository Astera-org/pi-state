// The file backend: Σ storage as a JSON file at a caller-supplied path, with
// compare-and-set commits. See filebackend.ts.

export type { CommitResult, StoredState } from "./filebackend.js";
export { commitFileState, readFileState, StaleStateVersionError } from "./filebackend.js";
