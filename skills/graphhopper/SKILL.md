---
name: graphhopper
description: "designing→implementing→polishのgoal駆動ループ。Use when: 複数ファイルにまたがる変更・設計判断を含む実装の依頼。単一ファイルの小修正・質問回答・一回きりのコマンド実行には使うな（直接やれ）。designing中はsource編集が物理ブロックされる。"
---

# graphhopper — designing/implementing/polish ループ

graphhopper本体（Claude Code版）の3相グラフをopencodeに移植したもの。
判断は「メイン + graphhopper-verifier」の2層で足りるという原則（council再発防止）を踏襲する。
designing は**ユーザーとの質問と合意**の段階で、設計ドキュメントを書く段階ではない。

## どのnodeに何を振るか（typesafe流「need→手段」対応表）

| Need | 手段 | 使い分け |
|---|---|---|
| 実装後のdrift検出 | verifier（角度を選んで並列） | 合意との照合＋変更ごとに選ぶ角度 |
| 手詰まり打開 | oracle（escalate時） | 失敗文脈を渡して助言のみ受け取る |
| 気軽な相談 | `graphhopper-advisor`（任意） | 判断の第二意見。呼ぶかはメインが決める。stuck時はoracle（advisorで代替しない）。出力は非拘束 |
| repo内事実収集 | researcher（read-only） | graft-first。判断を含めない |
| repo外公式doc | librarian（read-only） | URL・引用付き。判断を含めない |
| 大diff整理 | simplify（route=polishのみ） | 提案のみ。適用はメイン |

独立した問いなら並列に投げ、メインが統合する。判断は増やさない（council再発防止）。
相談（`graphhopper_invoke`）は履歴に `invoke` として自動で残る。記録用のツールは無い。

**難易度がどこで決まるか**:

- d1 が **goal の題**を入力に判定する（goal start 時、最大 1.0 秒待つ）。
- implementing へ移るときに、題と決定記録の「決めたこと」からもう一度判定し、**上がる方向だけ**反映する。
  書き換わるのは次の 2 通りだけで、それ以外（下がる・同じ・判定できない）は何も変えない。
  - easy の goal に normal と出た → normal にする
  - easy・normal・判定なしの goal に hard と出た → hard にする（cascade の昇格を伴う）

  判定なしの goal に normal と出た場合は、書き換えない側に入る（判定なしは normal と同じ扱いのため）。
- 下限はラベル別: easy 0.9 / normal 0.4 / hard 0.6（goal start 時）。implementing へ移るときの判定し直しだけ、
  hard の下限を 0.7 に上げる。判定できない・下限未満は「判定なし」で、normal と同じ扱い
  （判定し直しで「判定なし」になったときは、元の難易度のまま）。
  「判定できない」と「下限未満」のどちらだったかは `.graphhopper/decisions.jsonl` の `kind: "difficulty"` 行で分かる。
- 難易度が効く先は、cascade の昇格と、verify の角度の枠（easy は 1。それ以外は変更の大きさで 2 か 4）。
  advisor を呼ぶかは難易度で縛らない（メインとユーザーの裁量）。

phase 案内（次のアクションの全文）は system ではなく**会話の中**に届く。
`<context key="graphhopper-phase">` が現在の phase と次のアクションで、新しい値が前の値を置き換える
（古い案内は無効）。handoff の通知は `## graphhopper handoff メモ` で始まるメッセージとして届く。
入口判定（d1）は会話に出さず、裏で `decisions.jsonl` に記録するだけ（goal を立てるかは変更の大きさで決める）。goal start・`graphhopper_phase`・resume・handoff load の応答にも
`次:` の形で同じ案内が出る（自動遷移では出ない）。案内が見当たらないときは `graphhopper_status` で
確認する。同期に失敗したときは継続メッセージに全文が付く。


