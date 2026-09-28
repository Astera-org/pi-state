// Canonicalizes and bounds a JSON number for agent state storage. Numbers are stored in
// exponent-free decimal form, and the byte cap is measured on that form: `1e10000` is 16
// bytes of JSON but expands to 10001 digits.
import { NumberRangeError } from "./errors.js";
import { JsonNumber, truncate } from "./json.js";
/** Bounds the canonical (expanded) form of one number, in bytes. */
export const MAX_NUMBER_BYTES = 64;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
function allDigits(s) {
    if (s.length === 0)
        return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57)
            return false;
    }
    return true;
}
function allZeros(digits) {
    for (let i = 0; i < digits.length; i++) {
        if (digits[i] !== "0")
            return false;
    }
    return true;
}
/** Collapses a leading zero run (which a shift can produce, e.g. `0.10e1` -> `01.0`)
 * to one digit before the point. Trailing zeros in the fraction are kept. */
function trimLeadingZeros(s) {
    let i = 0;
    while (i < s.length - 1 && s[i] === "0" && s[i + 1] !== ".")
        i++;
    return s.slice(i);
}
function isZeroValue(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== "0" && s[i] !== ".")
            return false;
    }
    return true;
}
/** Parses an exponent within signed int64 range; throws NumberRangeError on overflow. */
function parseExponent(raw, expPart) {
    const stripped = expPart.startsWith("+") ? expPart.slice(1) : expPart;
    let big;
    try {
        big = BigInt(stripped);
    }
    catch {
        throw new NumberRangeError(`${truncate(raw, 24)} has an exponent that does not fit in an int: number is too long in the expanded decimal form the state document is stored as`);
    }
    if (big < INT64_MIN || big > INT64_MAX) {
        throw new NumberRangeError(`${truncate(raw, 24)} has an exponent that does not fit in an int: number is too long in the expanded decimal form the state document is stored as`);
    }
    return Number(big);
}
/** Rewrites a JSON number as plain decimal digits, matching what a Postgres `numeric`
 * renders. `raw` is assumed to already be a syntactically valid JSON number (this
 * package's own parser guarantees that grammar). */
function expandDecimal(raw) {
    let s = raw;
    const neg = s.startsWith("-");
    if (neg)
        s = s.slice(1);
    let mantissa = s;
    let expPart = "";
    const eIdx = s.search(/[eE]/);
    if (eIdx >= 0) {
        mantissa = s.slice(0, eIdx);
        expPart = s.slice(eIdx + 1);
    }
    let intPart = mantissa;
    let fracPart = "";
    const dotIdx = mantissa.indexOf(".");
    if (dotIdx >= 0) {
        intPart = mantissa.slice(0, dotIdx);
        fracPart = mantissa.slice(dotIdx + 1);
    }
    if (intPart === "" || !allDigits(intPart) || (fracPart !== "" && !allDigits(fracPart))) {
        throw new Error(`${truncate(raw, 24)} is not a JSON number`);
    }
    const exp = expPart !== "" ? parseExponent(raw, expPart) : 0;
    const digits = intPart + fracPart;
    // Zero with no remaining fractional scale canonicalizes to "0", including negative
    // zero. `0e65` occupies one byte.
    if (allZeros(digits) && intPart.length + exp >= digits.length) {
        return "0";
    }
    // Bound allocation before expansion. The caller checks the final canonical length.
    const slack = MAX_NUMBER_BYTES + digits.length;
    if (exp > slack || exp < -slack) {
        throw new NumberRangeError(`${truncate(raw, 24)} cannot be written in ${MAX_NUMBER_BYTES} bytes of decimal: number is too long in the expanded decimal form the state document is stored as`);
    }
    const point = intPart.length + exp; // digits before the decimal point after shifting
    let built;
    if (point <= 0) {
        built = `0.${"0".repeat(-point)}${digits}`;
    }
    else if (point >= digits.length) {
        built = digits + "0".repeat(point - digits.length);
    }
    else {
        built = `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
    let out = trimLeadingZeros(built);
    if (neg && !isZeroValue(out))
        out = `-${out}`;
    return out;
}
/** Renders a patch number in the expanded decimal form the document is stored as, and
 * refuses one whose canonical form is too long. */
export function canonicalNumber(v) {
    const out = expandDecimal(v.raw);
    if (out.length > MAX_NUMBER_BYTES) {
        throw new NumberRangeError(`${truncate(v.raw, 24)} is ${out.length} bytes in decimal form and the limit is ${MAX_NUMBER_BYTES}: number is too long in the expanded decimal form the state document is stored as`);
    }
    return new JsonNumber(out);
}
//# sourceMappingURL=number.js.map