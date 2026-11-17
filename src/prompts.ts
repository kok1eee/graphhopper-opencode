/**
 * prompts — verifier 4 lens の指示文（純粋層）。
 *
 * 背景: verifier の呼び出しは lens 指示文・渡し物の path・出力契約をメインが毎回
 * 手書きしていた。手書きは path の渡し忘れを招くため、ここに固定して
 * src/verify.ts（buildLensPrompt）から使う。reviewer の役割定義は src/agents.ts の
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

/* fan-out する 3 lens 用。verifier 自身は lens を起動しない（graphhopper_verify が起動する）ので、
 * 「投げてよい」ではなく「他は別セッション」と伝える（design g-mwiwxc5a 判断4）。
 * general は 1 回で 3 観点を見るため入れない。 */
export const PARALLEL_NOTE =
  "他 lens は別セッションで並列に走る。自分は担当 lens だけを検証し、他 lens の結果を仮定しない。";

/* 4 lens 共通の証拠状態ルール（design g-mwiwxc5a 判断4）。level だけを書かせない。 */
export const VERIFIER_EVIDENCE_RULE =
  "findingsには証拠状態を必ず付ける: 裏付けあり / 証拠不足 / 診断未実行 / 実行失敗。原因不明のまま level だけ付けない。";

/** 4 lens の共通ブロック（効率則・証拠状態＋任意で version guard・並列注記）。
 * 個別 render に同じ行を書き写さない（片方だけ直す事故を防ぐ）。 */
function lensPreamble(opts: { parallel: boolean; versionGuard: boolean }): string[] {
  const lines = [VERIFIER_EFFICIENCY_RULE, VERIFIER_EVIDENCE_RULE];
  if (opts.versionGuard) lines.push("", VERSION_GUARD_RULE);
  if (opts.parallel) lines.push("", PARALLEL_NOTE);
  return lines;
}

/* verifier調査効率則（graft-first＋診断添付）。4 lens共通。
 * SKILL.md polish節・agents.ts verifier promptと一対で維持すること */
export const VERIFIER_EFFICIENCY_RULE = [
  "調査効率則: 周辺コード探索は graft MCP / ast-grep / rg を優先し、ファイル横断の漁り読みをしない。",
  "Readはdiff本体＋graft/diffが指した関数・テスト単位のみ。graft未構築時は従来Readへフォールバックする。",
  "全文catして数える（cat | wc等）・同一範囲の再読は禁止。行特定はgrep/graftで行い、Readは1範囲1回。",
  "型・lint診断は自分で実行しない（診断系コマンドはbash deny）。main添付の診断ファイル（.graphhopper/tmp/diag-<goal>.txt）をReadして証拠に使え。添付が無ければ「診断未実行（理由）」を明記し、診断不在を clean の根拠にしない。",
  "ただし診断クリーン≠driftなし（挙動 drift は診断に出ない）。",
].join("\n");

/* PromptDef は prompts.ts 内のみで使用（公開面は PROMPT_DEFS）。
 * tool/agent の引数定義は持たない（plugin の tool が入力スキーマの正）。 */
interface PromptDef {
  name: string;
  /** 固定部分（役割・lensPreamble）。goal 開始時に凍結する対象（design g-mwmnvx3x 判断1） */
  staticText: string[];
  /** 動的部分（goalHeader・todoSection）。verify のたびに現行から作る */
  dynamic: (root: string, goalId: string) => string[];
  render: (args: Record<string, string>, root: string) => string;
}

function activeGoalId(root: string, goalId?: string): string {
  if (goalId) return goalId;
  const a = state.getActive(root);
  if (!a) throw new Error("no active goal (goalId を明示するか goal を start せよ)");
  return a.goal.id;
}