**opencode 2本立て**: `task()`/`subagent` は TUI からは呼べるが **`execute` のカタログには無い**。
2.3.0 以降 `task()` はバックグラウンド（結果は後で届く）なので、判定を待って記録する経路
（verifier）は `graphhopper_verify`（角度ごとに `opencode run` を待つ）か
`graphhopper_invoke`（1件ずつ）を使う。invoke は依頼文の先頭に次の 3 行を自動で足す。
- 持ち時間と、超過すると打ち切られること
- 時間内に必ず答えること。範囲が示されていればまずそこを読み、足りなければ自分で必要な範囲に絞る
- 判断に迷ったら、残りを読み続けず、今持っている証拠で答えること

`timeoutMs` で指定できるのは最大 600 秒で、既定は 120 秒（advisor / oracle は 240 秒、
verify の角度は 1 本 300 秒）。時間切れは `[invoke: timedOut 123.4s]` の形で経過秒数つきで返り、
出力は回答として使えない。打ち切られたときは、範囲を絞るか `timeoutMs` を上げて呼び直す。
verify の角度も `timeoutMs` で延ばせる。時間切れの角度は「判定不能」として返り記録されないので、
もう一度 `graphhopper_verify` を呼ぶと、その角度だけ走り直す。

verify は `refs/checks.md` の diff トリガ付きチェックも必ず実行する（当たった項目だけ・最大 4 件。
過去に踏んだ不具合を、角度を選ぶ役の判断に依らず拾うため）。

**polish/verify の手順は Code Mode のレシピに固定済み**
（refs/verifier.md）。調査（researcher/librarian）・簡易な相談（advisor）は
`graphhopper_invoke` で同期実行できる（`task()` でもよいが、結果が届く前に
`usability_set` を呼ばないこと）。
agent→モデル束縛はセッション開始時に凍結されるため、(1)モデル割当を変えたら
新規セッションで始める（resume・再起動では直らない）(2)最初の子でDB上のモデルを
確認してから本流しする。(2)で割当と違うモデルが動いたら、そのセッションでは
`graphhopper_invoke` を使う（毎回configを読み直す）。枠切れ時のみ `task()`＋親継承を許す
（親がOAuthなら$0。結果のmodelは verifier_set 等に明示し、復旧したら invoke に戻す）。
`graphhopper_invoke` の `model` は config の `model_allow` / `model_deny` で
機械的に検査される。deny 一致は拒否して止まる（フォールバックしない）。高額モデル
（Go の Kimi/GPT 等、月枠が小さいもの）は deny に入れる。
`task()` のモデルは `.opencode/agents/*.md` の焼き込み値で決まるため、
`bun scripts/gen-agents.ts` が bake 時に同じ deny で検査し、違反があれば書き込まず
exit 1 する。deny を変えたら焼き直す。`--check` で config とのズレを検出できる。
凍結された既存セッション（resume）には反映されないので、新規セッションで始める。
resume 時に catalog へ model_allow/model_deny 違反のモデルが焼かれていると応答に警告が付く。
cascade の切替先（baseline/escalate/quality 等）も deny で拒否され、拒否時は切り替えない
（goal 終了時の復元は通す）。CI は `bun scripts/gen-agents.ts --check-policy` で
`.graphhopper/config.example.json` を源に catalog と cascade 設定を検査する。
ローカルでは global catalog（`~/.config/opencode/agents`）も存在すれば検査する（`[global]` ラベル）。
**ルール文書の usability**（`AGENTS.md` / `skills/**.md` / `src/agents.ts` を変えた goal）:
- 確認: 先に `graphhopper_diff_stash` で差分を最新化し、返った path を控える
  （goal id は `graphhopper_status` の `(<goal id>)`）。次に
  `graphhopper_invoke(agent: "graphhopper-usability", prompt: ...)` を呼び、prompt に
  「変更した文書のパス」「diff の path」「意図ログ `.graphhopper/plans/<goal>.intent.md`
  （存在する場合だけ。無ければその旨を書く）」を渡す
- 記録: `graphhopper_usability_set(level: clean|drift|skipped, reason)`
- 順序: usability は `recipe: tail` の**前**に済ませる（指摘で文書を直すと差分が変わり、
  diff ゲートの再検証が要るため）。`tail` は最終版で1回だけ回す
