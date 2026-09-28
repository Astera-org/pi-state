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

`pi-state` requires a `pi` build that exposes the extension API `pi.replaceTranscript`,
which it uses to bound the prompt (see `src/entrypoint` below). Install `pi` per its own
docs:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

The version number does not indicate whether a build has `replaceTranscript`:
`@earendil-works/pi-coding-agent@0.87.1` on npm does not include it. Check a `pi` install
with:

```bash
grep -rl replaceTranscript "$(dirname "$(readlink -f "$(which pi)")")"
```

If nothing matches, use a `pi` build that includes the feature (for example, a recent
checkout built locally). Without it, `pi-state` refuses to install (see "Loud refusal"
under `src/entrypoint` below).

With `pi-state` installed, just run `pi` in a project. With no schema file it uses the
built-in default (see "Configure"); to declare your own, add `.pi-state/schema.json`.
Ask the agent to call `state_get` to confirm the
tools are registered — its result carries the declared keys, their types, and the
current byte cap even before anything has been committed:

```json
{"ok":true,"version":0,"doc":{},"exists":false,"note":"no state yet — commit with version 0 to create it","declaredKeys":["objective","step"],"declaredTypes":{"objective":"string","step":"number"},"maxStateBytes":4096}
```

Then have it call `state_commit` with `version: 0` and a patch, e.g.
`{"objective": "set up pi-state", "step": 1}` — a successful result returns the merged
document at `version: 1`.

To confirm the prompt is bounded, watch per-request token usage in `--mode json` (the
`usage` field on `message_update`/`message_end`): before any `state_commit`, input tokens
grow with the conversation; after one is accepted, later turns' usage no longer grows
with conversation length.

To smoke-test a local checkout of `pi-state` without installing it first, point `-e`
straight at the built entrypoint: `pi -e /path/to/pi-state/dist/entrypoint/index.js`.

## Configure

`pi-state` registers two tools, `state_get` and `state_commit`, over a schema declaring
the shape of Σ.

**Quick start: nothing to configure.** A directory with no schema file gets the built-in
default, so `pi-state` works as soon as it is installed. Its keys are `objective`
(string), `plan` (list, max 8), `findings` (list, max 16), `tested_hypotheses` (list,
max 12), `active_files` (list, max 12), `working_dir` (string), `cmd_summary` (string)
and `open_questions` (list, max 8). It declares no `maxStateBytes`, so the cap is sized
automatically (see "Auto sizing" under `src/entrypoint` below).

To replace the default, create `.pi-state/schema.json` relative to `pi`'s working
directory (or `~/.pi-state/schema.json` to apply to every project), naming every key the
agent's state may hold:

```json
{
  "keys": {
    "objective": { "type": "string", "desc": "what the agent is trying to accomplish" },
    "step": { "type": "number", "desc": "how many turns since the objective last changed" }
  },
  "maxStateBytes": 4096
}
```

The grammar is the one `agentstate.parseSchema` accepts (see `src/agentstate` below): a
closed key set, each key exactly one of five kinds, an optional per-key `desc` (at most
160 bytes; it is included in the system prompt of every request), and a byte cap on the
merged document. `maxStateBytes` is optional; when omitted the cap is sized automatically
(see "Auto sizing" under `src/entrypoint` below).

The schema is looked up in this order, and the source used is logged to stderr:

1. `PiStateOptions.schemaPath`, when set;
2. `.pi-state/schema.json` in `pi`'s working directory;
3. `~/.pi-state/schema.json`;
4. the built-in default.

Only a missing file moves on to the next source. A schema with no keys is valid but
refuses every non-empty patch. A schema file that exists but does not parse fails
installation with the parse error, with no fallback to a later source, and so does an
explicit `schemaPath` that does not exist:

```
[pi-state] no schema file at custom/schema.json — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit
```

