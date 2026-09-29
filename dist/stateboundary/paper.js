/**
 * Paper mode: the prompt is rebuilt on every model call as [Σ, newest user turn, last N
 * complete tool cycles], and every action must arrive with a `state_commit`. Nothing
 * here calls `replaceTranscript`; pi's transcript is left as is and only the per-call
 * context is projected.
 *
 * Paper terms: P is the system prompt (PAPER_CONTRACT appended), Σ_t is the Σ message,
 * O_t is the trailing cycles.
 */
import { boundaryMessages } from "./stateboundary.js";
import { isStateCommitToolName, quoted, sigmaFromResult, stateCommitCache, stateWindowSetting, } from "./statewindow.js";
/** Cycle depth used in paper mode when N is not configured. */
const PAPER_DEFAULT_TOOL_CYCLES = 1;
export const PAPER_CONTRACT = "You are an execution agent working from a persisted state. You do NOT see earlier turns: " +
    "each model call shows only your durable state Σ (the first message), the user's request, and the latest tool results. " +
    "Everything else has been discarded.\n\n" +
    "Persist everything you will need later (plans, findings, progress, file paths, decisions) with state_commit; nothing else survives. " +
    "state_commit merges a patch onto Σ; a null value deletes a key. Pass the version shown in Σ.\n\n" +
    "Call state_commit in the same message as each action (every other tool call).";
export const PAPER_COMMIT_REQUIRED_REASON = "include a state_commit call in the same message as this action";
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
/** `paper` for unset, empty or `paper`, `boundary` for `boundary`, otherwise the refusal. */
export function stateModeSetting(raw) {
    if (raw === undefined || raw === "" || raw === "paper")
        return "paper";
    if (raw === "boundary")
        return "boundary";
    return {
        condition: "state-mode",
        fault: true,
        reason: `mode=${quoted(raw)} is not one of boundary/paper`,
    };
}
function parseRequireCommit(raw) {
    if (raw === undefined || raw === "")
        return "every";
    if (raw === "every" || raw === "off")
        return raw;
    if (!POSITIVE_INTEGER.test(raw))
        return null;
    const k = Number(raw);
    return Number.isSafeInteger(k) ? k : null;
}
/** Paper configuration, or the condition that refused it. The kill switch and cycle parsing are the boundary mode's. */
export function paperSetting(options) {
    const window = stateWindowSetting({
        enabled: true,
        killSwitch: options.killSwitch,
        cycles: options.cycles === undefined || options.cycles === "" ? String(PAPER_DEFAULT_TOOL_CYCLES) : options.cycles,
    });
    if ("condition" in window)
        return window;
    const requireCommit = parseRequireCommit(options.requireCommit);
    if (requireCommit === null) {
        return {
            condition: "require-commit",
            fault: true,
            reason: `requireCommit=${quoted(options.requireCommit)} is not one of every/off or a positive integer`,
        };
    }
    return { cycles: window.cycles, requireCommit };
}
const EMPTY_SIGMA = { toolCallId: "", text: "", version: 0, versionText: "0", doc: "{}" };
/**
 * [Σ, newest user turn, last N complete cycles]. Σ is `{}` at version 0 before any commit.
 * When the trailing window is dropped (N=0, or it cannot be paired), the newest user
 * turn still follows Σ.
 */
export function paperMessages(sigma, cycles, messages, timestamp) {
    const plan = boundaryMessages(sigma ?? EMPTY_SIGMA, cycles, messages, timestamp);
    const narrowed = plan.narrowed === undefined ? {} : { narrowed: plan.narrowed };
    if (plan.messages.length > 1)
        return { messages: plan.messages, ...narrowed };
    const newestUser = messages.filter((m) => m.role === "user").at(-1);
    return { messages: newestUser === undefined ? plan.messages : [...plan.messages, newestUser], ...narrowed };
}
function toolCallNames(message) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return null;
    const names = message.content
        .filter((b) => b !== null && typeof b === "object" && b.type === "toolCall")
        .map((b) => b.name);
    return names.length === 0 ? null : names;
}
/**
 * Registers the paper-mode handlers: the contract on `before_agent_start`, the projection on
 * `context`, and, unless `requireCommit` is `off`, the commit requirement on `tool_call`,
 * driven by the tool calls of each finalized assistant message (`message_end`).
 */
export function installPaperMode(pi, config, deps = {}) {
    const log = deps.log ?? ((message) => console.error(message));
    const sigmaOf = deps.sigma ?? (() => stateCommitCache().latest());
    const now = deps.now ?? Date.now;
    const { requireCommit } = config;
    // Consecutive tool-call messages without a state_commit, and whether the latest one had one.
    let commitless = 0;
    let latestHasCommit = true;
    pi.on("before_agent_start", (event) => {
        commitless = 0;
        latestHasCommit = true;
        return { systemPrompt: `${event.systemPrompt}\n\n${PAPER_CONTRACT}` };
    });
    pi.on("context", (event) => {
        const held = event.messages;
        const projected = paperMessages(sigmaFromResult(sigmaOf()), config.cycles, held, now());
        if (projected.narrowed !== undefined)
            log(`[pi-state] trailing cycles dropped: ${projected.narrowed}`);
        return { messages: projected.messages };
    });
    if (requireCommit === "off")
        return;
    pi.on("message_end", (event) => {
        const names = toolCallNames(event.message);
        if (names === null)
            return undefined;
        latestHasCommit = names.some(isStateCommitToolName);
        commitless = latestHasCommit ? 0 : commitless + 1;
        return undefined;
    });
    pi.on("tool_call", (event) => {
        if (latestHasCommit || isStateCommitToolName(event.toolName))
            return undefined;
        if (requireCommit !== "every" && commitless < requireCommit)
            return undefined;
        return { block: true, reason: PAPER_COMMIT_REQUIRED_REASON };
    });
}
//# sourceMappingURL=paper.js.map