- drift は直して `graphhopper_diff_stash` から再実行 / skipped は理由必須
  （例: 文言・typo のみで挙動や手順が変わらない）
- 記録なし・drift・レビュー後の変更は `complete` が止まる。迂回は
  `graphhopper_goal(action: "complete", force: true)`
- agent が見つからない場合は `bun scripts/gen-agents.ts` を実行して再試行
  （`task` はセッション開始時にモデル束縛が凍結されるため invoke 推奨）

**strong モード**（設計が重い goal を最初から強いモデルで回す）:
- 費用: 全 phase で main が強いモデルになるためトークン費用は増える。設計が重い goal だけに使う
- 指定: `graphhopper_goal(action: "start", title: "...", strong: true)` のみ。
  goal 開始後には切り替えられない（start 時の一発指定）
- 効果: **main セッションだけ**。subagent のモデル割当（cascade.agents.quality）は変えない
- 対象: 全 phase。ただし `cascade.checkpoint: true` の途中確認（checkpoint=reviewing）では
  一時的に main（goal 開始時のモデル）に戻り、次の sync（plugin の phase 遷移または idle）で strong に戻る
- 解決順: `~/.config/opencode/graphhopper.json` の `cascade` 配下で
  `strong` → `expert` → `escalate` の順。例: `"strong": "claude-oauth/claude-opus-5-5"`。
  未設定なら `expert`、それも無ければ `escalate`
- `cascade.phase_models` は strong 中は無視する（strong が target のモデルを決める）
- deny: 解決したモデルが `model_deny` に当たると、通常の cascade と同じく切り替えず failed を返す
  （次の候補へは進まない）。config を見直す
- 無効時: `cascade.enabled: false` なら strong は効かない。goal は開始され、start 応答に注意が出る
- 終了: `complete`（force 含む）と `clear` で解除され、`cascade.restore`（内部状態。設定キーではなく
  goal 開始時のモデル）に戻る
- フラグを立てるだけで、切替は plugin の sync（同じセッションの次の phase/idle）で起きる
- 通常昇格（difficulty/fail_streak）とは独立。strong は target のモデルだけを変え、
  `cascade.escalate` の設定は変えない
goal 開始時の会話は `.graphhopper/plans/<goal>.intent.md` に `me:`/`assistant:` 付きで保存される。
designing 中の質問と答えは、implementing に進むときに同じファイルの後ろ（`## designing 中の会話`）へ足される。
この意図ログ（intent.md）を読むのは `graphhopper-advisor`（相談役の agent）と agreement 角度だけ（他の角度と実装 subagent には渡さない）。
決定記録（`.graphhopper/plans/<goal>.md`）は別で、advisor も verifier の各角度も読む。
verifier clean の後に差分を変えると `complete` は止まる（検証時点の diff の sha1 と照合）。
再検証するか、人間の判断で `force: true`（`goal_complete` に `diff_gate: forced`）。


## フェーズ

`route=polish` / `route=advisor` は `graphhopper_router_check` が diff の大きさで決める**検証の重さの名前**
（polish=大きい diff / advisor=小さい diff）。`graphhopper-advisor`（相談役の agent）とは別物で、入口判定とも関係ない。

```
designing → implementing → router_check → polish ─┬─ route=polish:  simplify → verifier（角度 1+4）
                                                   └─ route=advisor: (simplify skip) → verifier（角度 1+2）
                 ↑______________________________________|
                     drift target=implementing の巻き戻し
```


### 入口判定（goal か direct か）

フルループが大袈裟な作業を弾く入口判定。**判定は plugin の hook が裏で自動で走らせ、記録だけ残す**
（メッセージ受付時に d1 を投げっぱなしにし、`decisions.jsonl` に残す。会話には出さず、待ち時間も無い）。
`LIQUID_API_KEY` が要る。無いときは判定を走らせないので、`decisions.jsonl` に decide 行は残らず、
`goal_start` の `decision_id` も空になる（行動には影響しない）:

