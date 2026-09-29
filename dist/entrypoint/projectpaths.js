// Lookup locations shared by `resolveSchema` and `resolveStatePath`: the working
// directory's `.pi-state/<file>`, then a file under pi's agent directory, scoped to the project and optionally to a session.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
/** Environment variable overriding pi's agent directory. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** pi's agent directory: `$PI_CODING_AGENT_DIR` when set, else `<home>/.pi/agent`. */
function agentDir(homeDir) {
    return process.env[AGENT_DIR_ENV] || join(homeDir ?? homedir(), ".pi", "agent");
}
/** First 24 hex digits of the SHA-256 of the symlink-resolved working directory (pi's `cwdKey`). */
async function projectKey() {
    const cwd = await realpath(process.cwd());
    return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}
/**
 * The lookup locations for `file` (`schema.json` or `state.json`): the path relative to
 * the working directory, and `<agentDir>/pi-state/<projectKey>/[<sessionId>/]<file>`.
 * A `sessionId` that is not a single path segment throws.
 */
export async function projectPaths(file, homeDir, sessionId) {
    if (sessionId !== undefined && (sessionId === "" || sessionId === ".." || basename(sessionId) !== sessionId)) {
        throw new Error(`[pi-state] session id ${JSON.stringify(sessionId)} is not usable as a directory name`);
    }
    return {
        cwdPath: join(".pi-state", file),
        homePath: join(agentDir(homeDir), "pi-state", await projectKey(), ...(sessionId ? [sessionId] : []), file),
    };
}
//# sourceMappingURL=projectpaths.js.map