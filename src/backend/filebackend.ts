// Σ storage as a JSON file in pi's working directory: read, merge (agentstate's `merge`),
// write, a version counter, and a compare-and-set that refuses a stale commit.
//
// CONCURRENCY. Two `pi` sessions may share a working directory. A reader sees either the
// previous complete file or the next complete one, and a stale commit is refused rather
// than lost. Both properties come from one mechanism: a fixed temp path created with an
// exclusive (O_EXCL) flag, written, then renamed onto the real path.
//
//   - The rename is atomic, so a reader never observes a torn write.
//   - The exclusive create is the mutex for the compare-and-set. Concurrent commits open
//     the same temp path and only one `open(..., "wx")` succeeds at a time; the others
//     retry until the winner has renamed the file away. A waiting commit then re-reads
//     the current version under the lock and, if it has moved, is refused as stale.
//
// There is no separate lock file.

import { open, readFile, rename, unlink } from "node:fs/promises";
import { type DocObject, marshal, merge, type Schema, unmarshal } from "../agentstate/index.js";
import { rawJsonMember } from "../stateboundary/statewindow.js";

/** The compare-and-set refusal: a commit decided against a version that has since
 * changed. */
export class StaleStateVersionError extends Error {
	readonly expectedVersion: number;
	readonly storedVersion: number;

	constructor(expectedVersion: number, storedVersion: number) {
		super(
			`commit named version ${expectedVersion} and the stored version is ${storedVersion}: this agent state commit was decided against a version that has since changed — read the current state and retry`,
		);
		this.name = "StaleStateVersionError";
		this.expectedVersion = expectedVersion;
		this.storedVersion = storedVersion;
	}
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

const VERSION_PATTERN = /^[0-9]+$/;

function parseStoredText(text: string): { version: number; doc: DocObject } | null {
	const versionText = rawJsonMember(text, "version");
	const docText = rawJsonMember(text, "doc");
	if (versionText === null || docText === null || !VERSION_PATTERN.test(versionText)) return null;
	try {
		return { version: Number(versionText), doc: unmarshal(docText) };
	} catch {
		return null;
	}
}

/** Reads the state file. A missing or corrupt file (truncated, hand-edited, or not in
 * this backend's format) yields the "before the first commit" shape:
 * `exists: false, version: 0, doc: {}`. */
export async function readFileState(path: string): Promise<StoredState> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { exists: false, version: 0, doc: {} };
	}
	const parsed = parseStoredText(text);
	if (parsed === null) return { exists: false, version: 0, doc: {} };
	return { exists: true, version: parsed.version, doc: parsed.doc };
}

function isEexist(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EEXIST";
}

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Applies `patch` to the document at `path` under `schema`, refusing with
 * StaleStateVersionError if `expectVersion` is not the stored version (a first commit
 * must name 0). Refusals raised by `merge` propagate unchanged. Throws if the write lock
 * cannot be acquired within LOCK_TIMEOUT_MS. */
export async function commitFileState(
	path: string,
	schema: Schema,
	patch: DocObject,
	expectVersion: number,
): Promise<CommitResult> {
	const tmpPath = `${path}.tmp`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(tmpPath, "wx");
		} catch (err) {
			if (isEexist(err)) {
				if (Date.now() > deadline) {
					throw new Error(
						`pi-state: could not acquire the exclusive write lock at ${tmpPath} within ${LOCK_TIMEOUT_MS}ms`,
					);
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
		} finally {
			if (handle !== undefined) {
				await handle.close().catch(() => {});
				await unlink(tmpPath).catch(() => {});
			}
		}
	}
}