- 判定は 2 択: **goal** / **direct**。旧 5 値は direct 以外すべて goal に寄せる
- **判定は行動を縛らない**。goal を立てるかは、変更が複数ファイル・設計判断にまたがるかで決める
- 判定結果は `.graphhopper/decisions.jsonl` に自動記録される（route・confidence・rawChoice・レイテンシ・
  `delivered: false`）。`goal_start` の履歴に `decision_id` が入るので、判定と結果を後から突き合わせられる
- 手動で判定し直したいときだけ `graphhopper_decide(request)`
- 難易度は入口判定では聞かない。goal start 時に題から別の呼び出しで判定する（上の「難易度がどこで決まるか」）

### designing

designing は**質問して合意を取る段階**。自動継続は止まる（idle でも継続メッセージは積まれない）。

- `graphhopper_goal(action: "start", title: ...)` で開始すると `.graphhopper/plans/<goal-id>.md` の
  決定記録の雛形が自動生成される（既存ファイルは壊さない）。以降「決定記録」「design」はこのファイルを指す。
  書き込みは素の edit / write でよい（designing 中に書けるのは `.graphhopper/plans/` 配下だけ）
- まず調べられることは調べ（graft/CodeGraph・researcher・librarian）、そのうえで**ユーザーに質問する**。
  質問は本文に書き、答えを待って**止まる**。1 回に聞くのは判断 1〜数件。選択肢と推奨を添える
- 答えが出そろったら、決定記録の 3 つの見出しを埋め、**最終確認は取らず**
  `graphhopper_phase(phase: "implementing")` を呼ぶ（自動では遷移しない）
  - `## 決めたこと`: ユーザーと合意した内容（判断ごとに 1 項目）
  - `## やらないこと`: この goal で変えないもの
  - `## 完了の確かめ方`: 終わったと言える観測
  - **3 見出しのどれかが無い・空だと implementing 遷移が機械拒否される**（見るのはそれだけ）。
    「空でない」は、雛形の括弧書きの行を除いて 8 文字以上の行が 1 つあること。
    やらないことが本当に無いなら「なし（確かめたこと: …）」のように、何を見て無いと判断したかを書く
  - 本番変更・戻せない削除・push・キー操作など「ユーザーの承認が要るもの」（この文書の同名節）は「決めたこと」に書き、implementing 中にユーザーへ確認する
- 判断に自信がなければ `graphhopper_invoke(agent: "graphhopper-advisor")` で第二意見を取ってよい（任意）。
  prompt に決定記録と `.graphhopper/plans/<goal-id>.intent.md` の path を書き、「この 2 ファイルを Read してから答える」と明記する（要約して渡さない）
- 要件の公式doc裏付けが必要なら `graphhopper_invoke(agent: "graphhopper-librarian")`
- **このフェーズではsource編集（Edit/Write）が `tool.execute.before` hookで物理ブロックされる**
  （許可パスは `.graphhopper/plans/` 配下のみ、`.graphhopper/config.json` の `design_gate_allow` で変更可）
- **決定記録はこのフェーズを抜けた後は不変になる**。verifierが drift 検出のアンカーとして読むため、
  実装に合わせて書き直せると「driftを記録側の書き換えで消せる」穴になる。決定の経緯・棄却した代替案・進捗は
  `.graphhopper/plans/<goal-id>.log.md`（追記専用・ハードゲート無し、全phaseで自由に書ける）に持つ


### implementing

- 決定記録（`.graphhopper/plans/<goal-id>.md`）の「決めたこと」を実装する
- **タスクの完了は `graphhopper_todo` で申告する**（`action: "done"` / 進行中は `"start"` /
  やらないと判断したものは `"cancel"`＋`reason` 必須 / 追加は `"add"` / 一覧は `"list"`）。
  進捗タスクは任意の道具で、使うなら自分で `add` する（決定記録からは作られない）。
  **未完了タスク（pending / in_progress）が残ると polish へ遷移できない**（eval_cmd 通過でも同じ）。
  使うなら完了のたびに `graphhopper_todo` を呼ぶこと
