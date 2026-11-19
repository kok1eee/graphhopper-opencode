# diff トリガ付きチェック（verify が必ず走らせる確認）

変更の形から機械的に発火条件を決め、当たった確認だけを `graphhopper_verify` の角度として
**必ず**走らせる（角度を選ぶ役の気分に任せない）。記事 "How the Claude Code team thinks about
verification" の reliability checklist 相当。各項目は「過去に実際に見逃した・踏んだ」ものだけを残す。

## 書き方

```
### <id>（小文字英数とハイフン、32 文字まで。必須）
- title: 短い題（省略時は id）
- when-path: src/state.ts          ← path に「含まれる」なら発火
- when-path: skills/graphhopper/   ← 同じキーを複数行書くと OR
- when-line: `^[+-].*name: "`      ← 変更行（+/-）に正規表現が当たれば発火。同じキーを複数行書くと OR
- doubt: 疑うこと（必須。無い項目は無視される）
- scope: 見る範囲（省略時は「diff の関連箇所」）
- why: この項目が生まれた事例（任意）
```

- backtick は囲み。外して解釈する（`when-line` は正規表現、`when-path` は部分一致の文字列）。
- 複数条件は**同じキーを行として繰り返す**（カンマ区切りは使わない）。
- `when-path` と `when-line` を両方書いたら **AND**。line は「path が一致したファイルの変更行」だけを見る
  （別ファイルの行では発火しない）。
- どちらも書かない項目は無視する（常時発火させない）。
- 正規表現が壊れている行は無視される。`when-line` が全部壊れていれば、その項目は発火しない。
- 1 回の verify で走るのは、このファイルの記載順で**先頭から最大 4 件**。5 件以上当たったら、
  残りはその回では走らない（当たりすぎはトリガが広すぎる合図なので狭める）。
- 追加・削除はこのファイルを編集するだけ。次の `graphhopper_verify` から効く（再起動は不要）。

### tool-surface

- title: ツール面の残骸
- when-line: `^[+-].*name: "graphhopper_`
- doubt: ツールを消した・改名した・入出力を変えたとき、旧名や旧引数が手順書（`skills/graphhopper/**`）・テスト・履歴の読み手（`src/state.ts` のイベント型）に残っていないか。消したツールを呼ぶ手順が残っていないか。
- scope: diff のツール登録行と、`skills/graphhopper/**.md`・`src/*.test.ts`・`.opencode/plugins/graphhopper/*.ts`。
- why: `route_set`・`critic_set`・`consult_set` を消したとき、SKILL と refs に旧手順が残った（g-mwmykjt4）。

### state-compat

- title: 既存データとの互換
- when-path: src/state.ts
- when-line: `^[+-].*\{ type: "`
- doubt: history のイベント種別や state.json の項目を変えたとき、既存の `.graphhopper/history.jsonl` と `state.json` を読めるか。旧値を捨てる・解釈しない箇所（scoreboard・load・resume・handoff）が壊れていないか。
- scope: `src/state.ts` の型と読み取り、`src/scoreboard-format.ts`、event を読む hook / handoff。
- why: route を 5 値から 2 値へ畳んだとき、旧 5 値の履歴を読む互換を残す必要があった（g-mwmykjt4）。

### handoff-format

- title: handoff メモの後方互換
- when-path: src/handoff.ts
- doubt: `HANDOFF.md` の front matter や節を変えたとき、旧形式のメモを読めるか（`kind` 欠落・古い節・`pending` の扱い）。新しい会話への案内と `load` が同じ解釈をしているか。
- scope: `src/handoff.ts`、`src/handoff.test.ts`、`.opencode/plugins/graphhopper/hooks.ts` の handoff 案内。
- why: `kind` 欠落を goal 扱いにする後方互換が必要だった（g-mvq907g4）。

### docs-stale

- title: 消した概念の残骸
- when-path: skills/graphhopper/
- when-path: src/agents.ts
- doubt: 概念を消した・改名したとき、削除した語・手順・節が他の文書・agent 定義・テストに残っていないか。残っていれば「古い記述」として drift にする。
- scope: diff が消した語を `skills/graphhopper/**`・`src/agents.ts`・`src/*.test.ts` で確認する。
- why: `rubric_legacy`・route・critic の残骸を、続けて 3 回 verify が見つけた。

### timing-test

- title: 時間に依存するテスト
- when-line: `^[+-].*(setTimeout|Bun\.sleep|Date\.now\(\)|toBeGreaterThan\(.*(ms|1000))`
- doubt: 時間・タイマー・実時間に依存するテストを足した・変えたとき、flaky にならないか（余裕の取り方、CI の遅さ、並列実行）。flaky は「再実行で通す」で潰さない前提で見る。
- scope: diff のテストと、そのテストが待つ処理。
- why: 500ms の壁時計アサーションが残っている（持ち越し）。
