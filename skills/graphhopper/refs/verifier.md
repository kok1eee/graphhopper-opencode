#### selector（任意・advisory-only）

polish前にlens編成の助言が欲しい場合のみ使う（現行routerは維持。省略可）。
判定は d1 decision-model（`LIQUID_API_KEY` 必須。約0.7秒・$0・決定的）:

1. `graphhopper_selector(design_excerpt, diff_stat)` を呼ぶ（design抜粋＋diff統計のみ。blast radiusは渡さない）
2. 返却の `lenses`（1-3件）を参考にする。3観点のNoulを各0.5閾値で判定し、全て未満なら「該当なし→general」。
   design抜粋が契約変更系キーワード（契約/migration/互換/breaking/schema）に当たるとrequirementを強制追加する
3. `fallback=true`（key未設定・API失敗等＝判定不能）の場合は従来router（advisor/polish）を継続せよ（general倒しはしない）。
   採否の決定はmain。toolは判定を返すだけ（advisory-only）

#### verifier（drift 検出）

`graphhopper_router_check` の `route` に従う。**いずれのrouteでも `graphhopper-verifier` への
第三者チェックは省略できない**（`graphhopper_verifier_set` はresultsが空だとエラーを返す機械ゲートがある。
自己レビューだけでのclean記録は不可能。level/targetの最終決定は機械集約される）:

- **route=advisor**（小diff）: `task(subagent_type: "graphhopper-verifier")` を**1回だけ**、
  `general`charterで呼ぶ。「実装がdesign.mdの意図から外れていないか・テストが実際のユーザーパスを
  検証しているか・変更がgoalに収束しているか、3観点をまとめてレビューせよ」と渡す。
  診断はメインが事前に1回実行し `.graphhopper/tmp/diag-<goal>.txt` に保存してpathを渡す
  （verifierの個別実行はbash denyで禁止。inline添付は3重トークン再発のため禁止）。
  verifierは添付診断を裏付け・反証に使え。LSPは補助線に留める（単一証拠源にしない）。
  ただし診断クリーン≠driftなし（挙動driftは診断に出ない）。
  添付が無ければ「診断未実行（理由）」を明記し、診断不在をcleanの根拠にしない。
  周辺探索はgraft-first（漁り読み禁止。graft/diffが指した関数・テスト単位のReadは可）。
  全文catして数える（cat | wc等）・同一範囲の再読は禁止。行特定はgrep/graftで行い、Readは1範囲1回。
  findingsには証拠状態を必ず付ける（typesafe流・失敗原因分離）: `裏付けあり` /
  `証拠不足` / `診断未実行` / `実行失敗`。原因不明のままlevelだけ付けない
   結果を `graphhopper_verifier_set(results: [{lens: "general", level}], reason: ...)` で記録
   （実行モデルがconfig既定と違う場合は `model` に明示。成績表の帰属に使う）
- **route=polish**（大diff・閾値超）: adversarial verifier fan-out を行う
  1. `task(subagent_type: "graphhopper-verifier")` を3回呼ぶ。それぞれ以下のcharterをプロンプトに含める:
     - requirement: 「実装がdesign.mdの意図から外れていないか（実装漏れ・解釈ズレ・スコープ逸脱）を検証せよ」
     - behavior: 「テストが実際のユーザーパスを検証しているか（モック過多・ハッピーパスのみ・エラー握り潰し）を疑え」
     - progress: 「変更がgoalに収束しているか（堂々巡り・残骸・goal無関係な混入）を見よ。未完了タスクが残っていないか、cancelled の理由が妥当かも見よ」
     進捗タスクの source of truth は `.graphhopper/todos/<goalId>.json`（design.md は planning 終端で immutable のため進捗の計測源にできない）。
     goalId は `.graphhopper/state.json` の `goal_id`、または `.graphhopper/todos/` 配下の唯一のファイル名から解決せよ。
     埋め込みは **MCP prompt 経路**（graphhopper-verifier-progress / -general がタスク一覧を直接埋め込む）。
     **plugin 経路**（task 直呼び）は一覧を埋め込まず、verifier agent の preamble が
     「progress lens / general charter では必ずこのストアを読む」と指示するので、
     lens 自身が `.graphhopper/todos/<goalId>.json` を読む。
     時間短縮のため3体は**並列**に投げてよい（MCP駆動では graphhopper_invoke を3連並列。入れ子のみ禁止）。
     charter定型文は MCP prompts（graphhopper-verifier-requirement/behavior/progress）にもある。
     並列時の注意: 各invokeは独立 `opencode run`（自前server＋MCP付きの重い処理）のため、
     同一モデル3連はprovider側rate limitのリトライ待ちになり得る。気になる場合は
     `delayMs` で数秒ずつ起動をずらす。実行中はheartbeatログが出る。キャンセルは子に
     伝播してkillされる（取り消し後の裏回りなし）。
     推奨は3並列＋ずらし（delayMs 0/5000/10000）。直列は遅いだけで安全性は変わらない
     - **並列 fan-out のモデルについて（2026-10-21 実測）**: `claude-oauth` はローカルプロキシ
       （http://127.0.0.1:8787/v1）1台に載る。3 lens をここへ同時投入すると
       `Timed out waiting for response headers` になりうる。**verifier の並列 fan-out は
       claude-oauth 以外（現在は minimax/MiniMax-M3.1-Flash）に割当済み**。
       claude-oauth 系を fan-out に入れる場合は、直列実行か delayMs ずらしで回避する。
       低価格/free枠モデル（deepseek 等）を混ぜた同時実行も避ける（枠のレート制限で待ち時間が増える）。
     - **simplify のモデル**: primary は `opencode-go/deepseek-v4.1-flash`（単発なので fan-out と違い
       レート制限の逼迫を受けない）。**遅い/枠切れのときは `claude-oauth/claude-sonnet-5-5` に手動切替**。
       割当表（`~/.config/opencode/graphhopper.json` の agents と `cascade.agents.quality`）を
       書き換えて `bun scripts/gen-agents.ts` して再起動すれば反映される。
