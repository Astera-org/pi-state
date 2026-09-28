/**
 * ONE tool-cycle pairing rule, stated apart from any message shape.
 *
 * A bounded prompt is cut on cycle boundaries, and a cycle may only be cut out if it is
 * already fully paired: every call this assistant made is answered, none twice, none by a
 * result it did not request, and no result arrives without an id. An unmatched
 * `tool_call_id` in what goes out is a provider 400, not a smaller prompt.
 *
 * THERE IS ONE CALLER TODAY — `stateboundary.ts`, over pi's native message shape. This rule
 * was extracted from two copies (the second was a `statewindow.ts` fetch
 * wrapper's, over the openai-completions wire shape a request rewrite saw). That second
 * delivery mechanism was later retired along with its adapter. So the "two shapes"
 * this file was extracted for are now one.
 *
 * IT IS STILL ITS OWN FILE, and the reason is a testing seam rather than a second caller.
 * `pairing.test.ts` drives the rule through a synthetic three-question shape — `c` makes
 * calls, `r` answers one — so a rule bug is caught without going through anybody's adapter,
 * and two review findings from the module's history stay pinned as named cases: a cycle
 * accepted on "at least one result followed", and an id-less call with zero results let
 * through. Inlining the rule into `stateboundary.ts` would put that coverage behind the
 * pi-native adapter, which the adapter table in `stateboundary.test.ts` covers separately.
 * The two failure modes stay separable: an adapter bug misreads one shape, a rule bug is
 * wrong for every shape at once.
 *
 * THE REFUSAL IS A CODE, NOT A SENTENCE. Each caller renders it in its own vocabulary —
 * `toolCallId` is pi's field name, `tool_call_id` was the retired wire's — because the
 * rendered text is itself a captured format once it reaches pi's transcript: existing
 * tooling asserts specific wording verbatim, so a caller's rendering is not free to drift
 * once written. The core decides WHAT is wrong; the caller says it in its own words. A
 * second shape would add an adapter here, not a second rule.
 */
/**
 * Segment a run of messages into complete tool cycles, refusing anything not already fully
 * paired.
 *
 * THE MATCH IS ON THE ID SET, not on "at least one result arrived". An assistant message can
 * carry N calls, so a run of fewer results than calls is a cycle whose cut would send a call
 * nothing answers.
 *
 * A refusal is not an error. It means a paired window cannot be PROVEN cuttable out of these
 * messages, and each caller has its own safe fallback: a request rewriter would forward the
 * original body, and the transcript boundary keeps Σ alone, which needs no pairing.
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
        // Whatever is left answered a call this assistant never made. Checked AFTER the deletes,
        // so the set holds exactly the unrequested ids.
        const extra = answered.values().next();
        if (!extra.done)
            return { refusal: { code: "unrequested-result", at: i, id: extra.value } };
        cycles.push({ start: i, end: j - 1 });
        i = j;
    }
    return { cycles };
}
//# sourceMappingURL=pairing.js.map