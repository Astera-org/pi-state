// Σ storage as a JSON file in pi's working directory — a standalone compare-and-set
// backend with no external database. Read, merge (agentstate's own `merge`), write, a
// version counter, and a compare-and-set that refuses a stale commit rather than
// overwriting one.
//
// CONCURRENCY. Two `pi` sessions pointed at the same working directory must not be able
// to interleave a write: a reader always sees either the previous complete file or the
// next complete one, and a stale commit is refused rather than silently lost. Both
// properties come from ONE mechanism — a fixed temp path created with an exclusive
// (O_EXCL) flag, written, then renamed onto the real path:
//
//   - the rename is atomic, so a concurrent reader never observes a torn write;
//   - the temp path's O_EXCL create doubles as the mutex a compare-and-set needs. Two
//     commits racing against the same stale version both open the SAME temp path; only
//     one `open(..., "wx")` can succeed at a time, so the loser blocks (retrying) until
//     the winner has renamed its write away and freed the path. By the time the loser
//     gets in, it re-reads the current version under the lock and finds it has moved —
//     a proper stale-version refusal, never a second writer clobbering the first.
//
// No second lock file is needed: the write path IS the mutex.
import { open, readFile, rename, unlink } from "node:fs/promises";
import { marshal, merge, unmarshal } from "../agentstate/index.js";
import { rawJsonMember } from "../stateboundary/statewindow.js";
/** The compare-and-set refusal: a commit decided against a version that has since
 * changed. Worded so an agent's error-handling does not depend on which backend sits
 * underneath it. */
export class StaleStateVersionError extends Error {
    constructor(expectedVersion, storedVersion) {
        super(`commit named version ${expectedVersion} and the stored version is ${storedVersion}: this agent state commit was decided against a version that has since changed — read the current state and retry`);
        this.name = "StaleStateVersionError";
        this.expectedVersion = expectedVersion;
        this.storedVersion = storedVersion;
    }
}
const VERSION_PATTERN = /^[0-9]+$/;
function parseStoredText(text) {
    const versionText = rawJsonMember(text, "version");
    const docText = rawJsonMember(text, "doc");
    if (versionText === null || docText === null || !VERSION_PATTERN.test(versionText))
        return null;
    try {
        return { version: Number(versionText), doc: unmarshal(docText) };
    }
    catch {
        return null;
    }
}
/** Reads the state file, or the "before the first commit" shape `state_get` documents
 * when it is missing OR corrupt: `exists: false, version: 0, doc: {}`. A file this
 * backend never wrote (truncated, hand-edited, from an incompatible version) is not
 * distinguished from a missing one — both mean there is nothing yet to trust. */
export async function readFileState(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return { exists: false, version: 0, doc: {} };
    }
    const parsed = parseStoredText(text);
    if (parsed === null)
        return { exists: false, version: 0, doc: {} };
    return { exists: true, version: parsed.version, doc: parsed.doc };
}
function isEexist(err) {
    return typeof err === "object" && err !== null && err.code === "EEXIST";
}
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Applies `patch` to the document at `path` under `schema`, refusing if `expectVersion`
 * is not the stored version (a first commit must name 0, same as an absent file). Every
 * refusal `merge` itself can raise (unknown key, type mismatch, over the byte cap, ...)
 * propagates unchanged; this layer adds only the compare-and-set and the write. */
export async function commitFileState(path, schema, patch, expectVersion) {
    const tmpPath = `${path}.tmp`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        let handle;
        try {
            handle = await open(tmpPath, "wx");
        }
        catch (err) {
            if (isEexist(err)) {
                if (Date.now() > deadline) {
                    throw new Error(`pi-state: could not acquire the exclusive write lock at ${tmpPath} within ${LOCK_TIMEOUT_MS}ms`);
                }
                await sleep(LOCK_RETRY_MS);
                continue;
            }
            throw err;
        }
        try {
            const current = await readFileState(path);
            if (current.version !== expectVersion) {
                throw new StaleStateVersionError(expectVersion, current.version);
            }
            const merged = merge(current.doc, patch, schema);
            const nextVersion = current.version + 1;
            await handle.writeFile(`{"version":${nextVersion},"doc":${marshal(merged)}}`, "utf8");
            await handle.close();
            handle = undefined;
            await rename(tmpPath, path);
            return { version: nextVersion, doc: merged };
        }
        finally {
            if (handle !== undefined) {
                await handle.close().catch(() => { });
                await unlink(tmpPath).catch(() => { });
            }
        }
    }
}
//# sourceMappingURL=filebackend.js.map