/**
 * Tool-cycle pairing rule, independent of message shape.
 *
 * A bounded prompt is cut on cycle boundaries, and a cycle may only be cut out if it is
 * fully paired: every call the assistant made is answered exactly once, no result answers a
 * call that was not requested, and every result carries an id. An unmatched `tool_call_id`
 * in the outgoing messages is a provider 400.
 *
 * The caller is `stateboundary.ts`, over pi's native message shape. The rule lives in its own
 * file so `pairing.test.ts` can exercise it through a synthetic shape (`c` makes calls, `r`
 * answers one) without a shape adapter.
 *
 * A refusal is a code, not a sentence: each caller renders it in its own vocabulary
 * (`toolCallId` for pi's field name). The rendered text is a stable format once written to
 * pi's transcript.
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
	 * The call ids the message at `i` asks for: `null` when it asks for none (so it is not the
	 * head of a cycle), `"unverifiable"` when it makes a call whose id cannot be read.
	 *
	 * `"unverifiable"` is distinct from an empty list: with no ids to iterate, the arity check
	 * below reduces to `0 !== 0` and a malformed cycle would pass.
	 */
	callIds(i: number): readonly string[] | "unverifiable" | null;
	/** The id the result at `i` answers, or null when it carries none usable. */
	resultId(i: number): string | null;
}

/**
 * Segment a run of messages into complete tool cycles, refusing anything not fully paired.
 *
 * Matching is on the id set: an assistant message can carry N calls, and every one must be
 * answered by exactly one result.
 *
 * A refusal is not an error. It means a paired window cannot be proven cuttable from these
 * messages; the caller falls back to a form that needs no pairing.
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
