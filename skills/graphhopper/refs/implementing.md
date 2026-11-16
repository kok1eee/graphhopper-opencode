- researcher / librarian の使い分け（調査の内外分離。両方とも最安tier・read-only）:
  - researcher = repo**内**（定義・構造・呼び出し関係をgraft-firstで）。librarian = repo**外**
    （公式doc・仕様・実装例を webfetch / context7 で。URLと引用付き、判断なし。
    context7に無い一般web（issue・blog・changelog）は websearch、
    コード例は webfetch（grep.app の URL を直接）にフォールバック）
  - **モデル**: primary は `opencode-go/minimax-m3.1-flash-free`（無料枠）。枠切れ・遅いときは
    課金枠の `minimax/MiniMax-M3.1-Flash` に手動切替できる（割当表を書き換えて
    `bun scripts/gen-agents.ts` して再起動）
  - 独立した問いなら `graphhopper_invoke` で2体を**並列**に呼び、メインが統合する（discover fan-outと同型。
    1つの応答で2件をまとめて呼ぶ。`execute` の中ではない）
  - 外部問いが内部findingsに依存するなら**直列**にする（researcherで対象ライブラリ・版を
    特定してからlibrarianにdocを引かせる。逆順・同時投げは版ズレの温床）
  - researcherは外部調査を自分でやらずlibrarian委譲を提案し、librarianは判断を含めない（境界の二重化）
- **source編集は `hash` → `edit` のレシピで回す**（hash検証付き。素のedit/writeはフォールバック）。
  `edit` の拒否は throw なので、**編集ごとに捕まえて「適用済み」と「失敗」を返す**
  （途中まで適用された状態を取り違えない）。複数ファイルを1バッチで直せる:

  ```js
  // recipe: edit（implementing。execute に貼る）
  const edits = [
    { filePath: "src/a.ts", oldString: "…", newString: "…" },
    { filePath: "src/b.ts", oldString: "…", newString: "…" },
  ];
  const applied = [];
  for (const e of edits) {
    try {
      const h = await tools.graphhopper_hash({ filePath: e.filePath });
      const r = await tools.graphhopper_edit({
        filePath: e.filePath,
        expectedHash: h.sha1,
        oldString: e.oldString,
        newString: e.newString,
      });
      // graphhopper_edit は output スキーマ無し＝文字列が返る。no-goal 時だけ error 文字列
      if (typeof r === "string" && r.startsWith("error:")) throw new Error(r);
      applied.push(e.filePath);
    } catch (err) {
      return { applied, failed: { filePath: e.filePath, reason: String(err?.message ?? err) } };
    }
  }
  return { applied };
  ```

  - 同じファイルを続けて編集するときは、レシピのループが編集ごとに `hash` を取り直すので、
    そのまま edits に並べてよい（ループの外で何か足す必要は無い）
  - `failed` が返ったら applied の範囲だけ効いている。原因（hash 不一致＝別の変更が入った／
    oldString が複数一致）を直して残りを再実行する
  - `reason` が `no active goal` のときは、goal 外の作業なのでそのファイルだけ素の edit に落としてよい
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
  ただし **eval_cmd設定中はattemptを呼ばない**（idle evalが自動記録するため二重計数になる。
  手動の進捗メモが必要ならnoteに残す）。eval未設定時のみ自己申告フォールバックとして使う
- **evalは自動**: eval_cmd設定後はターン終了ごとにidle evalが走る。遷移しない場合は `graphhopper_status` で phase と eval_cmd を確認する（goal切替でeval_cmdは消える。start白紙が仕様）
  - `ok: false` が続き `fail_streak` が `stuck_threshold`（既定3）に達すると `escalate: true` が返る
  - `escalate: true` が返ったら `graphhopper_invoke(agent: "graphhopper-oracle")` に相談する。これまでの
    失敗試行（何を試して何が起きたか）を渡し、助言を受けて別のアプローチで再試行する
  - 同一goal内の2回目以降のoracle相談も `graphhopper_invoke` を再度呼ぶ（invoke に session 継続は無い）。
    prompt には前回の質問・助言の結論（採用/棄却した案）・現在の失敗ログを要約して渡す
  - **これはrouter gate（diffサイズ）とは別軸のタイミング判断**——無条件で毎回opusを呼ぶのではなく、
    本当に詰まった時だけ上位モデルのコストを払う graph engineering の分岐点
  - stuck 信号は2系統＋fail（いずれかで escalate。eval_cmd 運用では idle の eval 失敗文に自動追記される）:
    - `fail_streak`（連続失敗。`ok`・phase 遷移・resume でリセット。`recordAttempt` 側で判定）
    - 同一ファイル再編集（`stuck_edit_repeat` 既定5連。別ファイル・eval pass でリセット。
      `checkStuck` で判定＝進捗停滞系）
    - diff 停滞（`stuck_diff_stall` 既定4。ワーキングコピー差分が変わらない idle eval の連続。
      差分変化・eval pass でリセット。`checkStuck` で判定＝進捗停滞系）
  - 連続失敗が `max_eval_fails`（既定6）に達すると相談ではなく goal が pause する（giveUp）。修正して resume せよ
- 全タスクを completed か cancelled にしたら、refs/verifier.md の `recipe: start` を実行する
  （`router_check` はレシピの中で呼ばれる。単独で先に呼ぶ必要はない）
- goal start時に初期汚れ（前goal未コミット分）を自動snapshotし、遷移判定は実効diff（測定－初期値）で行う。
  statusの `initial_dirt` で確認可。実効0時は「未実装」と断定せず `router_check` 手動確認も可