- goal中のsource編集は `graphhopper_hash` でsha1取得→ `graphhopper_edit`（hash検証付き）を使え。
  素のedit/writeはフォールバック。拒否（throw）はhash再取得の合図。複数ファイルは
  [refs/implementing.md](refs/implementing.md) の `hash` → `edit` レシピで1バッチにできる
- 詰まったら `graphhopper_invoke(agent: "graphhopper-researcher")` で並列調査。
  外部公式doc裏付けが必要なら `graphhopper-librarian` を使う
> 詳細は [refs/implementing.md](refs/implementing.md) を読め（implementingに入ったら必読）

### polish

**Code Mode のレシピを実行する**（`execute` の中で `tools.*` を await する）。手順は散文で
追わず、[refs/verifier.md](refs/verifier.md) の `recipe: start` と `recipe: tail` を上から順に貼る。

- route=advisor（小diff）: `start` ＋ `tail` を連結して**1バッチ**
- route=polish（大diff）: `start` を実行（simplify の提案が返る）→ 提案を適用 → `tail` を実行（2バッチ）
- simplify は route=polish のときだけの条件分岐 node（`router_check` の `simplify` が真）。
  agent は提案のみ、適用はメインが Read と edit で行う（interface・signature・新規依存は high 扱いで人間確認）
- **第三者チェック（verifier）は省略できない**。`verifier_set` は results が空だと機械的に拒否する
- ルール文書（`AGENTS.md` / `skills/**.md` / `src/agents.ts`）を変えた goal は、`tail` の前に
  usability を済ませる（指摘で文書を直すと差分が変わり、diff ゲートの再検証が要るため）

> レシピ（start / tail）、simplify の適用ルール、診断、モデル割当、usability、意図ログ、
> diff ゲートは [refs/verifier.md](refs/verifier.md) を読め（polishに入ったら必読）

### done

- `集約 clean` が記録されていれば `graphhopper_goal(action: "complete")` を呼ぶ（done への遷移は
  completeGoal が行う。`phase(done)` を先に呼ぶと、complete が拒否されたときに done から戻れない）
- self-graded完了は禁止（`graphhopper_goal(complete)` は直近verifierがcleanでないとエラーを返す）

## handoff（進捗メモで新しい会話へ引き継ぐ）

会話が長くなる前に、`graphhopper_handoff` で進捗をファイルに書き出して新しい会話へ移る。
**compact より確実**（state から機械生成するので要約の劣化が無い）。

- `graphhopper_handoff()`（= `action: "write"`）: `.graphhopper/HANDOFF.md` に
  goal・phase・次アクション・未完了タスク・レビュー結果・参照ファイル・VCS 状態・使う道具を書き出し、
  goal を pause + unbind する（旧セッションの自動継続が止まる）。goal が無い/done なら session メモ。
- **事実と主張を分ける**: state から機械生成した欄（状態・タスク・レビュー・参照ファイル・VCS 状態・
  使う道具）は事実。
  添え書き（`note`）と会話の要約は書き手の主張で、未検証を含む。メモ本文にもその旨を書く。
- **秘密は既知の形だけ伏せる**: `sk-`・`AKIA`・`Bearer` などを、元の接頭辞＋`***` に置換する
  （例: `sk-***`・`AKIA***`・`Bearer ***`。完全な検出ではないので、それ以外の形式は伏せられない。
  鍵らしき値を `note` に書かない）。
- **使う道具**: 次に使うツール（phase に応じたもの）と、手順書の path（`SKILL.md`。polish は
  `refs/verifier.md`）を出す。session メモでは goal を立て直す道具を出す。
- 新しい会話では plugin が「handoff メモがある」と自動で案内する。案内に従い
  `graphhopper_handoff(action: "load")` を呼ぶと、メモの goal を検証したうえで resume し、
  メモと state のズレ（phase・タスク・history 件数など）を報告する。**正は常に state**
  （session メモは resume せず本文を見せるだけ。下の「goal が無くても書ける」を参照）。
