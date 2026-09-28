/**
 * Message-shape-independent tool-cycle pairing. Each call must have exactly one result,
 * each result must name a requested call, and all ids must be usable. Unmatched ids
 * cause provider 400 responses.
 *
 * stateboundary.ts adapts pi messages and renders refusal codes. Refusal text persisted
 * in transcripts is a stable format checked verbatim by external tooling.
 */
/**
 * Segments messages into cycles with exactly one result per requested call id.
 * Returns a refusal when pairing fails; callers can fall back to Σ alone.
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