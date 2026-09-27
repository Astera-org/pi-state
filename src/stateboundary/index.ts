// The transcript-boundary delivery of Sigma (Sigma). Bounds an agent's prompt by
// replacing pi's transcript, at the end of a turn that accepted a commit, with
// [Sigma, the newest user turn, N trailing tool cycles] instead of full history.
//
// No environment reads: every caller supplies its own StateWindowOptions, built from
// whatever its own environment variables are named.

export type { PairedCycle, PairingRefusal, PairingShape } from "./pairing.js";
export { pairCycles } from "./pairing.js";
export type {
	BoundaryAPI,
	BoundaryDeps,
	BoundaryPlan,
	StateWindowConfig,
	StateWindowOff,
	StateWindowOptions,
} from "./stateboundary.js";
export {
	boundaryMessages,
	heldMessages,
	installStateBoundary,
	STATE_BOUNDARY_SOURCE,
	segmentCycles,
	sigmaMessage,
	stateBoundaryNotInstalled,
	writeBoundary,
} from "./stateboundary.js";
export type {
	CachedStateCommit,
	Sigma,
	StateWindowCondition,
	StateWindowEntryData,
	StateWindowFailure,
	StateWindowTally,
} from "./statewindow.js";
export {
	DEFAULT_TOOL_CYCLES,
	installStateCommitCache,
	isStateCommitToolName,
	MAX_TOOL_CYCLES,
	newStateCommitCache,
	observeStateCommitResult,
	parseToolCycles,
	rawJsonMember,
	recordStateWindowIntoTranscript,
	resetStateCommitCache,
	resolveStateWindow,
	STATE_COMMIT_DOC_KEY,
	STATE_COMMIT_TOOL_NAMES,
	STATE_COMMIT_VERSION_KEY,
	STATE_WINDOW_ENTRY_TYPE,
	seedStateCommitCache,
	seedStateCommitCacheFromEntries,
	sigmaFromResult,
	stateCommitCache,
	stateWindowPreamble,
	stateWindowSetting,
	toolResultText,
} from "./statewindow.js";
