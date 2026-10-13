# graphhopper-opencode

graphhopper state-machine plugin for **opencode v2** (`@opencode/cli` 2.0.28,
mise-managed). Ported from the v1 (opencode 1.18.x) implementation; the two run
side by side in separate directories.

- v2 (this repo): https://github.com/kok1eee/graphhopper-opencode
- v1 legacy: https://github.com/kok1eee/graphhopper-opencode-legacy

## Which binary to use here

The mise-managed v2 binary, pinned by this repo's `mise.toml`:

```sh
opencode
```

Never open this directory with opencode v1 — the v1 global graphhopper plugin
would take over `.graphhopper/` with the wrong runtime (design g-muwhwj36 R-H5).
Conversely, never open the v1 directory with this binary.

## Layout

- `.opencode/plugins/graphhopper/` — v2 plugin entry (`Plugin.define`, default export)
- `.opencode/agents/` — static subagent declarations (GENERATED, do not hand-edit)
- `src/` — ported state machine (pure logic) + v2 plugin wiring
- `scripts/gen-agents.ts` — agent declaration generator (single source: `src/agents.ts`)
- `.graphhopper/` — goal state (created on first run, gitignored except example config)
- `graft/` — repo context-graph cache (gitignored, regenerable)

## Operations

```sh
bun test && npx tsc --noEmit   # eval (must stay green)
```

Model assignment (who runs on what) lives in two tables, global
`~/.config/opencode/graphhopper.json` and project `.graphhopper/config.json`
(project wins per-agent). After changing either, regenerate + restart:

```sh
bun scripts/gen-agents.ts       # bake table into .opencode/agents/*.md
```

Why bake: v2 `AgentEditor` has no `add`, and `update()` runs before markdown
discovery (verified: catalog holds builtins only at transform time), so runtime
override does not stick. Static declarations are the effective mechanism;
the plugin's transform is best-effort only.

Refresh the context graph after large changes (MCP `graft` server needs it;
without an index it connects with 0 tools):

```sh
graft build
```

Headless smoke tests (all verified 2026-10-06/07):

```sh
opencode run --standalone --model claude-oauth/claude-sonnet-5-5 \
  --title ping "Call graphhopper_status and reply with ONLY its raw output."
```

Auth note: OpenCode Go resolves credentials with env (`OPENCODE_API_KEY`)
taking precedence over stored (`auth.json`). If the env key belongs to a
depleted account, every Go-model call fails with insufficient funds even when
another account is funded — unset the env key so the stored one applies.

## Known limitations (v2 platform)

- `.opencode/` is invisible to graft (dot-dirs never indexed) and to default
  `rg`/`fd` (hidden). Subagent search rules pin `rg --hidden`/Glob for it.
- `opencode run --standalone` sessions are ephemeral (not persisted to the DB).
- Agent `temperature` has no v2 field (carried as `request.body`, not yet sent
  by the runner). `ctx.permission.rules` doubling was skipped (replace
  semantics could wipe user rules; throw-gate is primary and proven).
- d1 judgments (`graphhopper_decide`/`graphhopper_selector`) call the Liquid
  decisions API over HTTPS directly — they never created sessions, so no
  session-API migration applies (P2-2 closed as misconceived).
