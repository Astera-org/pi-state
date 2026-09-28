# Running `pi` + `pi-state` standalone

How to bound a `pi` coding-agent session's prompt with `pi-state` on a single
machine: no server, no database, no MCP connection, no other service of any
kind. Two files under `.pi-state/`, two local tools (`state_get`,
`state_commit`), and a `pi` binary that supports transcript replacement.

## 1. Install `pi`

Either of `pi`'s own documented installs gets you a `pi` binary:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`pi-state` additionally needs its `pi` to expose the extension API
`pi.replaceTranscript` — this is how it bounds the prompt (see "Run it"
below). **Whether the version you get from the commands above has it is not
guaranteed by the version number alone.** As of `@earendil-works/pi-coding-agent@0.87.1`
(the latest published version at the time of writing), the npm-published
package contains no `replaceTranscript` anywhere — not in its built `dist/`,
not in its own bundled `docs/extensions.md` — confirmed by downloading that
exact tarball (`npm pack @earendil-works/pi-coding-agent@0.87.1`) and
grepping it. A `pi` build that does carry `replaceTranscript` (for example, a
more recent checkout of the `pi` source tree, built locally) is required
instead of that published package.

Verify your own `pi` before relying on `pi-state`:

```bash
grep -rl replaceTranscript "$(dirname "$(readlink -f "$(which pi)")")"
```

If nothing matches, `pi-state` will refuse to install rather than silently
running a state loop that can never take effect (see "Troubleshooting"
below) — get a `pi` build that includes the feature first.

## 2. Install `pi-state`

```bash
pi install git:github.com/Astera-org/pi-state
```

`pi install ./pi-state` works the same way from a local checkout, and
`pi -e git:github.com/Astera-org/pi-state` tries it for one invocation
without persisting the install. `pi install <source> -l` installs
project-locally instead of into your global settings. See `pi install --help`
for the full set of install sources and flags.

## 3. Write `.pi-state/schema.json`

`pi-state` has no default schema — you declare every key your agent's
durable state (`Σ`) may hold, relative to `pi`'s working directory:

```json
{
  "keys": {
    "objective": { "type": "string", "desc": "what the agent is trying to accomplish" },
    "step": { "type": "number", "desc": "how many turns since the objective last changed" }
  }
}
```

Grammar notes (`src/agentstate/schema.ts`):

- `keys` is a closed set — the agent can only ever write the keys you name here.
- Each key has exactly one `type`: `string`, `number`, `bool`, `object`, or `list`.
  A `list` key must also declare `maxItems` (an unbounded list is refused).
- `desc` is optional prose, capped at 160 bytes — it ships in the system
  prompt of every request, so keep it to a clause.
- `maxStateBytes` is optional. Omit it (as above) and the cap is sized
  automatically instead — see "Configure" below.

A missing or empty schema file is not a usable default: an empty `keys` set
refuses every non-empty patch, so `pi-state` fails installation loudly
instead of registering a `state_commit` that could never succeed (see
"Troubleshooting").

## 4. Run it

```bash
cd /path/to/your/project   # must contain .pi-state/schema.json
pi
```

**Confirm the tools are registered.** Ask the agent to call `state_get`.
Its result carries the declared keys, their types, and the current byte cap,
even before anything has been committed:

```json
{"ok":true,"version":0,"doc":{},"exists":false,"note":"no state yet — commit with version 0 to create it","declaredKeys":["objective","step"],"declaredTypes":{"objective":"string","step":"number"},"maxStateBytes":4096}
```

Then have it call `state_commit` with `version: 0` and a patch, e.g.
`{"objective": "set up pi-state", "step": 1}`. A successful result returns
the merged document at `version: 1`.

**Confirm the prompt bounds.** Once a turn's `state_commit` is accepted,
`pi-state` replaces `pi`'s transcript at the end of that turn with `[Σ, the
newest user message, the last few trailing tool cycles]` instead of full
history — a durable boundary `pi` itself now constructs context from, not a
one-off request rewrite. The clearest way to see it happening is to watch
per-request token usage in `--mode json`:

```bash
pi --mode json
```

Look at the `usage` field on `message_update`/`message_end` records. Before
any `state_commit`, input-token usage grows with the conversation as usual.
After one is accepted, later turns' usage stops tracking the conversation's
length — the model is only ever being sent Σ plus a handful of trailing tool
cycles, no matter how long the session runs.

To smoke-test a local checkout of `pi-state` without installing it first,
point `-e` straight at the built entrypoint:

```bash
pi -e /path/to/pi-state/dist/entrypoint/index.js
```

## 5. Configure

No environment variable is required — installing the extension and
declaring a schema is enough on its own to bound the prompt. Three variables
tune or override that default behavior (`src/entrypoint/env.ts`):

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_STATE_LOOP` | On/off kill switch for the whole state loop. Unset or a recognized affirmative (`1`/`true`/`yes`/`on`, case-insensitive) leaves it **on**; a recognized negative (`0`/`false`/`no`/`off`) turns it **off**; anything else is unrecognized and also refuses (fails closed) | **on** |
| `PI_STATE_WINDOW_CYCLES` | N, the number of trailing tool cycles kept alongside Σ after a boundary. Must be a plain base-10 integer in `0..20`, or it's treated as invalid and the loop refuses to install | `4` |
| `PI_STATE_CONTEXT_WINDOW_TOKENS` | Manual stopgap for auto-sizing (below): the active model's context window in tokens, for a `pi` this extension can't otherwise learn it from | unset |

**`maxStateBytes` vs. auto-sizing** (`src/agentstate/schema.ts`,
`src/entrypoint/autocap.ts`): a schema's `maxStateBytes` caps the size of Σ's
canonical JSON.

- **Explicit**: set `maxStateBytes` in `schema.json` and it always wins,
  full stop — no ceiling is enforced on it, and no auto-sizing logic ever
  touches it.
- **Auto (the default when `maxStateBytes` is absent or `0`)**: the cap is
  sized as `autoMaxStateBytesPercent` (1–100, defaults to `65`) percent of
  the active model's context window, at roughly 4 bytes per token. The
  context window comes from `pi`'s own extension API when it reports the
  active model (re-resolved on session start and on every model switch); if
  that's unavailable, `PI_STATE_CONTEXT_WINDOW_TOKENS` is used as a
  stopgap. If neither ever resolves, the cap falls back to a fixed 4096
  bytes.

## 6. Troubleshooting

**Missing schema file** — `pi-state` refuses to install:

```
[pi-state] no schema file at .pi-state/schema.json — declare your agent's Σ shape there (the JSON grammar agentstate.parseSchema accepts: {"keys":{...},"maxStateBytes":N}) before pi-state can register state_commit
```

Fix: create `.pi-state/schema.json` as in "Write `.pi-state/schema.json`" above.

**`pi` has no `replaceTranscript`** — `pi-state` refuses to install, before
even reading the schema file:

```
[pi-state] this pi exposes no replaceTranscript — pi-state cannot bound the prompt on this host, so it refuses to install rather than run a state loop that can never take effect
```

Fix: use a `pi` build that exposes `replaceTranscript` — see "Install `pi`" above.
