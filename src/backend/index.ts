// The file backend: Σ storage as a JSON file in pi's working directory, a standalone
// compare-and-set backend with no external database. See filebackend.ts.

export type { CommitResult, StoredState } from "./filebackend.js";
export { commitFileState, readFileState, StaleStateVersionError } from "./filebackend.js";
