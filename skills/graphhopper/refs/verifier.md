#### 角度の選び方（verify が自動で行う）

verify は固定の lens を持たない。変更ごとに角度（疑うこと＋見る範囲）を選んで並列に走らせる。

- 常設は `agreement`（合意・意図との照合）1 つ。ほかは verifier の専任の 1 回（選ぶ役）が、
  角度の一覧（`src/angles.ts`）から選ぶ。選ぶ数（枠）は難易度と変更の大きさで決まる（easy は 1／それ以外は `router_check` の route が polish なら 4、advisor か未判定なら 2。ここの advisor は小さい diff を指す route 名で、相談役の `graphhopper-advisor` とは別物。`agreement` は別で、この数に入らない）。
  選ぶ役が失敗したら既定の角度（wiring・test-efficacy・cleanup・behavior）で進め、本文に出る
- メインは `add` で角度を足せる（枠の外。1 つの diff につき 2 個まで）。一覧に無い角度は `title`/`doubt` が必須
- 前の diff で drift だった角度は次の diff へ持ち越され、`prior`（valid/invalid/unresolved）で前回の指摘の扱いを判定する。
  `unresolved` があれば drift 扱い
- 1 巡目に drift があれば、同じ種類の問題を探す追い検証 `siblings` が 1 回だけ続く（最大 2 巡）
- **diff トリガ付きチェック**（`refs/checks.md`）: 変更の形（触った path と変わった行）から機械的に
  決まる確認。当たった項目は選ぶ役の判断に依らず**必ず角度として入る**（`angle_slots` の枠を消費しない。
  1 回の verify で記載順の先頭から最大 4 件。4 件を超えて落ちた項目はその回は走らないだけで枠にも数えない）。
  一覧の書き方と項目は `refs/checks.md`。当たりすぎたらトリガを狭める
- `router_check` の `angle_slots` は上の枠の数（持ち越した角度は `add` と check 由来を除き枠に数えるので、選ぶ役が選ぶのは残りだけ）。固定の lens 名は返らない

#### verify（Code Mode レシピ）

polish/verify は **Code Mode で実行する**。`execute` の中で `tools.*` を `await` する。
`task()`/`subagent` は `execute` のカタログに無い（呼べない）。同期の verifier 呼び出しは
`graphhopper_verify`（内部で `opencode run` を待つ）が担う。手順を散文で追わず、下の
ブロックを**上から順に** `execute` に貼る。`return` は `execute` の戻り値になる。

**route=advisor（小diff）: 2ブロックを連結して1バッチ**

```js
// recipe: start
const r = await tools.graphhopper_router_check({});
if (r.simplify) {
  const s = await tools.graphhopper_diff_stash({});
  const proposal = await tools.graphhopper_invoke({
    agent: "graphhopper-simplify",
    prompt:
      "3レンズ（再利用・品質・効率）で整理案を出せ。適用はしない（提案のみ）。\n" +
      "goal id は .graphhopper/state.json の goal_id。design: .graphhopper/plans/<goal_id>.md\n" +
      `diff: ${s.path}\n`,
  });
  return { stop: "simplify", diff: s.path, proposal };
}
```

```js
// recipe: tail
await tools.graphhopper_phase({ phase: "polish" }); // 冪等（既にpolishなら無変化）。implementingのまま実行しても通す
const d = await tools.graphhopper_diag({});
if (d.status === "failed" || d.status === "timeout") return `診断で止まった（${d.status}）: ${d.path}\n${d.tail}`;
const s = await tools.graphhopper_diff_stash({});
const v = await tools.graphhopper_verify({});
if (v.missing.length) return { stop: "verify", missing: v.missing, bodies: v.bodies };
const recorded = await tools.graphhopper_verifier_set({
  results: v.results,
  reason: v.summaries.map((x) => `${x.lens}: ${x.summary}`).join(" / "),
  model: v.results[0]?.model,
});
if (recorded.level === "drift") {
  return { stop: "drift", target: recorded.target, bodies: v.bodies, next: recorded.next };
}
// phase(done) を自分で呼ばない: done への遷移は completeGoal が行う。先に done にすると
// complete が拒否されたときに戻れない（done から出る遷移が無い）
const completed = await tools.graphhopper_goal({ action: "complete" });
if (typeof completed === "string" && completed.startsWith("error:")) {
  return { stop: "complete", reason: completed };
}
return { stop: "clean", summaries: v.summaries, completed };
```

