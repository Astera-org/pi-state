/**
 * Paper mode: the prompt is rebuilt on every model call as [Σ, newest user turn, last N
 * complete tool cycles], and every action must arrive with a `state_commit`. Nothing
 * here calls `replaceTranscript`; pi's transcript is left as is and only the per-call
 * context is projected.
 *
 * Paper terms: P is the system prompt (PAPER_CONTRACT appended), Σ_t is the Σ message,
 * O_t is the trailing cycles.
 */

import { type BoundaryAPI, type BoundaryDeps, boundaryMessages } from "./stateboundary.js";
import {
	isStateCommitToolName,
	quoted,
	type Sigma,
	type StateWindowOff,
	sigmaFromResult,
	stateCommitCache,
	stateWindowSetting,
} from "./statewindow.js";

/** Cycle depth used in paper mode when N is not configured. */
const PAPER_DEFAULT_TOOL_CYCLES = 1;

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

export const PAPER_CONTRACT =
	"You are an execution agent working from a persisted state. You do NOT see earlier turns: " +
	"each model call shows only your durable state Σ (the first message), the user's request, and the latest tool results. " +
	"Everything else has been discarded.\n\n" +
	"Persist everything you will need later (plans, findings, progress, file paths, decisions) with state_commit; nothing else survives. " +
	"state_commit merges a patch onto Σ; a null value deletes a key. Pass the version shown in Σ.\n\n" +
	"Call state_commit in the same message as each action (every other tool call).";

export const PAPER_COMMIT_REQUIRED_REASON = "include a state_commit call in the same message as this action";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** `boundary` for unset or empty, `paper` for `paper`, otherwise the refusal. */
export function stateModeSetting(raw: string | undefined): StateMode | StateWindowOff {
	if (raw === undefined || raw === "" || raw === "boundary") return "boundary";
	if (raw === "paper") return "paper";
	return {
		condition: "state-mode",
		fault: true,
		reason: `mode=${quoted(raw)} is not one of boundary/paper`,
	};
}

function parseRequireCommit(raw: string | undefined): RequireCommit | null {
	if (raw === undefined || raw === "") return "every";
	if (raw === "every" || raw === "off") return raw;
	if (!POSITIVE_INTEGER.test(raw)) return null;
	const k = Number(raw);
	return Number.isSafeInteger(k) ? k : null;
}

/** Paper configuration, or the condition that refused it. The kill switch and cycle parsing are the boundary mode's. */
export function paperSetting(options: PaperOptions): PaperConfig | StateWindowOff {
	const window = stateWindowSetting({
		enabled: true,
		killSwitch: options.killSwitch,
		cycles:
			options.cycles === undefined || options.cycles === "" ? String(PAPER_DEFAULT_TOOL_CYCLES) : options.cycles,
	});
	if ("condition" in window) return window;
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

/** Message shape read here; messages pass through by reference. */
interface PiMessage {
	role?: unknown;
	content?: unknown;
}

const EMPTY_SIGMA: Sigma = { toolCallId: "", text: "", version: 0, versionText: "0", doc: "{}" };

/**
 * [Σ, newest user turn, last N complete cycles]. Σ is `{}` at version 0 before any commit.
 * When the trailing window is dropped (N=0, or it cannot be paired), the newest user
 * turn still follows Σ.
 */
export function paperMessages(
	sigma: Sigma | null,
	cycles: number,
	messages: readonly PiMessage[],
	timestamp: number,
): { messages: PiMessage[]; narrowed?: string } {
	const plan = boundaryMessages(sigma ?? EMPTY_SIGMA, cycles, messages, timestamp);
	const narrowed = plan.narrowed === undefined ? {} : { narrowed: plan.narrowed };
	if (plan.messages.length > 1) return { messages: plan.messages, ...narrowed };
	const newestUser = messages.filter((m) => m.role === "user").at(-1);
	return { messages: newestUser === undefined ? plan.messages : [...plan.messages, newestUser], ...narrowed };
}

function toolCallNames(message: PiMessage): string[] | null {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return null;
	const names = message.content
		.filter(
			(b): b is { type: "toolCall"; name?: unknown } => b !== null && typeof b === "object" && b.type === "toolCall",
		)
		.map((b) => b.name as string);
	return names.length === 0 ? null : names;
}

export interface PaperDeps extends Pick<BoundaryDeps, "sigma" | "now" | "log"> {}

/**
 * Registers the paper-mode handlers: the contract on `before_agent_start`, the projection on
 * `context`, and, unless `requireCommit` is `off`, the commit requirement on `tool_call`,
 * driven by the tool calls of each finalized assistant message (`message_end`).
 */
export function installPaperMode(pi: BoundaryAPI, config: PaperConfig, deps: PaperDeps = {}): void {
	const log = deps.log ?? ((message: string) => console.error(message));
	const sigmaOf = deps.sigma ?? (() => stateCommitCache().latest());
	const now = deps.now ?? Date.now;
	const { requireCommit } = config;

	// Consecutive tool-call messages without a state_commit, and whether the latest one had one.
	let commitless = 0;
	let latestHasCommit = true;

	pi.on("before_agent_start", (event) => {
		commitless = 0;
		latestHasCommit = true;
		return { systemPrompt: `${(event as { systemPrompt: string }).systemPrompt}\n\n${PAPER_CONTRACT}` };
	});

	pi.on("context", (event) => {
		const held = (event as { messages: PiMessage[] }).messages;
		const projected = paperMessages(sigmaFromResult(sigmaOf()), config.cycles, held, now());
		if (projected.narrowed !== undefined) log(`[pi-state] trailing cycles dropped: ${projected.narrowed}`);
		return { messages: projected.messages };
	});

	if (requireCommit === "off") return;

	pi.on("message_end", (event) => {
		const names = toolCallNames((event as { message: PiMessage }).message);
		if (names === null) return undefined;
		latestHasCommit = names.some(isStateCommitToolName);
		commitless = latestHasCommit ? 0 : commitless + 1;
		return undefined;
	});

	pi.on("tool_call", (event) => {
		if (latestHasCommit || isStateCommitToolName((event as { toolName?: unknown }).toolName)) return undefined;
		if (requireCommit !== "every" && commitless < requireCommit) return undefined;
		return { block: true, reason: PAPER_COMMIT_REQUIRED_REASON };
	});
}
