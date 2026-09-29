# pi-state

State compression for [`pi`](https://github.com/earendil-works/pi). After a turn accepts
a `state_commit`, this extension replaces the transcript with durable JSON state
(Sigma, `Σ`), the newest user turn, and trailing tool cycles.

## Background

- Paper: [SKILL.state: Scalable Long-Horizon Agent Skills](https://arxiv.org/html/2608.26263)
- Reference implementation: [ASSERT-KTH/replication-structured-state-extraction](https://github.com/ASSERT-KTH/replication-structured-state-extraction)

Mapping to the paper:

- Σ is the paper's execution state.
- `state_commit` is the paper's state patch (dict merge; `null` deletes a key).
- Transcript replacement is the paper's bounded prompt (`boundary` mode).
- In `paper` mode (below), P is the system prompt with the state contract appended, Σ_t is
  the Σ message, and O_t is the trailing tool cycles after the newest user message.

## Install

```bash
pi install git:github.com/Astera-org/pi-state
```

Use `pi install ./pi-state` for a local checkout, `pi install <source> -l` for a
project-local installation, or `pi -e git:github.com/Astera-org/pi-state` for one invocation.

## Run it standalone

The extension uses a schema, a state file under `.pi-state/`, and two local tools:
`state_get` and `state_commit`.

`pi-state` requires the `pi.replaceTranscript` extension API. Install `pi`:

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

If nothing matches, use a build with `replaceTranscript`; `pi-state` refuses to install
without it (see "Installation failures" below).

Run `pi` in a project. The extension uses the built-in schema unless a schema file
is found (see "Configure"). Call `state_get` to check registration: its result includes
declared keys, types, and the byte cap before the first commit:

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

With no schema file, the built-in default declares `objective` (string), `plan` (list,
max 8), `findings` (list, max 16), `tested_hypotheses` (list, max 12), `active_files` (list, max 12), `working_dir` (string), `cmd_summary` (string)
and `open_questions` (list, max 8). It declares no `maxStateBytes`, so the cap is sized
automatically (see "Auto sizing" under `src/entrypoint` below).

To replace the default, create `.pi-state/schema.json` relative to `pi`'s working
directory (or `~/.pi-state/projects/<key>/schema.json`, where `<key>` identifies the working directory), naming every key the
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
160 bytes; it is sent as the key's `description` in `state_commit`'s parameter schema on every request), and a byte cap on the
merged document. `maxStateBytes` is optional; when omitted the cap is sized automatically
(see "Auto sizing" under `src/entrypoint` below).

The schema is looked up in this order, and the source used is logged to stderr:

1. `PiStateOptions.schemaPath`, when set;
2. `.pi-state/schema.json` in `pi`'s working directory;
3. `~/.pi-state/projects/<key>/schema.json`;
4. the built-in default.

Only a missing file moves on to the next source. A schema with no keys is valid but
refuses every non-empty patch. A schema file that exists but does not parse fails
installation with the parse error. An explicit `schemaPath` that does not exist also
fails installation:

```
[pi-state] no schema file at custom/schema.json — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit
```

The agent calls `state_get`/`state_commit` to read and update Σ, and after any turn that
commits at least one patch, `pi-state` replaces `pi`'s transcript with `[Σ, the newest
user turn, the last few trailing tool cycles]` (see
`src/entrypoint` and `src/stateboundary` below). No environment variables are required;
see **Environment variables** under `src/entrypoint` to tune or disable it.

## `src/agentstate`

The pure merge + validation core: given a stored Sigma document and a patch, it returns
the document that should replace it, or a refusal naming what was wrong.

This module performs no file, network, or process I/O. It exchanges plain strings and JS
values with its caller.

- `src/agentstate/json.ts` preserves exact number digits in `JsonNumber` values.
  JavaScript numbers round `9999999999999999` to `10000000000000000`.
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

## `src/backend`

Σ storage as a JSON file in pi's working directory. `commitFileState` reads the current
document, merges a patch through `src/agentstate`'s `merge`, and writes the result back
with a version counter; `readFileState` returns the "before the first commit" shape
(`exists: false, version: 0, doc: {}`) for a missing or corrupt file.

Writes acquire a fixed temp path (`<path>.tmp`) with exclusive creation (`O_EXCL`),
then atomically rename it onto the state file. Readers see complete files. The temp
file serializes concurrent commits: each writer re-reads the version under the lock
and refuses a stale version.

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
| `~/.pi-state/projects/<key>/schema.json` | the same; used when the working directory has none. `<key>` is the first 16 hex digits of the SHA-256 of the symlink-resolved working directory, so each directory has its own file. Optional | `PiStateOptions.homeDir` |
| `.pi-state/state.json` (working directory) | Σ itself, as `src/backend` reads and writes it; used when it exists | `PiStateOptions.statePath` |
| `~/.pi-state/projects/<key>/state.json` | the same, with the same `<key>`; used when the working directory has none, and where a new state file is created | `PiStateOptions.homeDir` |

With neither schema file, the built-in default applies (see "Configure"). A new state
file is created under the home directory, never in the working directory.

**Environment variables.**

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_STATE_LOOP` | the state loop's on/off switch. Kill-switch semantics: unset or a recognized affirmative (`1`/`true`/`yes`/`on`) leaves it **on**; a recognized negative (`0`/`false`/`no`/`off`) turns it off; anything else is unrecognized and also refuses (fail closed) | **on** |
| `PI_STATE_WINDOW_CYCLES` | N, the number of trailing tool cycles kept alongside Σ (0–20) | `4`; `1` in `paper` mode |
| `PI_STATE_MODE` | `boundary` or `paper` (see "Modes" below). Any other value refuses installation (logged; tools stay registered) | `boundary` |
| `PI_STATE_REQUIRE_COMMIT` | `paper` mode only: `every`, `off`, or a positive integer K (see "Modes"). Any other value refuses installation | `every` |
| `PI_STATE_CONTEXT_WINDOW_TOKENS` | a manual stopgap for auto sizing (below): the active model's context window, in tokens, on a `pi` this entrypoint cannot otherwise learn it from | unset |

**Modes.** `PI_STATE_MODE` selects how Σ reaches the prompt.

- `boundary` (default): after a turn that accepted a `state_commit`, replaces the
  transcript with `[Σ, newest user message, last N cycles]` via `replaceTranscript`.
- `paper`: on every model call, the `context` event returns `[Σ message, newest user
  message, last N complete tool cycles]`, whether or not a commit happened this turn. No
  Σ yet shows `{}` at version 0. `N=0` keeps Σ and the user message only. A trailing
  window that cannot be paired falls back to Σ and the user message. The system prompt
  gets a contract appended (`before_agent_start`): earlier turns are not shown, persist
  everything needed with `state_commit`, and call `state_commit` in the same message as
  each action. `replaceTranscript` is not used, so `pi` does not need it in this mode.

  `PI_STATE_REQUIRE_COMMIT` sets how the contract is enforced. A non-`state_commit` tool
  call from an assistant message with no `state_commit` call is blocked with the reason
  `include a state_commit call in the same message as this action`:
  - `every`: every such message is blocked;
  - `off`: never blocked;
  - K: blocked once K consecutive tool-call messages have had no `state_commit` (the
    count includes the current message and resets on a message with a commit or a new
    prompt; `1` is equivalent to `every`).

  Run it: `PI_STATE_MODE=paper pi -e dist/entrypoint/index.js`.

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

**Installation failures.** In `boundary` mode, `installPiState` checks `replaceTranscript`
before schema lookup and throws if it is absent; `paper` mode does not check. Unreadable
or invalid schema files and a missing explicit `schemaPath` also throw. Missing default schema files use the lookup fallback.
A disabled or invalid kill switch, malformed cycle count, or invalid `PI_STATE_MODE` or
`PI_STATE_REQUIRE_COMMIT` logs to stderr and skips the mode's handlers.

**Known limitation: number precision.** `pi` coerces tool arguments before `execute`.
The patch arrives as parsed JS values; numbers are stored as `String(n)` and may have
already lost precision. Local tools have no hook for raw argument text.

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
