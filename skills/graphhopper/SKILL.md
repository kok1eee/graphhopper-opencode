---
name: graphhopper
description: "designing→implementing→polishのgoal駆動ループ。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら使う。designingフェーズ中はsource編集がtool.execute.beforeで物理ブロックされる。"
---

# graphhopper — designing/implementing/polish ループ

graphhopper本体（Claude Code版）の3相グラフをopencodeに移植したもの。
判断は「メイン + graphhopper-verifier(opus)」の2層で足りるという原則（council再発防止）を
そのまま踏襲する。専用の designer/critic subagent は作らない。

## フェーズ

```
designing → implementing → (router_check) → polish [advisor/verifier fan-out] → done
                ↑______________________________________|
                    drift target=implementing の巻き戻し
```

### designing

- `graphhopper_goal(action: "start", title: ...)` で開始
- `.graphhopper/plans/<goal-id>.md` に要件理解・設計判断・実装タスク列を書く
- **このフェーズではsource編集（Edit/Write）が `tool.execute.before` hookで物理ブロックされる**
  （許可パスは `.graphhopper/plans/` 配下のみ、`.graphhopper/config.json` の `design_gate_allow` で変更可）
- 書けたら `graphhopper_phase(phase: "implementing")`

### implementing

- design.md のタスクを1つずつ実装する
- 詰まったら `task(subagent_type: "graphhopper-researcher")` で並列調査
- **実装試行のたびに `graphhopper_attempt(ok, note)` を呼ぶ**（成否をコード側で機械カウントする）
  - `ok: false` が続き `fail_streak` が `stuck_threshold`（既定3）に達すると `escalate: true` が返る
  - `escalate: true` が返ったら `task(subagent_type: "graphhopper-oracle")` に相談する。これまでの
    失敗試行（何を試して何が起きたか）を渡し、助言を受けて別のアプローチで再試行する
  - **これはrouter gate（diffサイズ）とは別軸のタイミング判断**——無条件で毎回opusを呼ぶのではなく、
    本当に詰まった時だけ上位モデルのコストを払う graph engineering の分岐点
- 全タスク実施したら `graphhopper_router_check` を呼ぶ（diffサイズを機械測定してrouteを決める）

### polish

`graphhopper_router_check` の `route` に従う:

- **route=advisor**（小diff）: 自分でdiffをレビューし、問題なければ
  `graphhopper_verifier_set(level: "clean", reason: ...)` で記録
- **route=polish**（大diff・閾値超）: adversarial verifier fan-out を行う
  1. `task(subagent_type: "graphhopper-verifier")` を3回呼ぶ。それぞれ以下のcharterをプロンプトに含める:
     - requirement: 「実装がdesign.mdの意図から外れていないか（実装漏れ・解釈ズレ・スコープ逸脱）を検証せよ」
     - behavior: 「テストが実際のユーザーパスを検証しているか（モック過多・ハッピーパスのみ・エラー握り潰し）を疑え」
     - progress: 「変更がgoalに収束しているか（堂々巡り・残骸・goal無関係な混入）を見よ」
  2. 各verifierに `goal` / `.graphhopper/plans/<goal-id>.md` の内容 / diff（`jj diff --from <baseline>` または `git diff <baseline>`）を渡す
  3. drift（乖離）を検出したら**全件報告させる**（閾値カットしない。「重大なものだけ報告」のような保守的指示は書かない——過少報告を招く）
  4. 3体の結果を集約し、confidence高 & severity high/critical のものだけ採用して
     `graphhopper_verifier_set(level: "drift" | "clean", reason: ..., target: ..., lens: [...])` で記録

### done

- `level: "clean"` が記録されていれば `graphhopper_phase(phase: "done")` → `graphhopper_goal(action: "complete")`
- self-graded完了は禁止（`graphhopper_goal(complete)` は直近verifierがcleanでないとエラーを返す）

## Gotchas

- **designing中に無理にEdit/Writeしようとしてエラーになったら**: 設計が先という合図。design.md を先に書いてから implementing へ遷移する
- **route=polishなのに「念のため」でverifier fan-outを省略しない**: router_checkの判定はコード側の機械測定。無条件発火だったcouncilの再発防止はここで担保されている
- **verifier fan-outへの指示を「重大な問題だけ報告」にしない**: 全件報告→confidence/severityで後段フィルタが正しい順序（保守的な指示は再現率を落とす）
- **`graphhopper_attempt`を省略しない**: 呼ばなければfail_streakが0のまま止まり、詰まっていても oracle への相談が起動しない。実装試行のたびに毎回呼ぶ
- **escalate: trueが出たのに自力でもう一度だけ試そうとしない**: 閾値はコード側の機械カウント。無視して回すと同じ失敗を繰り返すだけになりがちなので、必ずoracleに相談してから再試行する
