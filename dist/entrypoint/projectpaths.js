// Lookup locations shared by `resolveSchema` and `resolveStatePath`: the working
// directory's `.pi-state/<file>`, then a per-project file under the home directory.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/** Directory under the home directory holding one subdirectory per project. */
const HOME_PROJECTS_DIR = ".pi-state/projects";
/** First 16 hex digits of the SHA-256 of the symlink-resolved working directory. */
async function projectKey() {
    const cwd = await realpath(process.cwd());
    return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
/**
 * The lookup locations for `file` (`schema.json` or `state.json`): the path relative to
 * the working directory, and `<home>/.pi-state/projects/<projectKey>/<file>`.
 */
export async function projectPaths(file, homeDir) {
    return {
        cwdPath: join(".pi-state", file),
        homePath: join(homeDir ?? homedir(), HOME_PROJECTS_DIR, await projectKey(), file),
    };
}
//# sourceMappingURL=projectpaths.js.map