# graphhopper-opencode — opencode v2 プロジェクト

global `~/.config/opencode/AGENTS.md` (CodeGraph / graft-first / rg制限) を継承。
以下はこの repo 固有の追加分のみ。

- バイナリは mise 管理の `opencode` (2.0.32 pin, repo の `mise.toml`) を使うこと。
  opencode v1 (1.18.x) でこのディレクトリを開かない
  (v1 global plugin が `.graphhopper/` を誤ランタイムで駆動する)。
- eval: `bun test && npx tsc --noEmit` (green を維持)。
- `.graphhopper/config.json` / global `graphhopper.json` の割当表を変えたら
  `bun scripts/gen-agents.ts` して再起動
  (`.opencode/agents/*.md` は生成物で直接編集しない)。
- 大きな変更後は `graft build` (MCP graft server が index なしだと tool 0 件になる)。
- `.opencode/` は graft・素の `rg`/`fd` に見えない (dot-dir)。探索時は `rg --hidden` / Glob を使う。
- Go モデルで `Insufficient account funds` が出たら: env キーが stored (`auth.json`)
  より優先される。枯渇アカウントの env キーを unset して stored 個人キーを使うこと。
