---
name: discover
description: "未知件数の発見系探索（bug hunt/セキュリティ監査/網羅的レビュー等）をloop-until-dryで回す。新規findingが尽きるまで3レンズで探索し、round capで確実に止める。phase graphには組み込まれないオンデマンドツール。"
---

# discover — loop-until-dry 探索

「何件あるか分からない」ものを、尽きるまで（かつ確実に止まるまで）探す。

opencodeにはClaude CodeのWorkflowツール（agent()+parallel()のJSをその場で実行する仕組み）が
無いため、round cap / dedupeのロジックは `graphhopper_discover_tick` tool（TS実装）に持たせて
いる。この skill は「毎ラウンド何をするか」の手順だけを持つ薄いガイド。

## 手順

1. `graphhopper_discover_start(target, scope)` で開始
2. 以下を1ラウンドとして繰り返す:
   - `task(subagent_type: "graphhopper-researcher")` を3回、以下のcharterで呼ぶ
     - broad-scan: 「targetに関連するパターンをscope全体で広く探せ。網羅性重視、grep的な構造探索」
     - semantic-read: 「targetについて、scopeの該当箇所を実際に読んで論理的な妥当性を検証せよ。表面パターンではなく意味を見る」
     - edge-case: 「targetの境界値・異常系（null/空/負数/範囲外/並行性/前ゼロ等）を疑って探せ」
   - 各task呼び出しには、これまでの `seen`（`graphhopper_discover_tick` の戻り値の seen 件数、
     または前回呼び出しのfindings一覧）を「重複報告しないこと」として渡す
   - 3体の結果（findings: title/severity/confidence/quote）を合算し、
     `graphhopper_discover_tick(findings: [...])` に渡す
3. 戻り値の `stopped_reason` が `null` の間、2に戻る
4. `stopped_reason` が出たら停止。**`dry`（自然に尽きた）と`max_rounds`（上限で打ち切り）は
   全く違う意味を持つ情報——沈黙せず、どちらだったかを明示してユーザーに提示する**
5. `confirmed` をquote付きでseverity降順に提示する

## Gotchas

- **round capを外そうとしない**: `graphhopper_discover_tick` 内部の `MAX_DISCOVER_ROUNDS` はdry_streak
  に関わらぬ絶対的な歯止め。ツール側で強制されているので skill 側で気にする必要はないが、
  「もっと探させて」と言われても際限なく手動でroundを増やさない
- **findingsの閾値カットを呼び出し側でしない**: severity/confidenceのフィルタは
  `graphhopper_discover_tick` 内部（confidence>=80 & high/critical）で行われる。researcherへの
  指示は「新規のfindingだけ報告」だけで良く、「重大なものだけ報告」のような保守的指示は書かない
- **scopeを広げすぎない**: target/scopeが曖昧だと1ラウンドのコストが跳ねる。呼び出し前に具体化する
- **phase graphには影響しない**: `graphhopper_phase` や `graphhopper_goal` の状態を変更しない。
  done gateの外で完全に独立
