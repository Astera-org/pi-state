# pi-state

State compression for [`pi`](https://github.com/earendil-works/pi): keeps a coding
agent's prompt bounded by replacing its transcript each turn with a small durable JSON
document (Sigma, `Σ`) instead of full history, once Sigma is committed via a
`state_commit`-style tool call.

This package is a self-contained `pi` extension: install it, declare a schema, and it
bounds the prompt on its own.

## Install

```bash
pi install git:github.com/Astera-org/pi-state
```

(or `pi install ./pi-state` from a local checkout, `pi install <source> -l` to install
project-locally instead of into your global settings, or `pi -e git:github.com/Astera-org/pi-state`
to try it for one invocation without persisting the install — see `pi`'s own package
documentation for the full set of install sources and flags).

## Run it standalone

The whole footprint is two files under `.pi-state/` (a schema and Σ itself) and two
local tools (`state_get`, `state_commit`).

`pi-state` needs a `pi` build that exposes the extension API `pi.replaceTranscript` —
this is how it bounds the prompt (see `src/entrypoint` below). Get a `pi` binary from
`pi`'s own install docs:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Whether the version you get has `replaceTranscript` isn't guaranteed by the version
number alone — as of `@earendil-works/pi-coding-agent@0.87.1`, the published npm package
doesn't carry it anywhere in its `dist/`. Verify your own `pi` before relying on it:

```bash
grep -rl replaceTranscript "$(dirname "$(readlink -f "$(which pi)")")"
```

If nothing matches, get a `pi` build that includes the feature (a recent checkout built
locally, for example) — `pi-state` otherwise refuses to install rather than silently
running a loop that can never take effect (see "Configure" below for the analogous
missing-schema refusal).

With a schema in place (below) and `pi-state` installed, just run `pi` in a project
containing `.pi-state/schema.json`. Ask the agent to call `state_get` to confirm the
tools are registered — its result carries the declared keys, their types, and the
current byte cap even before anything has been committed:

```json
{"ok":true,"version":0,"doc":{},"exists":false,"note":"no state yet — commit with version 0 to create it","declaredKeys":["objective","step"],"declaredTypes":{"objective":"string","step":"number"},"maxStateBytes":4096}
```

Then have it call `state_commit` with `version: 0` and a patch, e.g.
`{"objective": "set up pi-state", "step": 1}` — a successful result returns the merged
document at `version: 1`.

To confirm the prompt actually bounds, watch per-request token usage in `--mode json`
(the `usage` field on `message_update`/`message_end`): before any `state_commit`, input
tokens grow with the conversation as usual; after one is accepted, later turns' usage
stops tracking the conversation's length, no matter how long the session runs.

To smoke-test a local checkout of `pi-state` without installing it first, point `-e`
straight at the built entrypoint: `pi -e /path/to/pi-state/dist/entrypoint/index.js`.

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
`src/agentstate` below): a closed key set, each key exactly one of five kinds, an
optional per-key `desc` (capped at 160 bytes — it ships in the system prompt of every
request, so keep it to a clause), and a byte cap on the merged document.
`maxStateBytes` is optional — omit it and the cap is sized automatically instead of
defaulting to a fixed number; see "Auto sizing" under `src/entrypoint` below.

A schema with no keys is valid but refuses every non-empty patch, so a missing or empty
file is not a usable default — installation fails loudly instead of silently registering
a `state_commit` that can never succeed:

```
[pi-state] no schema file at .pi-state/schema.json — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit
```

