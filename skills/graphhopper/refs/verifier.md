#### selector（任意・advisory-only）

polish前にlens編成の助言が欲しい場合のみ使う（現行routerは維持。省略可）。
判定は d1 decision-model（`LIQUID_API_KEY` 必須。約0.7秒・$0・決定的）:

1. `graphhopper_selector(design_excerpt, diff_stat)` を呼ぶ（design抜粋＋diff統計のみ。blast radiusは渡さない）
2. 返却の `lenses`（1-3件）を参考にする。3観点のNoulを各0.5閾値で判定し、全て未満なら「該当なし→general」。
   design抜粋が契約変更系キーワード（契約/migration/互換/breaking/schema）に当たるとrequirementを強制追加する
3. `fallback=true`（key未設定・API失敗等＝判定不能）の場合は従来router（advisor/polish）を継続せよ（general倒しはしない）。
   採否の決定はmain。toolは判定を返すだけ（advisory-only）

#### verify（Code Mode レシピ）

polish/verify は **Code Mode で実行する**。`execute` の中で `tools.*` を `await` する。
`task()`/`subagent` は `execute` のカタログに無い（呼べない）。同期の verifier 呼び出しは
`graphhopper_verify`（内部で `opencode run` を待つ）が担う。手順を散文で追わず、下の
ブロックを**上から順に** `execute` に貼る。`return` は `execute` の戻り値になる。

**route=advisor（小diff）: 2ブロックを連結して1バッチ**

```js
// recipe: start
const r = await tools.graphhopper_router_check({});
if (r.escalated) return `昇格して designing に戻った（design.md を肉付けし critic 1回）: ${r.next}`;
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

`verify` は編成（polish=3lens / advisor=general×1）を `router_check` と同じ関数で決める。
`lens` を渡せば一部だけ再実行できる（同じ diff 指紋のときだけ保存済みの結果と合成するので、
1 lens だけ判定不能だったときにその lens だけ投げ直せる）。例:
`tools.graphhopper_verify({ lens: ["behavior"] })`（配列。値は `requirement`/`behavior`/`progress`/`general`）。

**順序（ルール文書を変えた goal と drift の扱い）**

- `AGENTS.md`・`skills/**.md`・`src/agents.ts` を変えた goal は、`recipe: tail` の**前に**
  下の「ルール文書の usability」を済ませる。usability の指摘で文書を直すと差分が変わるので、
  `tail`（diag → diff_stash → verify → 記録 → complete）は最終版で1回だけ回す
- `stop: "drift"` が返ったら: `recorded.next` に従い、target=implementing なら
  `graphhopper_phase({ phase: "implementing" })` で戻して直す。直したら `recipe: start` から
  やり直す（advisor なら `start`＋`tail` を1バッチ。ただし下の usability が要る goal は
  usability を挟むので2バッチ）。drift を握り潰して `complete` はできない。
  ルール文書を直した場合は、やり直す前に usability をもう一度通す（下の usability 節の手順から）
- `goal(complete)` は throw せず**拒否理由の `error:` 文字列**を返す（レシピは `stop: "complete"`
  で返す）。理由ごとの対応:
  - usability が未記録・drift → usability を記録してから
    `await tools.graphhopper_goal({ action: "complete" })` だけ再実行（usability の drift で
    文書を直した場合は差分が変わるので、diff ゲートの対応＝`tail` の再実行へ）
  - 検証後に差分が変わった（diff ゲート）→ 再検証（`recipe: tail` をもう一度）
  - phase は polish のままなので巻き戻しは要らない（`tail` は `phase(done)` を呼ばない。
    done への遷移は `completeGoal` が行う）

#### 何が自動で守られるか（散文で守らなくてよい）

- **path の受け渡し**: `verify` が design・意図ログ・退避 diff・診断の path を自分で解決して
  prompt に入れる（手で書き写さない。渡し忘れは起こらない）
- **順序**: `await` が保証する。2.3.0 の `task()` のような「結果が届く前に記録するな」という
  注意は不要（background にならない）
- **前提の照合**: 退避 diff・診断・現在の diff の指紋が3つ揃わなければ `verify` は throw する。
  古い diff を検証したまま complete で初めて止まる、という無駄が出ない
- **判定の読み取り**: 出力契約（末尾の json フェンス `level`/`target`/`summary`）は `verify` が
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
- **3 lens は 5 秒ずつずらして起動する**（`verify` の既定 `delayMs: 5000`）。verifier が
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
保存される（plugin 経路のみ）。critic と requirement/general lens はこれを読み、design や実装が
ユーザーの意図からズレていないかを見る（`verify` が requirement/general にだけ path を渡す）。
behavior/progress lens と実装 subagent には渡さない（決定を再審議して止まるため）。
既知のキーはマスクするが best-effort で、会話は verifier/critic のモデル提供元に送られる。
コンパクション境界より前の履歴は取れないことがある。

#### diff ゲート（design g-mwd3n5bo）

**verifier clean の後に差分を変えると `complete` は止まる**。`verifier_set` が検証時点の
全文 diff の sha1 を記録し、complete 時に現在値と照合する。止められたら再検証する
（`recipe: tail` をもう一度）。人間が問題ないと判断した場合だけ `force: true` を使う
（監査の `goal_complete` に `diff_gate: forced` が残る）。VCS が無い・baseline が取れない
環境ではゲートは無効（`diff_gate: unavailable`）。

- **diff 肥大は検証コスト3倍**: polish routeは3lensが全差分を読む。748行級は1回で3×748行の
  コンテキスト消費。goalを小さく切ってadvisor（verifier×1）に収めるのが最大の節約。
  巻き戻しはさらに3倍するので、criticで初回品質を上げることも節約になる
- **drift は全件報告させる**（閾値カットしない。「重大なものだけ報告」のような保守的指示は
  過少報告を招く——`verify` の prompt は既存の lens 指示文を使うので、この原則は自動で入る）
- CI は `bun scripts/gen-agents.ts --check-policy` で、commit 済みの
  `.graphhopper/config.example.json` をポリシー源に catalog と cascade 設定を検査する。
  ローカルでは project catalog に加えて `~/.config/opencode/agents` が存在すれば
  global catalog も同じポリシーで検査する（`[global]` ラベル。CI には無いためローカル限定の保証）。
  見逃し率はscoreboardで監視。
