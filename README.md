# pi-state

State compression for [`pi`](https://github.com/earendil-works/pi): keeps a coding
agent's prompt bounded by replacing its transcript each turn with a small durable JSON
document (Sigma, `Σ`) instead of full history, once Sigma is committed via a
`state_commit`-style tool call.

This package is a self-contained `pi` extension: install it, declare a schema, and it
bounds the prompt on its own — no other service, database, or account is required. The
mechanism was first built inside [Astera-org/sproot](https://github.com/Astera-org/sproot),
Astera's internal agent platform, and is mentioned here and there below purely as
historical provenance; nothing in this repo depends on sproot or assumes you have access
to it.

## Install

```bash
pi install git:github.com/Astera-org/pi-state
```

(or `pi install ./pi-state` from a local checkout, or `pi -e git:github.com/Astera-org/pi-state`
to try it for one invocation without persisting the install — see `pi`'s own package
documentation for the full set of install sources and flags).

## Configure

`pi-state` registers two tools, `state_get` and `state_commit`, once it can find a
schema declaring the shape of Σ. There is no default: create
`.pi-state/schema.json` relative to `pi`'s working directory, naming every key your
agent's state may hold —

```json
{
  "keys": {
    "objective": { "type": "string", "desc": "what the agent is trying to accomplish" },
    "step": { "type": "number", "desc": "how many turns since the objective last changed" }
  },
  "maxStateBytes": 4096
}
```

— in the grammar `agentstate.parseSchema` accepts (documented in full under
`src/agentstate` below: five kinds, a closed key set, an optional per-key `desc`, and a
byte cap on the merged document). A schema with no keys is valid but refuses every
non-empty patch, so a missing or empty file is not a usable default — installation fails
loudly, with an actionable message, rather than silently registering a `state_commit`
that can never succeed.

With a schema in place, just run `pi` as you normally would. The agent calls
`state_get`/`state_commit` to read and update Σ, and after any turn that commits at
least one patch, `pi-state` replaces `pi`'s transcript with `[Σ, the newest user turn,
the last few trailing tool cycles]` instead of full history — see `src/entrypoint` and
`src/stateboundary` below for exactly what that replacement contains and why. No
environment variables are required for this; see **Environment variables** under
`src/entrypoint` to tune or disable it.

## `src/agentstate`

The pure merge + validation core: given a stored Sigma document and a patch, it answers
with the document that should replace it, or a refusal naming exactly what was wrong.
Originally ported from sproot's `internal/agentstate` Go package (`agentstate.go`,
`merge.go`, `number.go`, `carriage.go`); the rationale behind each rule now lives in this
package's own comments rather than requiring a look back at the Go source.

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

## `src/backend`

Σ storage as a JSON file in pi's working directory — the standalone replacement for
sproot's Postgres/in-memory `agent_state` table. `commitFileState` reads the current
document, merges a patch through `src/agentstate`'s own `merge`, and writes the result
back with a version counter; `readFileState` answers `state_get`'s "before the first
commit" shape (`exists: false, version: 0, doc: {}`) for a missing **or corrupt** file,
rather than throwing.

Writes go through a fixed temp path (`<path>.tmp`) created with an exclusive (`O_EXCL`)
flag, then an atomic rename onto the real path. That one mechanism buys two properties:
the rename means a reader never observes a torn write, and the temp path's exclusive
create doubles as the mutex a compare-and-set needs — two commits racing against the same
stale version both try to open the same temp path, only one wins at a time, and the loser
re-reads the current version once it gets in and finds it has moved. No second lock file.

A compare-and-set names the version it read; a mismatch is refused with the same wording
sproot's own store uses (`internal/store/{memory,postgres}_agentstate.go`):

```
commit named version 3 and the stored version is 4: this agent state commit was decided
against a version that has since changed — read the current state and retry
```

so an agent's retry-on-conflict logic does not depend on which backend is underneath. The
first commit against a missing file must name version 0, exactly like a first commit
against sproot's Postgres row.

## `src/entrypoint`

The actual pi extension — the piece that makes this package a runnable, standalone
extension with no sproot, no Postgres, and no MCP round trip. `installPiState` (the
module's default export, so `package.json`'s `"pi": {"extensions": [...]}` field can load
it directly):

- registers `state_get` and `state_commit` as **local** pi tools (`pi.registerTool`,
  bare names — no `mcp__...`-style prefix, since there is no MCP server here to prefix a
  name after) backed by `src/backend`'s file backend;
- generates `state_commit`'s input JSON Schema from the loaded schema file
  (`src/entrypoint/patchschema.ts`): one property per declared key, each unioned with
  `null` (a null value is how a patch deletes a key), and `additionalProperties: false`
  for the closed key set — ported from sproot's `internal/mcp/agentstate.go`
  (`stateCommitPatchSchema`), minus `action_summary`, which is sproot's operator
  action-log field and has no standalone equivalent;
- installs the transcript boundary (`src/stateboundary`'s `installStateBoundary`),
  configured from this repo's own environment variables (below) rather than any
  `SPROOT_*` name;
- does **not** call MCP `connect()`, write a receipt file, or register a provider — this
  entrypoint is narrower than sproot's bridge by design.

**File layout.** Two files, both under one directory (`.pi-state/`) so a user can
`.gitignore` or inspect this extension's whole footprint as a unit, relative to pi's
working directory:

| File | Purpose | Override |
| --- | --- | --- |
| `.pi-state/schema.json` | the operator-authored state schema, in the exact JSON grammar `agentstate.parseSchema` accepts (`{"keys":{...},"maxStateBytes":N}`) | `PiStateOptions.schemaPath` |
| `.pi-state/state.json` | Σ itself, as `src/backend` reads and writes it | `PiStateOptions.statePath` |

The schema file is **required** — there is no sane default (a schema with no keys refuses
every non-empty patch), so a missing one fails installation loudly with an actionable
message rather than silently registering a `state_commit` that can never succeed.

**Environment variables.** Deliberately neutral names, not `SPROOT_*` — there is no
sproot adapter here writing a separate "mode" variable and a separate operator kill
switch, so the two collapse into one flag:

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_STATE_LOOP` | the state loop's on/off switch. Kill-switch semantics: unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it **on**; a recognized negative (`0`/`false`/`no`/`off`) turns it off; anything else is unrecognized and also refuses (fail closed) | **on** |
| `PI_STATE_WINDOW_CYCLES` | N, the number of trailing tool cycles kept alongside Σ after a boundary | `4` |

Defaulting `PI_STATE_LOOP` to **on** (rather than requiring explicit opt-in) is a
deliberate choice: installing this extension and declaring a schema should be enough on
its own to bound the prompt, with zero environment variables required.

**Loud refusal.** At install time, if this `pi` exposes no `replaceTranscript`,
`installPiState` **throws** rather than silently declining — this is a distinct,
louder signal than the boundary's own ladder of quiet log-and-skip reasons (kill switch
off, a malformed cycle count), because every one of those is a legitimate configuration
choice on a `pi` that *could* run the loop, while a missing `replaceTranscript` means this
host fundamentally cannot, however it is configured. The throw happens before the schema
file is even read, so a caller sees it immediately and cannot mistake it for one of the
ordinary off conditions logged to stderr.

**A known gap versus sproot's MCP path.** pi coerces a tool call's arguments against the
JSON Schema `parameters` advertises *before* `execute` is reached, so `state_commit`'s
`patch` argument arrives as an already-parsed JS value — a JS `number`, not the exact
source digits `src/agentstate`'s own parser preserves. sproot's MCP path takes the patch
as `json.RawMessage` straight off the wire and never loses precision; a local pi tool has
no equivalent raw-bytes hook, so an arbitrary-precision number in a `state_commit` call
here is rendered through `String(n)` on whatever pi's own JSON parsing already produced.
This is a real, accepted limitation of the local-tool surface, not an oversight.

## Development

```sh
npm install
npm run check   # biome + tsc
npm test        # vitest
npm run build   # emit dist/
```

`dist/` is committed, not gitignored: `main`/`types`/`exports`/`pi.extensions` all point
into it, this package has no runtime dependencies to trigger npm's `prepare` lifecycle,
and `pi install git:...` installs with dev dependencies omitted — so there is no install
step anywhere that could otherwise produce a working build. Run `npm run build` and
commit the result alongside any change under `src/`; CI fails the build if `dist/` and
`src/` disagree.
