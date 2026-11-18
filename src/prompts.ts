/**
 * prompts — verifier 角度 verify の共通ルール（純粋層）。
 *
 * 背景: verifier の呼び出しは lens 指示文・渡し物の path・出力契約をメインが毎回
 * 手書きしていた。手書きは path の渡し忘れを招くため、ここに固定して
 * src/verify.ts（buildAnglePrompt）から使う。reviewer の役割定義は src/agents.ts の
 * system が正で、ここは verifier lens の文面だけを持つ。
 */
import * as state from "./state";
import { formatTodoList } from "./todos";

/* 言語版ガード（verifier 共通）。PEP 758 系の誤検知を止める。
 * SKILL.md の同名ルールと一対で維持すること。 */
export const VERSION_GUARD_RULE = [
  "言語版ガード: 構文・API の指摘前に requires-python / .python-version / toolchain の版を必ず確認する。",
  "Python 3.14+ では PEP 758 により括弧なし except（except A, B:）は有効な構文。版が 3.14+ なら誤検知として扱い、指摘しない（警告が出る場合のみ言及）。",
  "版が不明・3.13 以前なら従来通り指摘してよい。",
].join("\n");

/* 角度の並列 verify 用。verifier 自身は角度を起動しない（graphhopper_verify が起動する）ので、
 * 「投げてよい」ではなく「他は別セッション」と伝える（design g-mwiwxc5a 判断4）。
 */
export const PARALLEL_NOTE =
  "他の角度は別セッションで並列に走る。自分は担当の角度だけを検証し、他の角度の結果を仮定しない。";

/** 角度 verify の共通ルール（凍結の対象。角度の文面は凍結しない。design g-mwmqmg6b 判断6）。
 * 並列の注記・版の確認・効率則・証拠状態を 1 本にまとめる。 */
export function commonRules(): string[] {
  return [VERIFIER_EFFICIENCY_RULE, VERIFIER_EVIDENCE_RULE, "", VERSION_GUARD_RULE, "", PARALLEL_NOTE];
}

/* 全角度共通の証拠状態ルール（design g-mwiwxc5a 判断4）。level だけを書かせない。 */
export const VERIFIER_EVIDENCE_RULE =
  "findingsには証拠状態を必ず付ける: 裏付けあり / 証拠不足 / 診断未実行 / 実行失敗。原因不明のまま level だけ付けない。";

/* verifier調査効率則（graft-first＋診断添付）。全角度共通。
 * SKILL.md polish節・agents.ts verifier promptと一対で維持すること */
export const VERIFIER_EFFICIENCY_RULE = [
  "調査効率則: 周辺コード探索は graft MCP / ast-grep / rg を優先し、ファイル横断の漁り読みをしない。",
  "Readはdiff本体＋graft/diffが指した関数・テスト単位のみ。graft未構築時は従来Readへフォールバックする。",
  "全文catして数える（cat | wc等）・同一範囲の再読は禁止。行特定はgrep/graftで行い、Readは1範囲1回。",
  "型・lint診断は自分で実行しない（診断系コマンドはbash deny）。main添付の診断ファイル（.graphhopper/tmp/diag-<goal>.txt）をReadして証拠に使え。添付が無ければ「診断未実行（理由）」を明記し、診断不在を clean の根拠にしない。",
  "ただし診断クリーン≠driftなし（挙動 drift は診断に出ない）。",
].join("\n");

/**
 * 進捗タスク一覧（lens に渡す）。
 * design.md は planning 終端で immutable なので進捗の source of truth は
 * .graphhopper/todos/<goalId>.json のほう。タスク 0 件なら空文字を返す。
 * ストアを読めなかった場合は空文字ではなく「読めなかった」を明示する
 * （タスク無しと区別.Fail-open にして進捗チェックを黙って消さない）。
 */
export function todoSection(root: string, goalId: string): string {
  const loaded = state.readTodosStatus(root, goalId);
  if (!loaded.valid) {
    return [
      "",
      "## 進捗タスク（source of truth: .graphhopper/todos/）",
      "",
      "ストアを読み込めなかった（壊れている可能性がある）。進捗起因の drift は判定不能として扱い、",
      "『進捗は確認できなかった』と evidence_state に明記せよ。",
    ].join("\n");
  }
  if (loaded.store.items.length === 0) return "";
  const lines = [
    "",
    "## 進捗タスク（source of truth: .graphhopper/todos/）",
    "",
    formatTodoList(loaded.store),
    "",
    "未完了タスクが残っていないか、cancelled の理由が妥当かを見よ。",
  ];
  if (loaded.invalidCount > 0) {
    // 不正要素は store から消えている（drop される）。0件扱いすると進捗を見失うので明示する
    lines.push(
      "",
      `⚠ ストアに不正要素が ${loaded.invalidCount} 件ある（一覧から除かれている）。` +
        "進捗は完全には確認できないので、その旨を evidence_state に明記せよ。",
    );
  }
  return lines.join("\n");
}
