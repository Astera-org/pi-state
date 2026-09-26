// A JSON reader/writer that never routes a number through `JSON.parse`/`JSON.stringify`
// or the JS `number` type: `9999999999999999` would silently become `10000000000000000`,
// and a document sized right at the byte cap would come back a byte over. Every number is
// kept as the exact source digits (mirroring Go's `json.Number`) until `canonicalNumber`
// (see number.ts) deliberately expands it.
//
// This mirrors what agentstate.go gets from `encoding/json` plus `dec.UseNumber()`: a
// document decodes to plain objects/arrays/strings/booleans/null/JsonNumber, and a second
// JSON value after the first is refused (`requireEOF` in the Go source) rather than
// silently ignored.

import { TrailingContentError } from "./errors.js";

/** A JSON number, held as the source digits rather than a lossy JS `number`. */
export class JsonNumber {
	readonly raw: string;
	constructor(raw: string) {
		this.raw = raw;
	}
	toString(): string {
		return this.raw;
	}
}

export interface DocObject {
	[key: string]: DocValue;
}

export type DocValue = null | boolean | string | JsonNumber | DocValue[] | DocObject;

export function isPlainDocObject(v: DocValue): v is DocObject {
	return v !== null && typeof v === "object" && !(v instanceof JsonNumber) && !Array.isArray(v);
}

/** The JSON type name a refusal quotes back — `agentstate.go`'s `jsonTypeName`. */
export function jsonTypeName(v: DocValue): string {
	if (v === null) return "null";
	if (typeof v === "boolean") return "bool";
	if (v instanceof JsonNumber) return "number";
	if (typeof v === "string") return "string";
	if (Array.isArray(v)) return "array";
	return "object";
}

export function quote(s: string): string {
	return JSON.stringify(s);
}

/** Bounds a fragment quoted back in an error — `agentstate.go`'s `truncate`. */
export function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}

const encoder = new TextEncoder();

/** The UTF-8 byte length of `s` — what Go's `len(string)` measures. */
export function byteLength(s: string): number {
	return encoder.encode(s).length;
}

interface ParseState {
	readonly text: string;
	pos: number;
}

function isWhitespace(c: string | undefined): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function skipWhitespace(state: ParseState): void {
	while (isWhitespace(state.text[state.pos])) state.pos++;
}

function isDigit(c: string | undefined): boolean {
	return c !== undefined && c >= "0" && c <= "9";
}

function parseValue(state: ParseState): DocValue {
	skipWhitespace(state);
	const c = state.text[state.pos];
	if (c === "{") return parseObject(state);
	if (c === "[") return parseArray(state);
	if (c === '"') return parseString(state);
	if (c === "t") return parseLiteral(state, "true", true);
	if (c === "f") return parseLiteral(state, "false", false);
	if (c === "n") return parseLiteral(state, "null", null);
	if (c === "-" || isDigit(c)) return parseNumber(state);
	if (c === undefined) throw new Error("unexpected end of JSON input");
	throw new Error(`unexpected character ${quote(c)} at position ${state.pos}`);
}

function parseLiteral<T>(state: ParseState, literal: string, value: T): T {
	if (state.text.slice(state.pos, state.pos + literal.length) !== literal) {
		throw new Error(`invalid literal at position ${state.pos}`);
	}
	state.pos += literal.length;
	return value;
}

function parseObject(state: ParseState): DocObject {
	state.pos++; // consume '{'
	const out: DocObject = {};
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

function parseArray(state: ParseState): DocValue[] {
	state.pos++; // consume '['
	const out: DocValue[] = [];
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

function parseString(state: ParseState): string {
	const { text } = state;
	let i = state.pos;
	if (text[i] !== '"') throw new Error(`expected a string at position ${i}`);
	i++;
	let out = "";
	for (;;) {
		const c = text[i];
		if (c === undefined) throw new Error("unterminated string");
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
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid unicode escape at position ${i - 1}`);
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 5;
					break;
				}
				default:
					throw new Error(`invalid escape \\${esc} at position ${i - 1}`);
			}
			continue;
		}
		if (c.charCodeAt(0) < 0x20) throw new Error(`control character in string at position ${i}`);
		out += c;
		i++;
	}
	state.pos = i;
	return out;
}

function parseNumber(state: ParseState): JsonNumber {
	const { text } = state;
	const start = state.pos;
	let i = start;
	if (text[i] === "-") i++;
	if (text[i] === "0") {
		i++;
	} else if (isDigit(text[i])) {
		i++;
		while (isDigit(text[i])) i++;
	} else {
		throw new Error(`invalid number at position ${start}`);
	}
	if (text[i] === ".") {
		i++;
		if (!isDigit(text[i])) throw new Error(`invalid number at position ${start}`);
		while (isDigit(text[i])) i++;
	}
	if (text[i] === "e" || text[i] === "E") {
		i++;
		if (text[i] === "+" || text[i] === "-") i++;
		if (!isDigit(text[i])) throw new Error(`invalid number at position ${start}`);
		while (isDigit(text[i])) i++;
	}
	state.pos = i;
	return new JsonNumber(text.slice(start, i));
}

/** Rejects a second JSON value after the first — `agentstate.go`'s `requireEOF`. */
function requireEOF(state: ParseState): void {
	skipWhitespace(state);
	if (state.pos >= state.text.length) return;
	const start = state.pos;
	try {
		parseValue(state);
	} catch (err) {
		throw new TrailingContentError(
			`the content after it does not parse (${(err as Error).message}): expected one JSON value and found more content after it`,
		);
	}
	const second = state.text.slice(start, state.pos);
	throw new TrailingContentError(
		`a second value (${truncate(second, 40)}) follows the first: expected one JSON value and found more content after it`,
	);
}

/** Parses exactly one JSON value and refuses any content — other than whitespace — after it. */
export function parseJsonDocument(text: string): DocValue {
	const state: ParseState = { text, pos: 0 };
	const value = parseValue(state);
	requireEOF(state);
	return value;
}

function marshalString(s: string): string {
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

/** Compact canonical JSON, with object keys sorted at every depth — what Go's
 * `encoding/json` does for a `map[string]any`, and what the byte cap is measured on. */
export function marshalValue(v: DocValue): string {
	if (v === null) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "string") return marshalString(v);
	if (v instanceof JsonNumber) return v.raw;
	if (Array.isArray(v)) return `[${v.map(marshalValue).join(",")}]`;
	const keys = Object.keys(v).sort();
	return `{${keys.map((k) => `${marshalString(k)}:${marshalValue(v[k])}`).join(",")}}`;
}
