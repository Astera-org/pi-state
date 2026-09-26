# pi-state

State compression for [`pi`](https://github.com/earendil-works/pi): keeps a coding
agent's prompt bounded by replacing its transcript each turn with a small durable JSON
document (Sigma, `Σ`) instead of full history, once Sigma is committed via a
`state_commit`-style tool call.

This is a standalone extraction of the mechanism first built in
[Astera-org/sproot](https://github.com/Astera-org/sproot) (`internal/agentstate` plus
the `agent/pi-extensions/sproot-mcp` transcript boundary). See sproot's
`docs/pi-state.md` for the full architecture this package is being extracted from.

## `src/agentstate`

The pure merge + validation core: given a stored Sigma document and a patch, it answers
with the document that should replace it, or a refusal naming exactly what was wrong.
Ported from sproot's `internal/agentstate` Go package (`agentstate.go`, `merge.go`,
`number.go`, `carriage.go`) — see that package's comments for the full rationale behind
each rule; the ported TypeScript carries a pointer back to it wherever a rule isn't
obvious from the code alone.

**This module is pure logic: no file, network, or process I/O.** It exchanges plain
strings and JS values with its caller and never reads or writes storage itself; a file
or database backend is a separate concern layered on top.

Highlights, since they're easy to get wrong by reaching for the built-ins:

- Numbers are never routed through `JSON.parse`/`JSON.stringify` or the JS `number`
  type. `src/agentstate/json.ts` implements its own JSON reader/writer that keeps every
  number as its exact source digits (a `JsonNumber`, mirroring Go's `json.Number`),
  because `9999999999999999` silently becomes `10000000000000000` once it passes
  through a JS `number`.
- The byte cap (`maxStateBytes`, 4096 by default, 65536 ceiling) is measured on the
  **merged** document's canonical JSON, and a number counts toward it in its
  exponent-free decimal form (`1e10000` is 16 bytes of JSON and ten thousand and one
  digits expanded) — see `src/agentstate/number.ts`.
- A schema's key set is closed and each key has exactly one of five kinds (`string`,
  `number`, `bool`, `object`, `list`); a `list` must declare `maxItems`, and an array
  may never appear inside an object value at any depth.
- `merge()` treats `null` as a deletion at any depth, merges objects deep, and replaces
  arrays wholesale (never appends) — see `src/agentstate/merge.ts`.

Naming: Go's exported `PascalCase` functions (`ParseSchema`, `Merge`, `Marshal`, ...)
are ported as `camelCase` (`parseSchema`, `merge`, `marshal`, ...) per TypeScript
convention; types stay `PascalCase` (`Schema`, `Field`, `Kind`, `Carriage`). Same words,
different case, so a reader can find the Go source a given export was ported from.

### What isn't here yet

This package is being built up incrementally. Not yet included: a storage backend (a
file-backed store, mirroring sproot's Postgres/in-memory `agent_state`), the pi
extension registration itself (MCP tool wiring, the transcript boundary, session
replay), and `stateboundary.ts` / `statewindow.ts` / `pairing.ts`. Those land in
follow-up work on top of the core in `src/agentstate`.

## Development

```sh
npm install
npm run check   # biome + tsc
npm test        # vitest
npm run build   # emit dist/
```