**route=polish（大diff）: 2バッチ**

1. `recipe: start` だけを実行する（`router_check` が simplify 要、`diff_stash` → simplify の提案が返る）
2. 提案を適用する（下の「simplify の適用」。ここで編集するのでバッチが切れる）
3. `recipe: tail` を実行する（`diag` → `diff_stash` → `verify` → 記録 → 完了）

`verify` は計画（今の diff の角度の組）を保存し、同じ diff 指紋のあいだは保存済みの結果と合成する。
`lens` を渡せば計画のうち一部だけ再実行できる（判定不能だった角度だけ投げ直せる）。例:
`tools.graphhopper_verify({ lens: ["wiring"] })`（配列。値は `v.lenses` の id。計画に無い id はエラー）。
`add` で角度を足す: `tools.graphhopper_verify({ add: [{ id: "security", title: "認可の抜け", doubt: "認可チェックを飛ばす経路がないか" }] })`。
`verifier_set` は計画の角度を全部含む results だけ受け付ける（足りない・計画外は拒否。`siblings` だけ計画外でも可）。追い検証が走ると `v.results` に `siblings` が入るので、そのまま渡す（`v.lenses` は計画の id 一覧。`siblings` は持ち越したときだけ入る）。

**順序（ルール文書を変えた goal と drift の扱い）**

- `AGENTS.md`・`skills/**.md`・`src/agents.ts` を変えた goal は、`recipe: tail` の**前に**
  下の「ルール文書の usability」を済ませる。usability の指摘で文書を直すと差分が変わるので、
  `tail`（diag → diff_stash → verify → 記録 → complete）は最終版で1回だけ回す
- `stop: "drift"` が返ったら: `recorded.next` に従い、target=implementing なら
  `graphhopper_phase({ phase: "implementing" })` で戻して直す。直したら `recipe: start` から
  やり直す（advisor なら `start`＋`tail` を1バッチ。ただし下の usability が要る goal は
  usability を挟むので2バッチ）。drift を握り潰して `complete` はできない。
  ルール文書を直した場合は、やり直す前に usability をもう一度通す（下の usability 節の手順から）
- **差し戻しの回数に上限がある**（`verify_drift_max`、既定 3。0 以下で無効）。`verifier_set` が drift を記録するたびに
  数え、上限に達すると goal を pause し、出力に `paused: true`・角度ごとの差し戻し回数（再開前の分も含む
  累計なので、上限判定の回数とは合計が一致しないことがある）・選択肢を返す（history の `verify_cap`）。
  このときは**止まってユーザーに聞く**。そのまま続けるなら `goal(resume)`（回数は数え直す）。そのあと
  巻き戻し先が implementing の drift なら `graphhopper_phase({ phase: "implementing" })` で戻して直し、
  design/requirements なら人間待ち。決めた内容から見直すなら `goal(resume)` のあと
  `graphhopper_phase({ phase: "designing" })`（resume が pause 時の phase に戻すため、順序は resume が先）。勝手に resume しない。この停止はループ検知の `loop_stop_count` には
  数えない（`loop_stop_max` で resume を塞がない）
- `goal(complete)` は throw せず**拒否理由の `error:` 文字列**を返す（レシピは `stop: "complete"`
  で返す）。理由ごとの対応:
  - usability が未記録・drift → usability を記録してから
    `await tools.graphhopper_goal({ action: "complete" })` だけ再実行（usability の drift で
    文書を直した場合は差分が変わるので、diff ゲートの対応＝`tail` の再実行へ）
  - 検証後に差分が変わった（diff ゲート）→ 再検証（`recipe: tail` をもう一度）
  - phase は polish のままなので巻き戻しは要らない（`tail` は `phase(done)` を呼ばない。
    done への遷移は `completeGoal` が行う）

#### 採点基準の凍結（design g-mwmnvx3x 判断1）

- `verify` は goal 開始時に凍結した共通ルールと出力の形で prompt を作る（角度の文面は凍結しない）。
  goal 中に `src/prompts.ts` / `src/verify.ts` を直しても、その goal の判定には効かない
  （次の goal から効く）。進捗タスク・phase などの動的部分は毎回現行から作る
