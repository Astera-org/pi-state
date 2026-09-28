/**
 * Message-shape-independent tool-cycle pairing. Each call must have exactly one result,
 * each result must name a requested call, and all ids must be usable. Unmatched ids
 * cause provider 400 responses.
 *
 * stateboundary.ts adapts pi messages and renders refusal codes. Refusal text persisted
 * in transcripts is a stable format checked verbatim by external tooling.
 */

/** Why a run of messages cannot be cut into paired cycles. */
export type PairingRefusal =
	/** A result arrived with no call before it to answer. */
	| { code: "stray-result"; at: number }
	/** A call whose id is missing or unusable, so the cycle cannot be verified at all. */
	| { code: "unverifiable-call"; at: number }
	/** A result that names no call. */
	| { code: "result-without-id"; at: number }
	| { code: "answered-twice"; at: number; id: string }
	/** `at` is the ASSISTANT message, because that is where the unanswered call was made. */
	| { code: "unanswered-call"; at: number; id: string }
	/** `at` is the ASSISTANT message the unrequested result followed. */
	| { code: "unrequested-result"; at: number; id: string };

/** One `assistant(calls)` message plus the contiguous run of results answering it. */
export interface PairedCycle {
	start: number;
	/** Inclusive index of the last result in the cycle. */
	end: number;
}

/**
 * What a caller's message shape must answer. Indices refer to the caller's own list, so
 * results address the messages the caller passed in.
 */
export interface PairingShape {
	length: number;
	/** Does the message at `i` answer a call? */
	isResult(i: number): boolean;
	/**
	 * Call ids at `i`; null for no calls, "unverifiable" for a call with an unusable id.
	 * An empty list cannot represent an unusable id: it would accept a zero-result cycle.
	 */
	callIds(i: number): readonly string[] | "unverifiable" | null;
	/** The id the result at `i` answers, or null when it carries none usable. */
	resultId(i: number): string | null;
}

/**
 * Segments messages into cycles with exactly one result per requested call id.
 * Returns a refusal when pairing fails; callers can fall back to Σ alone.
 */
export function pairCycles(shape: PairingShape): { cycles: PairedCycle[] } | { refusal: PairingRefusal } {
	const cycles: PairedCycle[] = [];
	let i = 0;
	while (i < shape.length) {
		if (shape.isResult(i)) return { refusal: { code: "stray-result", at: i } };
		const calls = shape.callIds(i);
		if (calls === null) {
			i++;
			continue;
		}
		if (calls === "unverifiable") return { refusal: { code: "unverifiable-call", at: i } };

		let j = i + 1;
		const answered = new Set<string>();
		while (j < shape.length && shape.isResult(j)) {
			const id = shape.resultId(j);
			if (id === null) return { refusal: { code: "result-without-id", at: j } };
			if (answered.has(id)) return { refusal: { code: "answered-twice", at: j, id } };
			answered.add(id);
			j++;
		}

		for (const id of calls) {
			if (!answered.has(id)) return { refusal: { code: "unanswered-call", at: i, id } };
			answered.delete(id);
		}
		// After the deletes above, the set holds exactly the unrequested ids.
		const extra = answered.values().next();
		if (!extra.done) return { refusal: { code: "unrequested-result", at: i, id: extra.value } };

		cycles.push({ start: i, end: j - 1 });
		i = j;
	}
	return { cycles };
}
