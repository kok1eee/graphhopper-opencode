# graphhopper-opencode — opencode v2 プロジェクト

global `~/.config/opencode/AGENTS.md` (CodeGraph / graft-first / rg制限) を継承。
以下はこの repo 固有の追加分のみ。

- バイナリは mise 管理の `opencode` を使うこと。バージョンは repo で固定せず `latest`（global 設定と同じ）に追従させる。
  `opencode --version` が上がったら、`package.json` の `@opencode/plugin`・`@opencode/theme` も同じ版に揃える。
  opencode v1 (1.18.x) でこのディレクトリを開かない
  (v1 global plugin が `.graphhopper/` を誤ランタイムで駆動する)。
- eval: `bun test && npx tsc --noEmit` (green を維持)。
- graphhopper ループは止まらず最後まで進める:
  - verifier が clean なら、同じターン内で `graphhopper_verifier_set`（`reason` 必須）→ `graphhopper_goal(complete)` まで続ける（done への遷移は complete が行う）。途中で報告して止まらない。
  - graphhopper 自身は opencode plugin のみ（graphhopper 用の MCP サーバと dynamic workflow は廃止した。graft 等の他 MCP は別）。
  - `execute` 内の呼び方: graphhopper の tool は `tools.graphhopper_goal(...)` のようにフラットに呼ぶ（`tools.graphhopper.graphhopper_goal` ではない）。
  - `shell` は `execute` の中では呼べない。直接ツールとして呼ぶ。
  - `execute` 内の `tools.xxx(...)` はすべて `await` する（`tools.search` も Promise）。同期なのはグローバルの `search(...)` だけ。
  - 呼ぶツール名はカタログかグローバル `search` で確認したものだけを使う。名前を推測して直接呼び出さない（codegraph は `tools.codegraph.codegraph_explore`）。
  - `Unknown tool ...` のようなツール呼び出しエラーは作業の失敗ではない。止まらず、呼び方を直して同じ操作をやり直す。
- `.graphhopper/config.json` / global `graphhopper.json` の割当表を変えたら
  `bun scripts/gen-agents.ts` して再起動
  (`.opencode/agents/*.md` は生成物で直接編集しない)。
- 大きな変更後は `graft build` (MCP graft server が index なしだと tool 0 件になる)。
- `.opencode/` は graft・素の `rg`/`fd` に見えない (dot-dir)。探索時は `rg --hidden` / Glob を使う。
- Go モデルで `Insufficient account funds` が出たら: env キーが stored (`auth.json`)
  より優先される。枯渇アカウントの env キーを unset して stored 個人キーを使うこと。
- 完了報告の形（作業を見ていない人が読む）:
  - 要点から書く。結論 → 入ったもの → 注意点の順。process の自慢（何回レビューした等）を先頭に置かない。
  - 専門用語を噛み砕く。ファイル名・関数名は必要なものだけ。
  - design の path（`.graphhopper/plans/<goal>.md`）と、commit した change を書く。commit していなければ、その旨と未 commit の変更（どのファイルか）を書く。
  - 再起動・再ログインなど利用者側の操作が要る変更は明記する。
  - 確かめていないこと（目視・実機・本番）を、できたことと混ぜずに分けて書く。