- 凍結ファイル（`.graphhopper/plans/<goal>.rubric.json`）が無い・内容が合わないと
  `verify` は止まる（`rubric_tampered`）。**verify に force は無い**。改ざん前に clean を取っていれば
  `complete` は `verifier_self_modified` ゲートの設定に従う（既定 observe は記録して通る）。
  取っていなければ `verifier` ゲートで complete も止まる。回避は「採点基準を戻して再検証」か
  「新しい goal」。`graphhopper_goal(action: "complete", force: true)` は全ゲートを飛ばし、
  observe の記録も残らない
- `verifier_self_modified` の対象は、採点コード（`src/verify.ts` / `src/prompts.ts` / `src/angles.ts` / `src/verdict.ts`）と
  verifier の system prompt（agent md）、および凍結ファイルの欠落・不一致（改ざん）。
  `verify` では記録のみ（改ざんは除く。改ざんは verify を止める）、`complete` でゲート設定に従う
- 前の形（`v` 無し）の凍結ファイルは読まれない。欠落と同じ扱いで、上と同じく `verify` は `rubric_tampered` で止まる

#### 何が自動で守られるか（散文で守らなくてよい）

- **path の受け渡し**: `verify` が design・意図ログ・退避 diff・診断の path を自分で解決して
  prompt に入れる（手で書き写さない。渡し忘れは起こらない）
- **順序**: `await` が保証する。2.3.0 の `task()` のような「結果が届く前に記録するな」という
  注意は不要（background にならない）
- **前提の照合**: 退避 diff・診断・現在の diff の指紋が3つ揃わなければ `verify` は throw する。
  古い diff を検証したまま complete で初めて止まる、という無駄が出ない
- **判定の読み取り**: 出力契約（出力の最初に出す json フェンス `level`/`target`/`summary`。本文が出力上限で切れても判定は読める）は `verify` が
  prompt に足し、`verify` が読む。読めなければ `missing` に入り、記録に進まない
- **集約**: `level`/`target` の決定は `verifier_set` の機械集約（`state.aggregateVerdicts`）。
  レシピは `recorded.level` を見るだけで、メインの裁量で drift を握り潰せない
- **自己完結**: `verifier_set` は results が空だと機械的に拒否する（self-graded 完了防止）。
  route=advisor でも第三者チェック（verifier）は省略できない

#### simplify の適用（メインの仕事。agent は提案のみ）

- 各 finding を該当ファイルで Read して裏付け（Iron Law）
- critical: 挙動不変・局所的なものだけ自動適用（typo / rename / 冗長な中間変数削除）。
  interface・signature・新規依存は high 扱いで人間に提示
- high: 人間に確認してから修正 / medium・note: 報告のみ
- 適用後は `recipe: tail` を実行する（`diag` が eval_cmd を回すので、機械確認を兼ねる）
- route は simplify 前の記録値に固定する（適用後に再測定して route を変えない）

#### 診断（graphhopper_diag）

`graphhopper_diag` は goal の `eval_cmd` を実行し、`.graphhopper/tmp/diag-<goal>.txt` に
コマンド・終了コード・diff 指紋・出力の末尾 200 行を書いて path を返す（実行するのは eval_cmd
だけで、任意のコマンドは渡せない）。verifier はこのファイルを補助証拠として読む。

- `status: "failed"`・`"timeout"` では verifier に進まない（直すものがある証拠）
- `status: "unset"`（eval_cmd 未設定）でもファイルは作られ、verifier は走る。その場合 verifier は
  「診断未実行（理由）」を明記し、診断の不在を clean の根拠にしない
- **診断クリーン≠driftなし**（挙動 drift は診断に出ない）

#### モデル割当と起動ずらし

- 割当は config（`~/.config/opencode/graphhopper.json` の `agents["graphhopper-verifier"]`）で決まる。
  この文書にモデル名を書かない（実設定と食い違うため）。変えたら `bun scripts/gen-agents.ts` と
  セッション再起動
- **角度は 5 秒ずつずらして起動する**（`verify` の既定 `delayMs: 5000`）。verifier が
  単一プロキシの provider（claude-oauth 等）に載っていると、同時投入で
  `Timed out waiting for response headers` になりうる。ずらしは最大 10 秒で、待ち時間の損は小さい
- `verify` の `model` は config の `model_allow` / `model_deny` で機械的に検査される。
  deny 一致は拒否して止まる（フォールバックしない）。止められたら config を直す
- 高額モデル（Go の Kimi/GPT 等、月枠が小さいもの）は deny に入れるのが既定運用。
  cascade の切替先（baseline/escalate/quality 等）も同じ deny で拒否される

