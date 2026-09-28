// JSON parsing and serialization with exact number digits held in JsonNumber.
// canonicalNumber expands exponents before storage. JavaScript numbers round
// 9999999999999999 to 10000000000000000. Trailing JSON values are refused.
import { TrailingContentError } from "./errors.js";
/** A JSON number held as its exact source digits. */
export class JsonNumber {
    constructor(raw) {
        this.raw = raw;
    }
    toString() {
        return this.raw;
    }
}
export function isPlainDocObject(v) {
    return v !== null && typeof v === "object" && !(v instanceof JsonNumber) && !Array.isArray(v);
}
/** The JSON type name used in refusals. */
export function jsonTypeName(v) {
    if (v === null)
        return "null";
    if (typeof v === "boolean")
        return "bool";
    if (v instanceof JsonNumber)
        return "number";
    if (typeof v === "string")
        return "string";
    if (Array.isArray(v))
        return "array";
    return "object";
}
export function quote(s) {
    return JSON.stringify(s);
}
/** Bounds a fragment quoted in an error. */
export function truncate(s, max) {
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}
const encoder = new TextEncoder();
/** The UTF-8 byte length of `s`. */
export function byteLength(s) {
    return encoder.encode(s).length;
}
function isWhitespace(c) {
    return c === " " || c === "\t" || c === "\n" || c === "\r";
}
function skipWhitespace(state) {
    while (isWhitespace(state.text[state.pos]))
        state.pos++;
}
function isDigit(c) {
    return c !== undefined && c >= "0" && c <= "9";
}
function parseValue(state) {
    skipWhitespace(state);
    const c = state.text[state.pos];
    if (c === "{")
        return parseObject(state);
    if (c === "[")
        return parseArray(state);
    if (c === '"')
        return parseString(state);
    if (c === "t")
        return parseLiteral(state, "true", true);
    if (c === "f")
        return parseLiteral(state, "false", false);
    if (c === "n")
        return parseLiteral(state, "null", null);
    if (c === "-" || isDigit(c))
        return parseNumber(state);
    if (c === undefined)
        throw new Error("unexpected end of JSON input");
    throw new Error(`unexpected character ${quote(c)} at position ${state.pos}`);
}
function parseLiteral(state, literal, value) {
    if (state.text.slice(state.pos, state.pos + literal.length) !== literal) {
        throw new Error(`invalid literal at position ${state.pos}`);
    }
    state.pos += literal.length;
    return value;
}
function parseObject(state) {
    state.pos++; // consume '{'
    const out = {};
    skipWhitespace(state);
    if (state.text[state.pos] === "}") {
        state.pos++;
        return out;
    }
    for (;;) {
        skipWhitespace(state);
        if (state.text[state.pos] !== '"') {
            throw new Error(`expected a string key at position ${state.pos}`);
        }
        const key = parseString(state);
        skipWhitespace(state);
        if (state.text[state.pos] !== ":") {
            throw new Error(`expected ':' at position ${state.pos}`);
        }
        state.pos++;
        out[key] = parseValue(state);
        skipWhitespace(state);
        const ch = state.text[state.pos];
        if (ch === ",") {
            state.pos++;
            continue;
        }
        if (ch === "}") {
            state.pos++;
            break;
        }
        throw new Error(`expected ',' or '}' at position ${state.pos}`);
    }
    return out;
}
function parseArray(state) {
    state.pos++; // consume '['
    const out = [];
    skipWhitespace(state);
    if (state.text[state.pos] === "]") {
        state.pos++;
        return out;
    }
    for (;;) {
        out.push(parseValue(state));
        skipWhitespace(state);
        const ch = state.text[state.pos];
        if (ch === ",") {
            state.pos++;
            continue;
        }
        if (ch === "]") {
            state.pos++;
            break;
        }
        throw new Error(`expected ',' or ']' at position ${state.pos}`);
    }
    return out;
}
function parseString(state) {
    const { text } = state;
    let i = state.pos;
    if (text[i] !== '"')
        throw new Error(`expected a string at position ${i}`);
    i++;
    let out = "";
    for (;;) {
        const c = text[i];
        if (c === undefined)
            throw new Error("unterminated string");
        if (c === '"') {
            i++;
            break;
        }
        if (c === "\\") {
            i++;
            const esc = text[i];
            switch (esc) {
                case '"':
                    out += '"';
                    i++;
                    break;
                case "\\":
                    out += "\\";
                    i++;
                    break;
                case "/":
                    out += "/";
                    i++;
                    break;
                case "b":
                    out += "\b";
                    i++;
                    break;
                case "f":
                    out += "\f";
                    i++;
                    break;
                case "n":
                    out += "\n";
                    i++;
                    break;
                case "r":
                    out += "\r";
                    i++;
                    break;
                case "t":
                    out += "\t";
                    i++;
                    break;
                case "u": {
                    const hex = text.slice(i + 1, i + 5);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex))
                        throw new Error(`invalid unicode escape at position ${i - 1}`);
                    out += String.fromCharCode(Number.parseInt(hex, 16));
                    i += 5;
                    break;
                }
                default:
                    throw new Error(`invalid escape \\${esc} at position ${i - 1}`);
            }
            continue;
        }
        if (c.charCodeAt(0) < 0x20)
            throw new Error(`control character in string at position ${i}`);
        out += c;
        i++;
    }
    state.pos = i;
    return out;
}
function parseNumber(state) {
    const { text } = state;
    const start = state.pos;
    let i = start;
    if (text[i] === "-")
        i++;
    if (text[i] === "0") {
        i++;
    }
    else if (isDigit(text[i])) {
        i++;
        while (isDigit(text[i]))
            i++;
    }
    else {
        throw new Error(`invalid number at position ${start}`);
    }
    if (text[i] === ".") {
        i++;
        if (!isDigit(text[i]))
            throw new Error(`invalid number at position ${start}`);
        while (isDigit(text[i]))
            i++;
    }
    if (text[i] === "e" || text[i] === "E") {
        i++;
        if (text[i] === "+" || text[i] === "-")
            i++;
        if (!isDigit(text[i]))
            throw new Error(`invalid number at position ${start}`);
        while (isDigit(text[i]))
            i++;
    }
    state.pos = i;
    return new JsonNumber(text.slice(start, i));
}
/** Rejects a second JSON value after the first. */
function requireEOF(state) {
    skipWhitespace(state);
    if (state.pos >= state.text.length)
        return;
    const start = state.pos;
    try {
        parseValue(state);
    }
    catch (err) {
        throw new TrailingContentError(`the content after it does not parse (${err.message}): expected one JSON value and found more content after it`);
    }
    const second = state.text.slice(start, state.pos);
    throw new TrailingContentError(`a second value (${truncate(second, 40)}) follows the first: expected one JSON value and found more content after it`);
}
/** Parses exactly one JSON value and refuses any content — other than whitespace — after it. */
export function parseJsonDocument(text) {
    const state = { text, pos: 0 };
    const value = parseValue(state);
    requireEOF(state);
    return value;
}
function marshalString(s) {
    let out = '"';
    for (const ch of s) {
        switch (ch) {
            case '"':
                out += '\\"';
                break;
            case "\\":
                out += "\\\\";
                break;
            case "\n":
                out += "\\n";
                break;
            case "\r":
                out += "\\r";
                break;
            case "\t":
                out += "\\t";
                break;
            case "\b":
                out += "\\b";
                break;
            case "\f":
                out += "\\f";
                break;
            default: {
                const code = ch.codePointAt(0) ?? 0;
                out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
            }
        }
    }
    return `${out}"`;
}
/** Compact canonical JSON with object keys sorted at every depth; used to measure the byte cap. */
export function marshalValue(v) {
    if (v === null)
        return "null";
    if (typeof v === "boolean")
        return v ? "true" : "false";
    if (typeof v === "string")
        return marshalString(v);
    if (v instanceof JsonNumber)
        return v.raw;
    if (Array.isArray(v))
        return `[${v.map(marshalValue).join(",")}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${marshalString(k)}:${marshalValue(v[k])}`).join(",")}}`;
}
//# sourceMappingURL=json.js.map