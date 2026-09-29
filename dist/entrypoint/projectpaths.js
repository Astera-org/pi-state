// Home-directory location shared by `resolveSchema` and `resolveStatePath`: a file under
// pi's agent directory, scoped to the project and optionally to a session.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/** Environment variable overriding pi's agent directory. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** pi's agent directory: `$PI_CODING_AGENT_DIR` when set, else `<home>/.pi/agent`. */
function agentDir(homeDir) {
    return process.env[AGENT_DIR_ENV] || join(homeDir ?? homedir(), ".pi", "agent");
}
/** A session id usable as one directory name: no separators, NUL, or `.`/`..`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** First 24 hex digits of the SHA-256 of the symlink-resolved working directory (pi's `cwdKey`). */
async function projectKey() {
    const cwd = await realpath(process.cwd());
    return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}
/**
 * The location of `file` (`schema.json` or `state.json`):
 * `<agentDir>/pi-state/<projectKey>/[<sessionId>/]<file>`.
 * A `sessionId` outside `[A-Za-z0-9][A-Za-z0-9._-]*` throws.
 */
export async function projectPath(file, homeDir, sessionId) {
    if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        throw new Error(`[pi-state] session id ${JSON.stringify(sessionId)} is not usable as a directory name`);
    }
    return join(agentDir(homeDir), "pi-state", await projectKey(), ...(sessionId ? [sessionId] : []), file);
}
//# sourceMappingURL=projectpaths.js.map