/**
 * 進捗タスク一覧（lens に渡す）。
 * design.md は planning 終端で immutable なので進捗の source of truth は
 * .graphhopper/todos/<goalId>.json のほう。タスク 0 件なら空文字を返す。
 * ストアを読めなかった場合は空文字ではなく「読めなかった」を明示する
 * （タスク無しと区別.Fail-open にして進捗チェックを黙って消さない）。
 */
function todoSection(root: string, goalId: string): string {
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

function goalHeader(root: string, goalId: string): string {
  const a = state.getActive(root);
  const s =
    a && a.goal.id === goalId
      ? `phase: ${a.state.phase} | route: ${a.state.router.route ?? "-"} | fail_streak: ${a.state.fail_streak}`
      : "(active goal とは別ID)";
  return `goal: ${goalId} [${s}]`;
}

export const PROMPT_DEFS: PromptDef[] = [
  {
    name: "graphhopper-verifier-requirement",
    staticText: [
      "あなたは graphhopper の verifier（requirement lens）である。",
      "実装が design.md の意図（done の定義）から外れていないかを検証せよ。",
      ...lensPreamble({ parallel: true, versionGuard: true }),
    ],
    dynamic: (root, id) => [goalHeader(root, id)],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        ...PROMPT_STATIC["graphhopper-verifier-requirement"],
        "",
        ...PROMPT_DYNAMIC["graphhopper-verifier-requirement"](root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-behavior",
    staticText: [
      "あなたは graphhopper の verifier（behavior lens）である。",
      "変更の挙動が正しいか、テストが実際のユーザーパスを検証しているかを検証せよ。",
      "エッジケース・境界値・失敗時の振る舞いを見ろ。",
      ...lensPreamble({ parallel: true, versionGuard: true }),
    ],
    dynamic: (root, id) => [goalHeader(root, id)],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      return [
        ...PROMPT_STATIC["graphhopper-verifier-behavior"],
        "",
        ...PROMPT_DYNAMIC["graphhopper-verifier-behavior"](root, id),
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-progress",
    staticText: [
      "あなたは graphhopper の verifier（progress lens）である。",
      "変更が goal に収束しているか、スコープ外の膨張・未完の残骸が無いかを検証せよ。",
      "決定の経緯・棄却した代替案が .log.md に追記されているかも見ろ。",
      ...lensPreamble({ parallel: true, versionGuard: false }),
    ],
    dynamic: (root, id) => [goalHeader(root, id), todoSection(root, id)],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      const dyn = PROMPT_DYNAMIC["graphhopper-verifier-progress"](root, id);
      return [
        ...PROMPT_STATIC["graphhopper-verifier-progress"],
        "",
        ...dyn,
      ].join("\n");
    },
  },
  {
    name: "graphhopper-verifier-general",
    staticText: [
      "あなたは graphhopper の verifier（general lens）である。",
      "「実装が design.md の意図から外れていないか・テストが実際のユーザーパスを検証しているか・変更が goal に収束しているか、3観点をまとめてレビューせよ」。",
      ...lensPreamble({ parallel: false, versionGuard: true }),
    ],
    dynamic: (root, id) => [goalHeader(root, id), todoSection(root, id)],
    render: (args, root) => {
      const id = activeGoalId(root, args["goalId"]);
      const dyn = PROMPT_DYNAMIC["graphhopper-verifier-general"](root, id);
      return [
        ...PROMPT_STATIC["graphhopper-verifier-general"],
        "",
        ...dyn,
      ].join("\n");
    },
  },
];


/* 固定部分と動的部分の索引（verify の凍結で使う。design g-mwmnvx3x 判断1）。
 * PROMPT_DEFS から組み立てるので、lens を足しても追随する。 */
export const PROMPT_STATIC: Record<string, string[]> = Object.fromEntries(
  PROMPT_DEFS.map((d) => [d.name, d.staticText]),
);
export const PROMPT_DYNAMIC: Record<string, (root: string, goalId: string) => string[]> =
  Object.fromEntries(PROMPT_DEFS.map((d) => [d.name, d.dynamic]));
