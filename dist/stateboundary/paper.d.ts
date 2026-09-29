/**
 * Paper mode: the prompt is rebuilt on every model call as [Σ, newest user turn, last N
 * complete tool cycles], and every action must arrive with a `state_commit`. Nothing
 * here calls `replaceTranscript`; pi's transcript is left as is and only the per-call
 * context is projected.
 *
 * Paper terms: P is the system prompt (PAPER_CONTRACT appended), Σ_t is the Σ message,
 * O_t is the trailing cycles.
 */
import { type BoundaryAPI, type BoundaryDeps } from "./stateboundary.js";
import { type Sigma, type StateWindowOff } from "./statewindow.js";
export type StateMode = "boundary" | "paper";
/** `every`: each commit-less message blocks. `off`: never. A number K: blocks once K consecutive messages had no commit. */
export type RequireCommit = "every" | "off" | number;
export interface PaperConfig {
    cycles: number;
    requireCommit: RequireCommit;
}
/** Raw spellings, as read from the environment. */
export interface PaperOptions {
    killSwitch?: string;
    cycles?: string;
    requireCommit?: string;
}
export declare const PAPER_CONTRACT: string;
export declare const PAPER_COMMIT_REQUIRED_REASON = "include a state_commit call in the same message as this action";
/** `boundary` for unset or empty, `paper` for `paper`, otherwise the refusal. */
export declare function stateModeSetting(raw: string | undefined): StateMode | StateWindowOff;
/** Paper configuration, or the condition that refused it. The kill switch and cycle parsing are the boundary mode's. */
export declare function paperSetting(options: PaperOptions): PaperConfig | StateWindowOff;
/** Message shape read here; messages pass through by reference. */
interface PiMessage {
    role?: unknown;
    content?: unknown;
}
/**
 * [Σ, newest user turn, last N complete cycles]. Σ is `{}` at version 0 before any commit.
 * When the trailing window is dropped (N=0, or it cannot be paired), the newest user
 * turn still follows Σ.
 */
export declare function paperMessages(sigma: Sigma | null, cycles: number, messages: readonly PiMessage[], timestamp: number): {
    messages: PiMessage[];
    narrowed?: string;
};
export interface PaperDeps extends Pick<BoundaryDeps, "sigma" | "now" | "log"> {
}
/**
 * Registers the paper-mode handlers: the contract on `before_agent_start`, the projection on
 * `context`, and, unless `requireCommit` is `off`, the commit requirement on `tool_call`,
 * driven by the tool calls of each finalized assistant message (`message_end`).
 */
export declare function installPaperMode(pi: BoundaryAPI, config: PaperConfig, deps?: PaperDeps): void;
export {};
//# sourceMappingURL=paper.d.ts.map