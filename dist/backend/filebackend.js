// Versioned JSON file storage with compare-and-set commits.
// A fixed temp path, created with O_EXCL, serializes concurrent writers. Each writer
// re-reads the version under the lock and refuses stale commits. Atomic rename
// ensures readers see a complete file. The temp file also serves as the lock.
import { open, readFile, rename, unlink } from "node:fs/promises";
import { marshal, merge, unmarshal } from "../agentstate/index.js";
import { rawJsonMember } from "../stateboundary/statewindow.js";
/** The compare-and-set refusal: a commit decided against a version that has since
 * changed. */
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
/** Reads the state file. A missing or corrupt file (truncated, hand-edited, or not in
 * this backend's format) yields the "before the first commit" shape:
 * `exists: false, version: 0, doc: {}`. */
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
/** Applies `patch` to the document at `path` under `schema`, refusing with
 * StaleStateVersionError if `expectVersion` is not the stored version (a first commit
 * must name 0). Refusals raised by `merge` propagate unchanged. Throws if the write lock
 * cannot be acquired within LOCK_TIMEOUT_MS. */
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