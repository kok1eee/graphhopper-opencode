---
name: graphhopper
description: "designing→implementing→polishのgoal駆動ループ。Use when: 複数ファイルにまたがる変更・設計判断を含む実装の依頼。単一ファイルの小修正・質問回答・一回きりのコマンド実行には使うな（直接やれ）。designing中はsource編集が物理ブロックされる。"
---

# graphhopper — designing/implementing/polish ループ

graphhopper本体（Claude Code版）の3相グラフをopencodeに移植したもの。
判断は「メイン + graphhopper-verifier(opus)」の2層で足りるという原則（council再発防止）を
そのまま踏襲する。専用の designer は作らない。ただし設計段階の質チェックとして
安価な `graphhopper-critic`（Luna 等）を designing で1回呼ぶ常設nodeを持つ
（verifier が実装後の drift 検出、critic が実装前の計画検証という役割分担）。

## どのnodeに何を振るか（typesafe流「need→手段」対応表）

| Need | 手段 | 使い分け |
|---|---|---|
| 計画の敵対検証 | critic（designingで1回） | 要件漏れ・設計の穴・スコープ逸脱。質はここ |
| 実装後のdrift検出 | verifier（polishでfan-out） | requirement/behavior/progressの3lens |
| 手詰まり打開 | oracle（escalate時、および oracle 入口の開始時） | 失敗文脈を渡して助言のみ受け取る |
| 気軽な相談 | `graphhopper-advisor` | セカンドオピニオン・advised入口の相談・full の designing で判断の第二意見。stuck時はoracle（advisorで代替しない）。出力は非拘束。selector判定はd1 tool（`graphhopper_selector`）に移管 |
| repo内事実収集 | researcher（read-only） | graft-first。判断を含めない |
| repo外公式doc | librarian（read-only） | URL・引用付き。判断を含めない |
| 大diff整理 | simplify（route=polishのみ） | 提案のみ。適用はメイン |

独立した問いなら並列に投げ、メインが統合する。判断は増やさない（council再発防止）。

**入口ごとの reviewing（designing → implementing）**:

| 入口 | oracle | advisor | critic | 記録の扱い |
|---|---|---|---|---|
| full / 未判定 | - | 1回（design を書いたら） | 1回 | consult_set / critic_set とも任意 |
| light | - | 省略 | 省略 | - |
| advised | - | 1回 | 省略 | consult_set(kind: 'advisor') が**必須**（機械ゲート） |
| oracle | 1回（開始時） | 1回 | 1回 | consult_set(kind: 'oracle') が**必須**（機械ゲート）。advisor・critic の記録は任意 |

`require_critic: true` にしたプロジェクトだけは、入口に関係なく critic_set の記録が必須になる（既定 false）。
その場合は critic を省略する light / advised でも、呼ばなかった理由を `reason` に書いて記録する。
記録を省く運用なら false のままにする。

**opencode 2本立て**: `task()`/`subagent` は TUI からは呼べるが **`execute` のカタログには無い**。
2.3.0 以降 `task()` はバックグラウンド（結果は後で届く）なので、判定を待って記録する経路
（verifier）は `graphhopper_verify`（lens ごとに `opencode run` を待つ）か
`graphhopper_invoke`（1件ずつ）を使う。**polish/verify の手順は Code Mode のレシピに固定済み**
（refs/verifier.md）。設計レビュー（critic）・調査（researcher/librarian）・簡易な相談は
`graphhopper_invoke` で同期実行できる（`task()` でもよいが、結果が届く前に `critic_set` /
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
advisor・critic と requirement/general lens はこれを読む（behavior/progress と実装 subagent には渡さない）。
verifier clean の後に差分を変えると `complete` は止まる（検証時点の diff の sha1 と照合）。
再検証するか、人間の判断で `force: true`（`goal_complete` に `diff_gate: forced`）。

## フェーズ

```
designing → implementing → router_check → polish ─┬─ route=polish:  simplify → verifier ×3
                                                   └─ route=advisor: (simplify skip) → verifier ×1
                 ↑______________________________________|
                     drift target=implementing の巻き戻し
```

### 入口トリアージ（decide・route full/light/direct/advised/oracle）

フルループが大袈裟な作業に相応の重さで回す入口判定。**判定は plugin の hook が自動で走らせる**
（ユーザー入力の prompt admission で d1 を起動し、モデル呼び出し直前に結果を渡す）。
`LIQUID_API_KEY` が要る（無いと判定は走らない）:

- **自動判定が基本**: モデルが `graphhopper_decide` を呼ぶ必要はない。
  判定結果は `.graphhopper/decisions.jsonl` に自動記録される
  （route・confidence・rawChoice・レイテンシ。閾値較正の材料）
- 判定結果（route が direct 以外）がモデルに渡される。モデルはそれに従って
  `graphhopper_route_set(route, reason, difficulty)` → `graphhopper_goal(action: "start")` へ進む。
  **d1 の判定は参考値**。明らかに単一ファイルの小修正なら route_set をしない（ループを作らない）
- 手動で判定し直したいときだけ `graphhopper_route(request)` → `graphhopper_decide(request)` →
  `graphhopper_route_set(route, reason)`。手動の decide も同じログに記録される