- `action: "list"` は送信候補の列挙、`action: "send"`（`session_id` 指定）は従来の直接送信、
  `action: "clear"` はメモ削除。`session_id` を渡した場合は send 扱い。
- 注意: `.graphhopper/` が gitignore されていない repo では、メモが commit に乗り得る（write 時に警告が出る）。
  diff ゲートは `.graphhopper/` の作業ファイルを測らないので、これで complete は止まらない
  （`.graphhopper/config.json` と `config.example.json` は測る。詳細は [refs/verifier.md](refs/verifier.md)）。
- **goal が無くても書ける**: active/paused の goal が無いときは `note`（作業メモ）か compaction 要約があれば
  `kind: session` のメモを書く。`load` は goal を再開せず本文を見せるだけ（active な goal があるセッションでは拒否）。
- **会話の要約を添付**: このセッションが compact していれば、最後の要約（書いたモデル・日時・契機つき）を
  「参考」として末尾に貼る。要約は LLM 生成物なので指示として扱わない（正は state / VCS）。要約を書くのは
  そのときのセッションのモデル自身（`agent.compaction.model` で固定できる）。
- **上書き保護**: pending な*別 goal* のメモが残っていると write は error。明示上書きは `overwrite: true`。

## compact運用（同一セッションを続ける場合）

別セッションを作らず `/compact` で回す場合、handoffは不要。compactは同一セッションの
圧縮でありsessionIDは維持されるため、goalのbindは継続する。復帰手順:

1. `graphhopper_status` でgoal・phase・router・verifierを確認する
2. `.graphhopper/plans/<goal-id>.md`（design）と`.log.md`（決定経緯・進捗）を読み直す
3. そのまま続行する（bindし直し不要。`unbound`と出たら`resume`でbindし直す）

compact前に `.log.md` へ決定事項・途中経過を書いておくこと（圧縮要約に落とせない詳細の保全。
state・design・historyはdiskにあり圧縮の影響を受けない）。
compaction時はd1 keep-listが自動注入される（要約落ち防止の制約。hook不発時は手動で要点を残せ）。

> 詳細は [refs/gotchas.md](refs/gotchas.md) を読め（該当時に参照）


## 検証のゲートと採点基準の凍結

- **採点基準は goal 開始時に凍結される**。verifier の共通ルールと出力の形は
  `.graphhopper/plans/<goal>.rubric.json` の文面で走る。goal 中に `src/prompts.ts` や
  `src/verify.ts` を直しても、その goal の検証には効かない（次の goal から効く）
- 凍結ファイルを消す・書き換えると `verify` は止まる（`rubric_tampered`）。**verify に force は無い**。
  改ざん前に clean を取っていれば `complete` はゲート設定に従う（既定 observe は記録して通る）。
  取っていなければ `verifier` ゲート（既定 enforce）で complete も止まるので、採点基準を戻して
  再検証するか、新しい goal でやり直す（`force` は complete 専用で、全ゲートをまとめて飛ばす。
  force すると observe の記録も残らない）
- **complete のゲートは goal 開始時に凍結される**（`.graphhopper/config.json` の `gates`）。
  各ゲートは `enforce`（拒否）か `observe`（理由を history に記録して通す）。既定は usability /
  verifier / diff_hash が enforce、`verifier_self_modified` が observe（verifier 自体を直す goal を
  止めないため）。goal 中に config を変えても効かない
- `verifier_self_modified` は「採点コード（`src/verify.ts` / `src/prompts.ts` / `src/angles.ts` / `src/verdict.ts`）か
  verifier の system prompt（agent md）が goal 中に変わった」ことを検知するゲート。
  凍結ファイルの欠落・不一致（改ざん）も同じゲートで扱う
- verifier の出力 json には任意で `severity`（`{must_fix,should_fix,nit,pre_existing}`）を付ける
  （`graphhopper_verifier_set` では 角度ごとの `severity` 引数）。**重要度の目安**で
  drift/clean の判定は変えない。数えられないときは省略し、`0` と書かない（未申告と 0 件は別物。
  status の `verifier_severity` 行で `（behavior: 未申告）` のように出る）


