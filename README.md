# graphhopper-opencode

**graphhopper for opencode** — designing/implementing/polish state machine plugin。

元は Claude Code plugin として作られた [graphhopper](../graphhopper) を、
[opencode](https://opencode.ai/) plugin として再設計した版。flywheel-opencode の
atomic write パターン（`src/state.ts`）・agent注入パターン（`src/agents.ts`）を参考にしつつ、
ゼロから実装している。

## graphhopper本体との対応・最大の違い

graphhopper本体（Claude Code版）はshell hook（`hooks/design-gate.sh` / `hooks/loop-driver.sh`）で
designing中のsource編集を物理ブロックし、diffサイズでadvisor/polishに分岐する。opencodeには
Claude Codeのshell hook（PreToolUse/Stop）に相当する仕組みが無いため、plugin本体（TS）で
同じ強制力を作る:

| Claude Code | opencode | 実装 |
|---|---|---|
| `PreToolUse`（design-gate.sh の物理ブロック） | `tool.execute.before` | `src/index.ts` の design gate |
| `Stop`（loop-driver.sh の router gate） | `event: session.idle` | `src/index.ts` の continuation |
| `eval_cmd`（`bin/graphhopper set-eval`、Stop hookで機械実行） | `graphhopper_set_eval` + `session.idle` で機械実行 | `src/state.ts` の `runEval` / `src/index.ts` の `session.idle` |
| `Workflow`（agent()+parallel()のインラインJS） | 無し | fan-outは skill が `task()` を手動で複数回呼ぶ + `graphhopper_discover_tick` 等のTS toolでround cap/dedupeを強制 |

**flywheel-opencodeとの違い**: flywheel-opencodeは`tool.execute.before`を一切使っていない
（continuationTextで指示するだけで、実際にEdit/Writeを拒否する強制力が無い）。graphhopper-opencodeは
これを追加し、C-2不変条件（designing中はsource編集を物理ブロック）をコード側で担保する。

## 構成

```
graphhopper-opencode/
├── src/
│   ├── index.ts   — プラグイン本体（tool.execute.before + event + 8 tool）
│   ├── state.ts   — .graphhopper/ 配下の state 管理（atomic write）
│   └── agents.ts  — 2 subagent 定義（config hook で注入）
├── skills/
│   ├── graphhopper/ — メインのdesigning/implementing/polishループ
│   └── discover/    — loop-until-dry 探索（phase graphの外、オンデマンド）
├── commands/
│   ├── graphhopper.md
│   ├── graphhopper-status.md
│   ├── graphhopper-stop.md
│   └── graphhopper-resume.md
├── package.json
└── tsconfig.json
```

## 提供するツール

| ツール | 用途 |
|---|---|
| `graphhopper_goal` | goal の start/pause/resume/complete/clear |
| `graphhopper_status` | 現在 goal + フェーズ + router + verifier 表示 |
| `graphhopper_phase` | フェーズ遷移（designing → implementing → polish → done） |
| `graphhopper_router_check` | diffサイズを機械測定し advisor(verifier×1)/polish(verifier×3) に分岐（loop-driver.sh相当） |
| `graphhopper_verifier_set` | verifier結果（clean/drift）を記録。lensが空だとエラーになる（self-graded完了防止の機械ゲート） |
| `graphhopper_set_eval` | implementingの合否判定コマンド（本体のeval_cmd相当）を設定。設定後はターン終了ごと自動実行され、pass=polish自動遷移／fail=fail_streak機械カウント |
| `graphhopper_discover_start` / `_tick` / `_clear` | loop-until-dry 探索（round cap/dedupeをtool側で強制） |
| `graphhopper_handoff` | 現在の goal 状態を要約して別の opencode セッションへ引き継ぎ送信。送信後は送信側が goal から解放（pause + unbind）。`session_id` 未指定なら候補セッションを列挙（送信しない）。受け手は `graphhopper_resume` で引き継ぐ |

## 提供する subagent

| subagent | 用途 | model |
|---|---|---|
| `graphhopper-researcher` | 事実収集・調査専用。高頻度なので最安モデル | `amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0` |
| `graphhopper-verifier` | polishのadversarial verifier fan-out。判断node | `amazon-bedrock/anthropic.claude-opus-5` |
| `graphhopper-oracle` | implementingで詰まった時（`graphhopper_attempt`のfail_streakがstuck_threshold到達）の相談役 | `amazon-bedrock/anthropic.claude-opus-5` |

graphhopper本体のtiering（researcher=haiku, main=sonnet, advisor/verifier=opus）をそのまま踏襲。
vendorは増やさない（judgment分散はレンズの違いで確保し、council再発防止の原則を守る）。
`.graphhopper/config.json` の `agents.<name>` で上書き可能。

### 2つの上位モデル起動軸

router gate（diffサイズ）とstuck escalation（詰まった回数）は独立した分岐点:

| 軸 | トリガー | 呼ばれるagent | 目的 |
|---|---|---|---|
| router gate | `graphhopper_router_check` がdiff行数を機械測定 | `graphhopper-verifier` ×1(advisor,general charter)/×3(polish fan-out) | done-gate前のdrift検証 |
| stuck escalation | `graphhopper_attempt` の連続失敗が`stuck_threshold`（既定3）到達 | `graphhopper-oracle` ×1 | implementing中の手詰まり打開 |

router gate側は**advisorでも第三者チェックそのものは省略できない**（`graphhopper_verifier_set`が
lens空を拒否するため、diffサイズに関わらず最低1回のverifier呼び出しが機械的に必須。self-graded
完了を防ぐ）。fan-out数（1 or 3）だけがdiffサイズで変わる。

いずれも「無条件で毎回opusを呼ぶ」のではなく、コード側で機械測定・機械カウントした
タイミングでだけ上位モデルのコストを払う設計。

## ponytail 統合（implementing フェーズ限定）

[ponytail](https://github.com/DietrichGebert/ponytail)（怠惰なシニアデベロッパー / YAGNI）のルールを
**implementing フェーズ中のみ・メインセッションのみ**に注入する。

- グローバルの ponytail プラグイン（全ターン常時注入 ~1,400 トークン）は使わず、
  graphhopper の `experimental.chat.system.transform` フック内で `.graphhopper/state.json` の
  `phase === "implementing"` かつ `session_id === 当該セッション` のときだけ注入する。
- ルール本文は `src/ponytail-rules.ts` に vendored（ディスティル版 ~900–1,200 トークン（CJK 混在・実測）、
  `@dietrichgebert/ponytail@4.9.0` の SKILL.md 由来、MIT）。
- designing 中は「書くな」圧をかけない。polish は `graphhopper-simplify` が担当。
- 注意: `graphhopper_phase(implementing)` を呼ぶターン自体には注入されず、次ターンから有効。
  逆も同様で、`graphhopper_phase(polish)` を呼ぶターンは phase がまだ implementing のため注入されたまま
  （prompt-time ゲートの構造的必然。影響は遷移ターンの1回のみ）。

## state の場所

```
.graphhopper/
├── goals.json      — 目標キュー + active 指定
├── state.json      — 現在のループ状態（goal / phase / router / verifier）
├── config.json     — プロジェクト毎の上書き設定（任意）
├── history.jsonl   — 監査ログ（append-only）
├── discover.json   — discoverセッションの一時state（round/seen/confirmed）
└── plans/<goal-id>.md — design ドキュメント（designingフェーズで書く唯一の許可パス）
```

## インストール

```bash
ln -s ~/masayoshi/graphhopper-opencode/src/index.ts ~/.config/opencode/plugins/graphhopper.ts
ln -s ~/masayoshi/graphhopper-opencode/skills/graphhopper ~/.config/opencode/skills/graphhopper
ln -s ~/masayoshi/graphhopper-opencode/skills/discover ~/.config/opencode/skills/graphhopper-discover
mkdir -p ~/.config/opencode/commands
for f in ~/masayoshi/graphhopper-opencode/commands/*.md; do
  ln -sf "$f" ~/.config/opencode/commands/$(basename "$f")
done
```

`~/.config/opencode/opencode.jsonc` に plugin 登録:

```jsonc
{
  "plugins": ["./plugins/graphhopper.ts"]
}
```

## verify

```bash
npx tsc --noEmit
```
