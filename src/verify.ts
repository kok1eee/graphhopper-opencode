/**
 * verify の prompt 組み立てと判定の読み取り（純粋層。design g-mwiocibp 判断3・4）。
 *
 * 背景: polish/advisor の verifier 呼び出しは、lens 指示文・design/intent/diff/diag の
 * path・出力契約をメインが毎回手書きしていた。手書きは path の渡し忘れ（前回の light goal
 * で実際に起きた）と、判定の書き写しミスを招く。ここに固定して tool から使う。
 *
 * 出力契約は agent の system ではなく prompt 側に置く。system は本文（findings と
 * 証拠状態）の書き方を定めているだけで末尾の形式は指定していないため、追記ならぶつからない。
 * （workflow.ts の verify ノードは末尾 json に別形式を要求するので、system には書かない）
 */
import { existsSync } from "node:fs";
import { PROMPT_DEFS } from "./prompts";
import type { DriftTarget, VerdictLevel, VerifierLens } from "./state";
import { extractJsonBlock } from "./workflow";

/** 判定の json フェンス規約（prompt に足す。パースは parseLensVerdict） */
export const VERDICT_CONTRACT = [
  "",
  "## 出力形式（必須）",
  "本文（findings と各 finding の証拠状態）を書いたあと、最後に次の形の json フェンスを1つだけ出す。",
  "```json",
  '{"level":"clean","summary":"判定の要約1〜2文"}',
  "```",
  'drift の場合は {"level":"drift","target":"implementing|design|requirements","summary":"1〜2文"}。',
  "level=clean なら target は書かない。drift なら target は必須（巻き戻し先）。",
  "findings の全文は本文に書き、json には入れない。json はフェンス1つだけ。",
].join("\n");

export function promptNameFor(lens: VerifierLens): string {
  return `graphhopper-verifier-${lens}`;
}

export interface LensPaths {
  designPath: string;
  diffPath: string;
  diagPath: string;
  /** 意図ログ（requirement/general lens のみ。無ければ null） */
  intentPath: string | null;
}

/** lens 1つ分の prompt（lens 指示文＋渡し物の path＋出力契約） */
export function buildLensPrompt(
  root: string,
  goalId: string,
  lens: VerifierLens,
  paths: LensPaths,
): string {
  const def = PROMPT_DEFS.find((p) => p.name === promptNameFor(lens));
  if (!def) throw new Error(`lens 指示文が無い: ${lens}`);
  const lines = [
    def.render({ goalId }, root),
    "",
    "## 渡し物（path で渡す。inline 展開は禁止）",
    `design: ${paths.designPath}`,
    `diff: ${paths.diffPath}`,
    `diagnostics: ${paths.diagPath}`,
  ];
  if (paths.intentPath) {
    lines.push(
      `intent（意図ログ）: ${paths.intentPath}`,
      "design と実装がユーザーの意図からズレていないかを見る根拠に使え（決定の再審議はしない）。",
    );
  }
  lines.push(VERDICT_CONTRACT);
  return lines.join("\n");
}

export interface ParsedVerdict {
  level: VerdictLevel;
  target?: DriftTarget;
  summary: string;
}

export type ParseResult =
  | { ok: true; verdict: ParsedVerdict }
  | { ok: false; reason: string };

/** verifier の出力から判定を取り出す。読めなければ理由を返す（throwしない） */
export function parseLensVerdict(output: string): ParseResult {
  const obj = extractJsonBlock(output);
  if (!obj) return { ok: false, reason: "末尾に json フェンスが無い（判定を読めない）" };
  const level = obj["level"];
  if (level !== "clean" && level !== "drift") {
    return { ok: false, reason: `level が不正: ${String(level)}` };
  }
  const summary = typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
  if (!summary) return { ok: false, reason: "summary が空" };
  if (level === "clean") return { ok: true, verdict: { level, summary } };
  const target = obj["target"];
  if (target !== "implementing" && target !== "design" && target !== "requirements") {
    return { ok: false, reason: `drift なのに target が不正: ${String(target)}` };
  }
  return { ok: true, verdict: { level, target, summary } };
}

/** invoke 自身が付ける失敗の印（本文中の "error:" 行を拾わないため、印だけを見る）。
 * fail() は出力の先頭に、runChild は末尾に付ける。 */
const INVOKE_ERROR_HEAD = /^error: /;
const INVOKE_ERROR_TAIL =
  /\nerror: (?:invoke cancelled by client|invoke timeout after|opencode run exited with code)/;

/** verifier の出力が「invoke 失敗」か。失敗なら判定不能の理由を返す（throwしない） */
export function invokeFailure(output: string): string | null {
  if (INVOKE_ERROR_HEAD.test(output) || INVOKE_ERROR_TAIL.test(output)) {
    return "invoke がエラーを返した";
  }
  return null;
}

/** 意図ログを渡してよい lens か（決定の再審議を招く behavior/progress には渡さない） */
export function lensTakesIntent(lens: VerifierLens): boolean {
  return lens === "requirement" || lens === "general";
}

/** path 一式（存在しない intent は null） */
export function lensPaths(root: string, goalId: string, lens: VerifierLens, p: {
  designPath: string;
  diffPath: string;
  diagPath: string;
  intentPath: string;
}): LensPaths {
  const intent = lensTakesIntent(lens) && existsSync(p.intentPath) ? p.intentPath : null;
  return {
    designPath: p.designPath,
    diffPath: p.diffPath,
    diagPath: p.diagPath,
    intentPath: intent,
  };
}