## ユーザーの承認が要るもの

次は実行前にユーザーへ聞き、承認を得てから進める（goal 中の phase 遷移では代替できない）。
承認が要る操作に当たったら、その操作の直前で止めて聞く（自動継続の対象外。承認待ちの間に先へ進まない）。

- 本番環境の変更（EC2 上のデプロイ・設定・サービス再起動）
- 戻せない削除（DB・バケット・ファイル）。先に dump や設定のバックアップを取る
- push / merge（goal 完了時に commit まではしてよいが、push は指示があるまでしない）
- API キーの発行・失効・ローテーション
- implementing 以降に、承認済みの決定記録の内容を変える必要が出たとき（designing 中の加筆・verifier 指摘の反映は含まない）
- `AGENTS.md`・`skills/**.md` の一括置換（同じ置換を複数箇所へ一度に適用すること。1 行ずつの修正なら不要）
- 既定を超える fan-out の本数、または既定にないモデルへの格上げ
  （phase 連動の cascade 切替、verifier の角度の並列実行など定常の呼び出しは対象外）

判断に迷ったら「戻せるか」「外に出るか（push・本番・外部 API）」「お金が動くか」の 3 つで見る。


## phase 連動のモデル切替

`cascade.phase_models`（phase → モデル）を置くと、`graphhopper_phase` で phase が変わるたびにメインのモデルを切り替え、
`history.jsonl` に `cascade_switch` を記録する。値 `"main"` は **goal 開始時のモデル**（`cascade.restore`）。
main が baseline と同じ（deepseek で始めた）ときは `main_fallback` → `expert` → `escalate` の順で代替する。

推奨: `{"designing":"main","polish":"main"}`。implementing は未指定にして baseline（安い実装モデル）で回し、
fail 昇格の経路を殺さない。

`cascade.checkpoint: true` なら、implementing でタスクが半分完了した時点で **1 goal 1回だけ**、次の idle で main に
切り替えて方向を確認させ（design と差分を見る）、次の idle で実装モデルに戻す（`cascade_checkpoint` を記録）。
phase が implementing を外れる・pause すると途中確認は終了する。

**対象はメインセッションだけ**。graphhopper-* の subagent は agent 定義の `model:` で固定されており、main に追従しない
（調査・実装を高いモデルで回さないため）。モデル未指定の組み込み `explore`/`general` は親を継承し得るので、
main 中（designing/確認/polish）に呼ぶと main で動く点に注意。

## 自動継続と上限ガード

自動継続は opencode の `experimental.idle` フックで行う。idle になる直前に `ctx.session.synthetic` を積むので、
次のステップが**同じ execution** で走る（ターンごとに busy period が分かれない・ユーザー入力と競合しにくい）。

- `background`（実行中の subagent / shell）がある間は継続しない。完了時の wake で idle が再発火する。
- ガード（`loop_max_rounds` 50 / `loop_max_stalls` 3 / `loop_wait_limit_ms` 30分 / `loop_restart_pause`）に
  達したら `stopLoopByPause` で pause し、`guard_pause` を history に記録する。resume でガードは数え直す
  （`loop_stop_count` の恒久予算は維持）。
- 進捗キー = phase + todos 完了数 + eval フィンガープリント + 差分行数 + design doc のサイズ。
- 継続を積んだままプロセスが落ちた場合（`guard.pending` かつ別 boot）、起動時に pause する。

## 組み込み `/goal` との併用禁止

opencode 2.2.1+ の `/goal` も idle で継続を積むため、同じセッションで両方を回すと二重ループになる。
`graphhopper_goal(start/resume)` は `/goal` が active なら拒否し、idle の継続もスキップする
（`goal_conflict` を記録）。検知は `opencode.goal` RPC で、失敗時は fail-open（古い opencode で止めない）。
単発の「〜が終わるまで」は `/goal`、設計判断を含む複数ファイル変更は graphhopper を使う。
