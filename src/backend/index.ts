// The file backend: Σ storage as a JSON file in pi's working directory, replacing
// sproot's Postgres CAS backend for a standalone extension. See filebackend.ts.

export type { CommitResult, StoredState } from "./filebackend.js";
export { commitFileState, readFileState, StaleStateVersionError } from "./filebackend.js";
