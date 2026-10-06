# graphhopper-opencode-v2

graphhopper state-machine plugin for **opencode v2** (`@opencode/cli` 2.0.x,
project-local install). Ported from `graphhopper-opencode` (v1, opencode 1.18.x).
v1 and v2 run side by side in separate directories.

## Which binary to use here

Always the project-local v2 binary:

```sh
./node_modules/.bin/opencode
```

Never open this directory with opencode v1 — the v1 global graphhopper plugin
would take over `.graphhopper/` with the wrong runtime (design g-muwhwj36 R-H5).
Conversely, never open the v1 directory with this binary.

## Layout

- `.opencode/plugins/graphhopper/` — v2 plugin entry (`Plugin.define`, default export)
- `agents/` — static subagent declarations (v2 `AgentEditor` has no `add`;
  the plugin only `update`s these at runtime, e.g. model assignment)
- `src/` — ported state machine (pure logic) + v2 plugin wiring
- `commands/`, `skills/` — slash commands and skills (same as v1)
- `.graphhopper/` — goal state (created on first run, gitignored except example config)

## Dev

```sh
bun test          # unit tests
npx tsc --noEmit  # typecheck
```