The agent calls `state_get`/`state_commit` to read and update Σ, and after any turn that
commits at least one patch, `pi-state` replaces `pi`'s transcript with `[Σ, the newest
user turn, the last few trailing tool cycles]` instead of full history (see
`src/entrypoint` and `src/stateboundary` below). No environment variables are required;
see **Environment variables** under `src/entrypoint` to tune or disable it.

## `src/agentstate`

The pure merge + validation core: given a stored Sigma document and a patch, it returns
the document that should replace it, or a refusal naming what was wrong.

This module performs no file, network, or process I/O. It exchanges plain strings and JS
values with its caller.

- Numbers are not passed through `JSON.parse`/`JSON.stringify` or the JS `number` type.
  `src/agentstate/json.ts` implements a JSON reader/writer that keeps every number as its
  exact source digits (a `JsonNumber`, mirroring Go's `json.Number`); a JS `number` would
  turn `9999999999999999` into `10000000000000000`.
- The byte cap (`maxStateBytes`) is measured on the **merged** document's canonical JSON,
  and a number counts toward it in its exponent-free decimal form (`1e10000` is 16 bytes
  of JSON and 10001 digits expanded); see `src/agentstate/number.ts`. `maxStateBytes` has
  no upper bound. A schema that declares none is sized automatically (see "Auto sizing"
  under `src/entrypoint` below), falling back to `DEFAULT_MAX_STATE_BYTES` (4096) when no
  context window is known.
- A schema's key set is closed and each key has exactly one of five kinds (`string`,
  `number`, `bool`, `object`, `list`); a `list` must declare `maxItems`, and an array
  may never appear inside an object value at any depth.
- `merge()` treats `null` as a deletion at any depth, merges objects deep, and replaces
  arrays wholesale (never appends) — see `src/agentstate/merge.ts`.

Naming: functions ported from Go's exported `PascalCase` (`ParseSchema`, `Merge`,
`Marshal`, ...) are `camelCase` (`parseSchema`, `merge`, `marshal`, ...); types stay
`PascalCase` (`Schema`, `Field`, `Kind`, `Carriage`).

## `src/backend`

Σ storage as a JSON file in pi's working directory. `commitFileState` reads the current
document, merges a patch through `src/agentstate`'s `merge`, and writes the result back
with a version counter; `readFileState` returns the "before the first commit" shape
(`exists: false, version: 0, doc: {}`) for a missing or corrupt file instead of throwing.

Writes go through a fixed temp path (`<path>.tmp`) created with an exclusive (`O_EXCL`)
flag, then an atomic rename onto the real path. The rename means a reader never observes
a torn write. The exclusive create serves as the mutex for the compare-and-set: commits
racing against the same version open the same temp path, one at a time succeeds, and
each later one re-reads the stored version and is refused if it has moved. There is no
separate lock file.

A compare-and-set names the version it read; a mismatch is refused with:

```
commit named version 3 and the stored version is 4: this agent state commit was decided
against a version that has since changed — read the current state and retry
```

The first commit against a missing file must name version 0.

## `src/entrypoint`

The pi extension. `installPiState` (the module's default export, loaded via
`package.json`'s `"pi": {"extensions": [...]}` field):

- registers `state_get` and `state_commit` as **local** pi tools (`pi.registerTool`,
  under their bare names) backed by `src/backend`'s file backend;
- generates `state_commit`'s input JSON Schema from the loaded schema file
  (`src/entrypoint/patchschema.ts`): one property per declared key, each unioned with
  `null` (a null value is how a patch deletes a key), and `additionalProperties: false`
  for the closed key set;
- installs the transcript boundary (`src/stateboundary`'s `installStateBoundary`),
  configured from the environment variables below.

**File layout.** Files under `.pi-state/`:

| File | Purpose | Override |
| --- | --- | --- |
| `.pi-state/schema.json` (working directory) | the operator-authored state schema, in the exact JSON grammar `agentstate.parseSchema` accepts (`{"keys":{...},"maxStateBytes":N}`, `maxStateBytes` optional — see "Auto sizing" below). Optional | `PiStateOptions.schemaPath` |
| `~/.pi-state/schema.json` | the same, shared by every project; used when the working directory has none. Optional | `PiStateOptions.homeDir` |
| `.pi-state/state.json` (working directory) | Σ itself, as `src/backend` reads and writes it | `PiStateOptions.statePath` |

With neither schema file, the built-in default applies (see "Configure"). The state file
is always project-relative, whichever schema is used.

**Environment variables.**

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_STATE_LOOP` | the state loop's on/off switch. Kill-switch semantics: unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it **on**; a recognized negative (`0`/`false`/`no`/`off`) turns it off; anything else is unrecognized and also refuses (fail closed) | **on** |
| `PI_STATE_WINDOW_CYCLES` | N, the number of trailing tool cycles kept alongside Σ after a boundary | `4` |
| `PI_STATE_CONTEXT_WINDOW_TOKENS` | a manual stopgap for auto sizing (below): the active model's context window, in tokens, on a `pi` this entrypoint cannot otherwise learn it from | unset |

**Auto sizing.** A schema that declares no `maxStateBytes` is sized as a percentage of
the model's context window: `autoMaxStateBytesPercent` (1-100, default 65) percent of the
context window, at 4 bytes per token. `src/entrypoint` resolves the context window from
the first of these sources that answers:

1. **The active model reported by `pi`**: `ExtensionContext.model` on `session_start` and
   `ModelSelectEvent.model` on `model_select` (`contextWindow`). The cap is re-resolved
   whenever either fires, including on a mid-session model switch.
2. **`PI_STATE_CONTEXT_WINDOW_TOKENS`**, used at install time (before any session has a
   model) or when `pi` reports no model. A model reported by `pi` supersedes it.

An explicit `maxStateBytes` in the schema file always takes precedence over auto sizing.
If neither source resolves, the cap is `DEFAULT_MAX_STATE_BYTES` (4096).

**Loud refusal.** At install time, if `pi` exposes no `replaceTranscript`,
`installPiState` throws. The check runs before the schema is resolved. Other reasons
the boundary does not install (kill switch off, a malformed cycle count) are logged to
stderr and skipped instead. A missing schema file is not a refusal (the built-in default
applies); only a schema file that does not parse, or an explicit `schemaPath` that does
not exist, throws.

**Known limitation: number precision.** `pi` coerces a tool call's arguments against the
advertised JSON Schema before `execute` runs, so `state_commit`'s `patch` arrives as an
already-parsed JS value, with numbers as JS `number`s rather than exact source digits.
A local pi tool has no hook for the raw arguments, so a number in a `state_commit` call
is stored as `String(n)` of the parsed value, and arbitrary-precision numbers lose
precision.

## Development

```sh
npm install
npm run check   # biome + tsc
npm test        # vitest
npm run build   # emit dist/
```

`dist/` is committed: `main`/`types`/`exports`/`pi.extensions` point into it, and
`pi install git:...` runs no build step (dev dependencies are omitted and the package has
no runtime dependencies to trigger `prepare`). Run `npm run build` and commit the result
with any change under `src/`; CI fails if `dist/` and `src/` disagree.
