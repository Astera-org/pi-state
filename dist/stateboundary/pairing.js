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
/**
 * Segment a run of messages into complete tool cycles, refusing anything not fully paired.
 *
 * Matching is on the id set: an assistant message can carry N calls, and every one must be
 * answered by exactly one result.
 *
 * A refusal is not an error. It means a paired window cannot be proven cuttable from these
 * messages; the caller falls back to a form that needs no pairing.
 */
export function pairCycles(shape) {
    const cycles = [];
    let i = 0;
    while (i < shape.length) {
        if (shape.isResult(i))
            return { refusal: { code: "stray-result", at: i } };
        const calls = shape.callIds(i);
        if (calls === null) {
            i++;
            continue;
        }
        if (calls === "unverifiable")
            return { refusal: { code: "unverifiable-call", at: i } };
        let j = i + 1;
        const answered = new Set();
        while (j < shape.length && shape.isResult(j)) {
            const id = shape.resultId(j);
            if (id === null)
                return { refusal: { code: "result-without-id", at: j } };
            if (answered.has(id))
                return { refusal: { code: "answered-twice", at: j, id } };
            answered.add(id);
            j++;
        }
        for (const id of calls) {
            if (!answered.has(id))
                return { refusal: { code: "unanswered-call", at: i, id } };
            answered.delete(id);
        }
        // After the deletes above, the set holds exactly the unrequested ids.
        const extra = answered.values().next();
        if (!extra.done)
            return { refusal: { code: "unrequested-result", at: i, id: extra.value } };
        cycles.push({ start: i, end: j - 1 });
        i = j;
    }
    return { cycles };
}
//# sourceMappingURL=pairing.js.map