- **deep休止**（2026-10-01改定：verifierが上位モデルに昇格し、上位モデルでの上書き先が無くなった。selector→lens選択の原則は維持。oracle級が必要なlensが出たら別途検討）。
- **モデル割当（2026-10-21 改定）**: criticは `claude-oauth/claude-haiku-5-5`
  （OAuth定額・quota消費軽・高速。Go枠切れ時は `opencode-go/deepseek-v4.1-flash`
  にフォールバックして呼べ。
  subagent呼び出しは `task()` が既定。束縛が古いセッションでは `graphhopper_invoke`
  を使う（coreの規則に従う）。
  割当の見直しは `/choice` で対話変更できる（変更後はTUI再起動）。
  **verifier（並列 fan-out）は `minimax/MiniMax-M3.1-Flash`**（claude-oauth の
  ローカルプロキシ逼迫を避けるため。枠切れ時は `opencode-go/minimax-m3.1-flash-free` 等へ切替可。
  自動切替は無いためmain判断で呼ぶ）。
  見逃し率はscoreboardで監視。
  researcher/librarian は `opencode-go/minimax-m3.1-flash-free`（無料枠の M3.1）、
  **simplifyは `opencode-go/deepseek-v4.1-flash`（primary。遅い/枠切れ時は `claude-oauth/claude-sonnet-5-5` に手動切替）**、oracleはopus-5-5、advisorはglm-5.3（Bedrock cross-region。coding特化・prompt cache対応。旧grok-4.7から2026-10-08に置換）。
  注意: session envに陳腐な `AWS_BEARER_TOKEN_BEDROCK` があるとSSOをshadowしてBedrock系が全滅する。
  `graphhopper_invoke` の子には渡さない（invoke.tsで除去済み）。直接 `opencode run` する場合は
  `env -u AWS_BEARER_TOKEN_BEDROCK` を付ける
- **diff肥大は検証コスト3倍**: polish routeは3lensが全差分を読む。748行級は1回で3×748行の
  コンテキスト消費。goalを小さく切ってadvisor（verifier×1）に収めるのが最大の節約。
  巻き戻しはさらに3倍するので、criticで初回品質を上げることも節約になる
   2. `graphhopper_diff_stash` でdiffを退避（`.graphhopper/tmp`配下。子権限で読めるため
      手動コピーは不要・禁止）し、各verifierには**返却pathを渡す**
      （inline 3重展開は禁止。3lensが全文を各々読むと3倍燃費になる）。
      読むのは `goal` / `.graphhopper/plans/<goal-id>.md` の内容 / 退避diffの差分範囲＋疑義点のみ。
      周辺探索はgraft-first（漁り読み禁止）。診断はメインが事前に1回実行し
      `.graphhopper/tmp/diag-<goal>.txt` に保存してpathを渡す（verifier個別実行は禁止）。
      behavior charterでは添付診断を証拠に使う
  3. drift（乖離）を検出したら**全件報告させる**（閾値カットしない。「重大なものだけ報告」のような保守的指示は書かない——過少報告を招く）
  4. 3体の結果（各charterの level。drift には target 必須）を `results` に詰め、
     `graphhopper_verifier_set(results: [...], reason: ...)` で1回記録する。
     level/target の最終決定は機械集約（いずれか drift → drift、target は
     implementing 優先）であり、メインの裁量で「重大なものだけ採用」といった
     後段フィルタはしない
