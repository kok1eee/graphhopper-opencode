- researcher / librarian の使い分け（調査の内外分離。両方とも最安tier・read-only）:
  - researcher = repo**内**（定義・構造・呼び出し関係をgraft-firstで）。librarian = repo**外**
    （公式doc・仕様・実装例を webfetch / context7 で。URLと引用付き、判断なし。
    context7に無い一般web（issue・blog・changelog）はwebsearch MCP（Exa）、
    コード例はgrep.app MCPにフォールバック）
  - **モデル**: primary は `opencode-go/minimax-m3.1-flash-free`（無料枠）。枠切れ・遅いときは
    課金枠の `minimax/MiniMax-M3.1-Flash` に手動切替できる（割当表を書き換えて
    `bun scripts/gen-agents.ts` して再起動）
  - 独立した問いなら `task()` で2体を**並列**に呼び、メインが統合する（discover fan-outと同型）
  - 外部問いが内部findingsに依存するなら**直列**にする（researcherで対象ライブラリ・版を
    特定してからlibrarianにdocを引かせる。逆順・同時投げは版ズレの温床）
  - researcherは外部調査を自分でやらずlibrarian委譲を提案し、librarianは判断を含めない（境界の二重化）
- **進捗タスクの完了申告（`graphhopper_todo`）**: design.md の「実装タスク列」セクションが
  designing→implementing 遷移時に todo ストア（`.graphhopper/todos/<goalId>.json`）へ seed される。
  タスクを1つ終えるたびに `graphhopper_todo(action: "done", id: "tN")` で申告する。
  進行中は `action: "start"`、やらないと判断したものは `action: "cancel"` ＋`reason` 必須、
  実装中に増えたものは `action: "add"`、一覧は `action: "list"`。
  **未完了タスク（pending / in_progress）が1件でも残ると polish へ遷移できない**
  （eval_cmd が pass しても同じ。ゲート拒否メッセージに残りタスクが列挙される）。
  したがって「全タスク実施したら router_check を呼ぶ」の**前に**、
  全タスクを completed か cancelled にしておくこと
- **実装試行のたびに `graphhopper_attempt(ok, note)` を呼ぶ**（成否をコード側で機械カウントする）。
  ただし **eval_cmd設定中はattemptを呼ばない**（idle/MCP-evalが自動記録するため二重計数になる。
  手動の進捗メモが必要ならnoteに残す）。eval未設定時のみ自己申告フォールバックとして使う
- **evalのskip切り分け**: `graphhopper_eval` のskip文面は条件別（phase行／eval_cmd行の両出し＋root表記）。`phase=designing`なら遷移が先、`eval_cmd未設定`なら再設定が先。goal切替でeval_cmdは消える（start白紙が仕様）。`error: no active goal（root=...）`が出たらset時と解決rootが違う（明示rootで揃えよ）。evalはsessionを見ないため未bindは無関係
  - `ok: false` が続き `fail_streak` が `stuck_threshold`（既定3）に達すると `escalate: true` が返る
  - `escalate: true` が返ったら `task(subagent_type: "graphhopper-oracle")` に相談する。これまでの
    失敗試行（何を試して何が起きたか）を渡し、助言を受けて別のアプローチで再試行する
  - 同一goal内の2回目以降のoracle相談は新規ではなく `task(task_id: "<前回のID>")` で同subagent継続として呼ぶ（OmOのresume=session_id相当。文脈を失わず重複説明を省く）
  - **これはrouter gate（diffサイズ）とは別軸のタイミング判断**——無条件で毎回opusを呼ぶのではなく、
    本当に詰まった時だけ上位モデルのコストを払う graph engineering の分岐点
  - stuck 信号は2系統＋fail（いずれかで escalate。eval_cmd 運用では idle の eval 失敗文に自動追記される）:
    - `fail_streak`（連続失敗。`ok`・phase 遷移・resume でリセット。`recordAttempt` 側で判定）
    - 同一ファイル再編集（`stuck_edit_repeat` 既定5連。別ファイル・eval pass でリセット。
      `checkStuck` で判定＝進捗停滞系）
    - diff 停滞（`stuck_diff_stall` 既定4。ワーキングコピー差分が変わらない idle eval の連続。
      差分変化・eval pass でリセット。`checkStuck` で判定＝進捗停滞系）
  - 連続失敗が `max_eval_fails`（既定6）に達すると相談ではなく goal が pause する（giveUp）。修正して resume せよ
- 全タスク実施したら `graphhopper_router_check` を呼ぶ（diffサイズを機械測定してrouteを決める）
- goal start時に初期脏れ（前goal未コミット分）を自動snapshotし、遷移判定は実効diff（測定－初期値）で行う。
  statusの `initial_dirt` で確認可。実効0時は「未実装」と断定せず `router_check` 手動確認も可