The agent calls `state_get`/`state_commit` to read and update Σ, and after any turn that
commits at least one patch, `pi-state` replaces `pi`'s transcript with `[Σ, the newest
user turn, the last few trailing tool cycles]` instead of full history — see
`src/entrypoint` and `src/stateboundary` below for exactly what that replacement
contains and why. No environment variables are required for this; see **Environment
variables** under `src/entrypoint` to tune or disable it.

## `src/agentstate`

The pure merge + validation core: given a stored Sigma document and a patch, it answers
with the document that should replace it, or a refusal naming exactly what was wrong.
The rationale behind each rule lives in this package's own comments.

**This module is pure logic: no file, network, or process I/O.** It exchanges plain
strings and JS values with its caller; storage — a file or database backend — is a
separate concern layered on top.

Highlights, since they're easy to get wrong by reaching for the built-ins:

- Numbers are never routed through `JSON.parse`/`JSON.stringify` or the JS `number`
  type. `src/agentstate/json.ts` implements its own JSON reader/writer that keeps every
  number as its exact source digits (a `JsonNumber`, mirroring Go's `json.Number`),
  because `9999999999999999` silently becomes `10000000000000000` once it passes
  through a JS `number`.
- The byte cap (`maxStateBytes`) is measured on the **merged** document's canonical
  JSON, and a number counts toward it in its exponent-free decimal form (`1e10000` is 16
  bytes of JSON and ten thousand and one digits expanded) — see
  `src/agentstate/number.ts`. There is no ceiling on a declared `maxStateBytes`, and a
  schema that declares none at all is sized **automatically**, not defaulted to a fixed
  number: see "Auto sizing" under `src/entrypoint` below for how that resolves in
  practice, and `DEFAULT_MAX_STATE_BYTES` (4096) for the last-resort fallback when it
  genuinely cannot.
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

Σ storage as a JSON file in pi's working directory. `commitFileState` reads the current
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

A compare-and-set names the version it read; a mismatch is refused with:

```
commit named version 3 and the stored version is 4: this agent state commit was decided
against a version that has since changed — read the current state and retry
```

The first commit against a missing file must name version 0.

## `src/entrypoint`

The actual pi extension — the piece that makes this package a runnable, standalone
extension. `installPiState` (the module's default export, so `package.json`'s
`"pi": {"extensions": [...]}` field can load it directly):

- registers `state_get` and `state_commit` as **local** pi tools (`pi.registerTool`,
  under their bare names) backed by `src/backend`'s file backend;
- generates `state_commit`'s input JSON Schema from the loaded schema file
  (`src/entrypoint/patchschema.ts`): one property per declared key, each unioned with
  `null` (a null value is how a patch deletes a key), and `additionalProperties: false`
  for the closed key set;
- installs the transcript boundary (`src/stateboundary`'s `installStateBoundary`),
  configured from this repo's own environment variables (below).

That's the entrypoint's entire job: register the two local tools and the transcript
boundary.

**File layout.** Two files, both under one directory (`.pi-state/`) so a user can
`.gitignore` or inspect this extension's whole footprint as a unit, relative to pi's
working directory:

| File | Purpose | Override |
| --- | --- | --- |
| `.pi-state/schema.json` | the operator-authored state schema, in the exact JSON grammar `agentstate.parseSchema` accepts (`{"keys":{...},"maxStateBytes":N}`, `maxStateBytes` optional — see "Auto sizing" below) | `PiStateOptions.schemaPath` |
| `.pi-state/state.json` | Σ itself, as `src/backend` reads and writes it | `PiStateOptions.statePath` |

The schema file is **required** — there is no sane default (a schema with no keys refuses
every non-empty patch), so a missing one fails installation loudly with an actionable
message rather than silently registering a `state_commit` that can never succeed.

**Environment variables.** A single on/off flag covers both the loop's own mode and any
operator kill switch, rather than splitting them into two variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_STATE_LOOP` | the state loop's on/off switch. Kill-switch semantics: unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it **on**; a recognized negative (`0`/`false`/`no`/`off`) turns it off; anything else is unrecognized and also refuses (fail closed) | **on** |
| `PI_STATE_WINDOW_CYCLES` | N, the number of trailing tool cycles kept alongside Σ after a boundary | `4` |
| `PI_STATE_CONTEXT_WINDOW_TOKENS` | a manual stopgap for auto sizing (below): the active model's context window, in tokens, on a `pi` this entrypoint cannot otherwise learn it from | unset |

Defaulting `PI_STATE_LOOP` to **on** (rather than requiring explicit opt-in) is a
deliberate choice: installing this extension and declaring a schema should be enough on
its own to bound the prompt, with zero environment variables required.

**Auto sizing.** A schema that declares no `maxStateBytes` is not defaulted to a fixed
byte number — it is sized as a percentage of the agent's actual model context window
instead: `autoMaxStateBytesPercent` (1-100, defaults to 65) percent of the context
window, at roughly 4 bytes per token. `src/agentstate` is pure logic with no I/O and
cannot compute this itself (it has no notion of "the current model"); `src/entrypoint`
is the layer that can, and resolves it from whichever of these two sources answers first:

1. **A live model from `pi`.** `pi`'s own extension API exposes the active model's
   `contextWindow` to extensions — on `session_start` (`ExtensionContext.model`) and on
   `model_select` (`ModelSelectEvent.model`) — so this entrypoint reads it there and
   re-resolves the cap whenever either fires, keeping it current across a mid-session
   model switch.
2. **`PI_STATE_CONTEXT_WINDOW_TOKENS`** (above), for install time — before any session
   has started, so there is no live model yet to ask — or a `pi` that doesn't populate
   `model` for some reason. A live report from `pi` always supersedes this once one
   arrives.

An explicit `maxStateBytes` in the schema file always wins over auto sizing, no matter
what either source reports. If neither source ever resolves, the cap stays at
`DEFAULT_MAX_STATE_BYTES` (4096) — the same fallback a fixed-cap schema with no
`maxStateBytes` would have gotten before auto sizing existed.

**Loud refusal.** At install time, if this `pi` exposes no `replaceTranscript`,
`installPiState` **throws** rather than silently declining — this is a distinct,
louder signal than the boundary's own ladder of quiet log-and-skip reasons (kill switch
off, a malformed cycle count), because every one of those is a legitimate configuration
choice on a `pi` that *could* run the loop, while a missing `replaceTranscript` means this
host fundamentally cannot, however it is configured. The throw happens before the schema
file is even read, so a caller sees it immediately and cannot mistake it for one of the
ordinary off conditions logged to stderr.

**A known gap in the local-tool surface.** pi coerces a tool call's arguments against the
JSON Schema `parameters` advertises *before* `execute` is reached, so `state_commit`'s
`patch` argument arrives as an already-parsed JS value — a JS `number`, not the exact
source digits `src/agentstate`'s own parser preserves. A local pi tool has no raw-bytes
hook to intercept the patch before that coercion happens, so an arbitrary-precision
number in a `state_commit` call here is rendered through `String(n)` on whatever pi's own
JSON parsing already produced. This is a real, accepted limitation of the local-tool
surface, not an oversight.

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
