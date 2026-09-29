// Resolves the state file location, following the lookup chain of `loadschema.ts`'s
// `resolveSchema`.

import { access } from "node:fs/promises";
import { projectPaths } from "./projectpaths.js";

export interface ResolveStatePathOptions {
	/** An explicit state file. When set, it is returned unchanged. */
	statePath?: string;
	/** Defaults to `os.homedir()`. Exposed for tests. */
	homeDir?: string;
	log: (message: string) => void;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Finds the state file, in order:
 *
 * 1. `opts.statePath`, when set.
 * 2. `./.pi-state/state.json`, relative to pi's working directory, when it exists.
 * 3. `~/.pi-state/projects/<projectKey>/state.json` (see `projectPaths`), whether or not it exists: a state file that exists in
 *    neither location is created there, never in the working directory.
 *
 * Logs which location was used.
 */
export async function resolveStatePath(opts: ResolveStatePathOptions): Promise<string> {
	if (opts.statePath !== undefined) return opts.statePath;
	const { cwdPath, homePath } = await projectPaths("state.json", opts.homeDir);
	if (await exists(cwdPath)) {
		opts.log(`[pi-state] state: ${cwdPath}`);
		return cwdPath;
	}
	opts.log(`[pi-state] state: ${homePath}`);
	return homePath;
}