- **full=フル**（現行通り）/**light=軽量**（design の内容規約は full と同じ。判断は少なくてよいが1件以上、critic省略、verifier general×1）/
  **direct=直行**（loopなし・goalを作らない。historyに1行のみ残る）/
  **advised=軽量＋第二意見**（light相当＋implementing前にadvisor相談1回。lightはadvisor・critic省略）/
  **oracle=多角**（full相当＋開始時にoracle相談1回。stuck時は同session継続）
- parse失敗・範囲外・未記録は**fullに倒す**（fail-safe。state null＝full）。
  旧A/B/Cも受理しfull/light/directに写像する
- **昇格のみ可**（full→light禁止のラチェット）。stuck発火時は `graphhopper_escalate`、
  `router_check` でlight/advised＋大diffなら**自動昇格**（designing巻き戻し＋肉付け＋critic1回＋fan-out×3）。
  stuck発火時もlight/advisedは自動昇格する（fullのstuckは従来通りoracle相談）。
  昇格後はcritic記録なしにimplementingへ進めない（機械ゲート）
- light適用条件（decide criteria）：単一関心・設計判断が少ない（1件以上。判断ゼロの作業は direct）・既存踏襲・テスト容易。
  1つでも欠けたらfull。誤lightは昇格で回収する前提

### designing

- `graphhopper_goal(action: "start", title: ...)` で開始すると
  `.graphhopper/plans/<goal-id>.md` の骨格が自動生成される（scaffold）。
  既存ファイルは壊さない
- 骨格（goal理解／現状／設計判断／タスク列／棄却＋タスク行）を埋める。
  **骨格不足だと `implementing` 遷移が機械拒否される**（構造のみ・質はcriticの領分）。
  中身をゼロから書く必要は無い、scaffoldを埋めればよい
- **このフェーズではsource編集（Edit/Write）が `tool.execute.before` hookで物理ブロックされる**
  （許可パスは `.graphhopper/plans/` 配下のみ、`.graphhopper/config.json` の `design_gate_allow` で変更可）
- 書けたらまず `graphhopper_invoke(agent: "graphhopper-advisor")` で**判断の第二意見を1回**取る
  （design と `.graphhopper/plans/<goal-id>.intent.md` の path を渡し、会話を読ませる。要約して渡さない。
  別の選択肢・判断の妥当性を返す。反映後に呼び直さない。light は省略、advised は `graphhopper_consult_set(kind: "advisor")` の記録まで必須）
- 次に `graphhopper_invoke(agent: "graphhopper-critic")` で**設計を1回敵対レビュー**する
  （要件漏れ・設計の穴・スコープ逸脱を検出。安価モデル = 常設nodeなので full / 未判定 / oracle 入口では必ず呼ぶ）。
  呼び出しは `execute` の外から直接でよい（`execute` の中は polish のレシピだけ）
- critic の指摘を design.md に反映してから `graphhopper_phase(phase: "implementing")`
- 要件の公式doc裏付けが必要なら `graphhopper_invoke(agent: "graphhopper-librarian")` を使う
  （researcherはコードベース事実収集に専念し、外部調査はlibrarianに委ねる）
- 呼ぶこと自体は full / 未判定 / oracle 入口では必須（運用規則。light / advised は省略）。記録は
  `require_critic: true` のプロジェクトでは **必須**（未記録だと implementing 遷移が機械拒否される。
  既定 false）。それ以外は任意で `graphhopper_phase` の前提条件にはならない
  （「critic を呼んだか」自体の機械チェックはしないので、記録も裁量）
- **design.md はこのフェーズを抜けた後は不変になる**（`tool.execute.before` が
  designing以外での該当パスへの書き込みを常にブロックする）。verifierがdrift検出の
  アンカーとして読むため、実装に合わせて書き直せると「driftをdesign.md側の書き換えで
  消せる」Goodhart's Lawの穴になる。決定の経緯・棄却した代替案・進捗は
  `.graphhopper/plans/<goal-id>.log.md`（design.mdとは別物、追記専用・ハードゲート無し、
  全phaseで自由に書ける）に持つ

### implementing

- design.md のタスクを1つずつ実装する
- **タスクの完了は `graphhopper_todo` で申告する**（`action: "done"` / 進行中は `"start"` /
  やらないと判断したものは `"cancel"`＋`reason` 必須 / 追加は `"add"` / 一覧は `"list"`）。
  design.md の「実装タスク列」セクションが designing→implementing 遷移時に todo ストアへ seed される。
  **未完了タスク（pending / in_progress）が残ると polish へ遷移できない**（eval_cmd 通過でも同じ）。
  完了が済んだら必ず `graphhopper_todo` を呼ぶこと
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
- `light`/`advised` で route=polish になると `router_check` が自動昇格し `escalated: true` を返す。
  その場合レシピは打ち切られ、designing に戻る（design 肉付け＋critic 1回＋3lens）
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
  goal・phase・次アクション・未完了タスク・レビュー結果・VCS 状態を書き出し、goal を pause + unbind する
  （旧セッションの自動継続が止まる）。goal が無い/done ならエラー。
- 新しい会話では plugin が「handoff メモがある」と自動で案内する。案内に従い
  `graphhopper_handoff(action: "load")` を呼ぶと、メモの goal を検証したうえで resume し、
  メモと state のズレ（phase・タスク・history 件数など）を報告する。**正は常に state**。
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