#### ルール文書の usability（design g-mwfltxyt）

対象は `AGENTS.md`・`skills/**.md`・`src/agents.ts`。変更した goal は complete の前に記録が必要。

1. 先に `graphhopper_diff_stash` で差分を最新化し、返った path を控える
   （goal id は `graphhopper_status` の `(<goal id>)`）
2. `graphhopper_invoke(agent: "graphhopper-usability", prompt: ...)` で確認する。
   prompt には「変更した文書のパス」「diff の path」「意図ログ
   `.graphhopper/plans/<goal>.intent.md`（存在する場合だけ。無ければ『意図ログなし』と書く）」
   を書く。子はこれらを読んで検証する
3. 結果を `graphhopper_usability_set(level: clean|drift|skipped, reason: ...)` で記録する。
   clean=問題なし / drift=指摘を直して手順1から再実行 /
   skipped=文言・typo のみで挙動や手順が変わらない等、確認が不要と判断した場合（reason 必須）
4. agent が見つからない場合は `bun scripts/gen-agents.ts` を実行して再試行する
   （束縛が古いセッションでは `graphhopper_invoke` を使う）

記録なし・drift・レビュー後の文書変更は complete が止まる。迂回は
`graphhopper_goal(action: "complete", force: true)`（意図と理由を .log.md に残す）。

#### 意図ログ（design g-mwebh9vl）

goal 開始時の会話が `.graphhopper/plans/<goal>.intent.md` に `me:` / `assistant:` ラベル付きで
保存される（plugin 経路のみ）。agreement 角度と advisor はこれを読み、決定記録や実装が
ユーザーの意図からズレていないかを見る（`verify` が agreement にだけ path を渡す）。
他の角度と実装 subagent には渡さない（決定を再審議して止まるため）。
既知のキーはマスクするが best-effort で、会話は verifier/advisor のモデル提供元に送られる。
コンパクション境界より前の履歴は取れないことがある。

#### diff ゲート（design g-mwd3n5bo）

**verifier clean の後に差分を変えると `complete` は止まる**。`verifier_set` が検証時点の
差分の sha1 を記録し、complete 時に現在値と照合する。止められたら冒頭の `recipe: tail` を
もう一度回す。人間が問題ないと判断した場合だけ `force: true` を使う
（監査の `goal_complete` に `diff_gate: forced` が残る）。VCS が無い・baseline が取れない
環境ではゲートは無効（`diff_gate: unavailable`）。

**測る範囲はゲート・`diff_stash`・`verify` の指紋で共通**: `.graphhopper/`
配下（`state.json`・`history.jsonl`・`tmp/`・`plans/` など。graphhopper 自身が goal 中に書くもの）は
入らない。入るのは `.graphhopper/config.json` と `.graphhopper/config.example.json` の 2 つだけ
（design g-mwiu6lcj）。そのため `.graphhopper/` を gitignore していない repo でも、graphhopper が
goal 中に書くファイル（`state.json`・`history.jsonl`・退避 diff・`plans/<goal>.md`・
`plans/<goal>.log.md`）でゲートが止まることはない。検証後にこの 2 つの設定を変えた場合は、
`force` ではなく同じく冒頭の `recipe: tail` で再検証する（この 2 つの変更は `diff_stash` の
退避 diff にも入る）。止まった原因が分からないときは
`graphhopper_diff_stash` の `path` を読んで、何が差分に入っているか確かめる。

- **diff 肥大は検証コスト3倍**: polish routeは複数の角度が差分（作業ファイル除く）を読む。748行級は1回で角度数×748行の
  コンテキスト消費。goalを小さく切って枠の少ない route に収めるのが最大の節約。
  巻き戻しはさらに3倍するので、designing で合意を固めて初回品質を上げることも節約になる
- **drift は全件報告させる**（閾値カットしない。「重大なものだけ報告」のような保守的指示は
  過少報告を招く——`verify` の prompt は共通ルールを使うので、この原則は自動で入る）
- CI は `bun scripts/gen-agents.ts --check-policy` で、commit 済みの
  `.graphhopper/config.example.json` をポリシー源に catalog と cascade 設定を検査する。
  ローカルでは project catalog に加えて `~/.config/opencode/agents` が存在すれば
  global catalog も同じポリシーで検査する（`[global]` ラベル。CI には無いためローカル限定の保証）。
  見逃し率はscoreboardで監視。
