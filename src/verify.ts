/**
 * verify の prompt 組み立てと判定の読み取り（純粋層。design g-mwiocibp 判断3・4）。
 *
 * 背景: polish/advisor の verifier 呼び出しは、lens 指示文・design/intent/diff/diag の
 * path・出力契約をメインが毎回手書きしていた。手書きは path の渡し忘れ（前回の light goal
 * で実際に起きた）と、判定の書き写しミスを招く。ここに固定して tool から使う。
 *
 * 出力契約は agent の system ではなく prompt 側に置く。system は本文（findings と
 * 証拠状態）の書き方を定めているだけで末尾の形式は指定していないため、追記ならぶつからない。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commonRules, todoSection } from "./prompts";
import { AGREEMENT_ID, SIBLINGS_ID, type PlanEntry } from "./angles";
import { sha1Hex } from "./hashedit";
import * as state from "./state";
import type { DriftTarget, VerdictLevel, VerifierLens } from "./state";

/** 採点基準（lens の固定部分＋出力契約）の凍結（design g-mwmnvx3x 判断1）。
 *
 * goal 開始時の文面で判定する。採点される差分が採点基準を書き換えられないようにする
 * （design.md の不変性と同じ理屈）。動的部分（phase・todo・path）は凍結しない。
 *
 * 限界: このファイルと state.json は goal 自身も書けるので tamper-evident であって
 * tamper-proof ではない。完全に防ぐには基準を repo 外に置く必要がある。 */
export interface RubricSnapshot {
  goal_id: string;
  frozen_at: string;
  /** 凍結の形。2＝共通ルール（static.common）と出力の形だけ。無い（旧）は lens 別の固定部分 */
  v?: number;
  /** v2: { common: 共通ルールの行 }。旧: lens prompt name -> 固定部分の行 */
  static: Record<string, string[]>;
  contract: string;
  /** 採点コード（RUBRIC_CODE_FILES）の sha1 */
  code_hash: string;
  /** verifier agent md の sha1（見つからなければ null） */
  agent_hash: string | null;
  /** static + contract の sha1（改ざん検知用） */
  hash: string;
}

export function rubricPath(root: string, goalId: string): string {
  return join(root, ".graphhopper", "plans", `${goalId}.rubric.json`);
}

/** 凍結対象の文字列（現行）。hash もこれで取る */
function rubricContent(): { static: Record<string, string[]>; contract: string } {
  return { static: { common: commonRules() }, contract: VERDICT_CONTRACT };
}

/** static + contract の sha1（凍結・現行・改ざん検知で同じ関数を使う） */
function hashRubric(staticText: Record<string, string[]>, contract: string): string {
  return sha1Hex(JSON.stringify({ static: staticText, contract }));
}

export function currentRubricHash(): string {
  const c = rubricContent();
  return hashRubric(c.static, c.contract);
}

/** 採点コードの監視対象。state.ts 丸ごとは広すぎる（約半分の goal で鳴る）ので、
 * 採点関数だけを切り出した verdict.ts を見る（design g-mwmqmg6b 判断5） */
export const RUBRIC_CODE_FILES = ["verify.ts", "prompts.ts", "angles.ts", "verdict.ts"];

/** 採点コードの sha1（goal が触ると verifier_self_modified が記録される。止めはしない） */
export function rubricCodeHash(): string {
  const dir = import.meta.dir;
  const parts = RUBRIC_CODE_FILES.map((f) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return "";
    }
  });
  return sha1Hex(parts.join("\n"));
}

/** verifier agent md の sha1（bake 済みの実体）。global と repo の両方を見る。
 * どちらも見つからなければ null */
export function rubricAgentHash(): string | null {
  const home = process.env["HOME"] ?? "";
  const paths = [
    home ? join(home, ".config", "opencode", "agents", "graphhopper-verifier.md") : "",
    join(import.meta.dir, "..", ".opencode", "agents", "graphhopper-verifier.md"),
  ];
  const parts: string[] = [];
  for (const path of paths) {
    try {
      parts.push(path && existsSync(path) ? readFileSync(path, "utf8") : "");
    } catch {
      parts.push("");
    }
  }
  return parts.every((p) => p === "") ? null : sha1Hex(parts.join("\n--\n"));
}

/** goal 開始時に基準を凍結する。失敗しても start は止めない（呼び出し側が記録） */
export function snapshotRubric(root: string, goalId: string): RubricSnapshot | null {
  try {
    const c = rubricContent();
    const snap: RubricSnapshot = {
      goal_id: goalId,
      v: 2,
      frozen_at: new Date().toISOString(),
      static: c.static,
      contract: c.contract,
      code_hash: rubricCodeHash(),
      agent_hash: rubricAgentHash(),
      hash: hashRubric(c.static, c.contract),
    };
    const path = rubricPath(root, goalId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snap, null, 1)}\n`, "utf8");
    renameSync(tmp, path);
    return snap;
  } catch {
    return null;
  }
}

/** 凍結済みの基準。無い・壊れている・goal が違うなら null */
export function loadRubric(root: string, goalId: string): RubricSnapshot | null {
  try {
    const path = rubricPath(root, goalId);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const r = raw as Partial<RubricSnapshot> | null;
    if (!r || r.goal_id !== goalId) return null;
    if (typeof r.hash !== "string" || typeof r.contract !== "string") return null;
    const st = r.static as Record<string, string[]> | undefined;
    if (!st || typeof st !== "object") return null;
    return {
      goal_id: goalId,
      ...(r.v === 2 ? { v: 2 } : {}),
      frozen_at: String(r.frozen_at ?? ""),
      static: st,
      contract: r.contract,
      code_hash: String(r.code_hash ?? ""),
      agent_hash: typeof r.agent_hash === "string" ? r.agent_hash : null,
      hash: r.hash,
    };
  } catch {
    return null;
  }
}

/** 凍結した基準の整合。tampered=検証を止める / 変更は記録のみ */
export interface RubricStatus {
  frozen: boolean;
  /** 凍結ファイルが消えた・内容が hash と合わない */
  tampered: boolean;
  /** 前の形（v 無し）の凍結。hash だけ確かめ、採点基準は現行を使う（次の goal で削除） */
  legacy?: boolean;
  /** 固定部分が現行と違う（goal が基準を直した） */
  changed: boolean;
  /** 採点コードか verifier agent md が現行と違う */
  selfModified: boolean;
  codeChanged: boolean;
  agentChanged: boolean;
}

export function rubricStatus(
  root: string,
  goalId: string,
  /** state に残した開始時のハッシュ。渡すとファイル側の hash 書き換えも検知できる */
  expectedHash?: string | null,
): RubricStatus {
  const snap = loadRubric(root, goalId);
  if (!snap) {
    return {
      frozen: false,
      tampered: false,
      changed: false,
      selfModified: false,
      codeChanged: false,
      agentChanged: false,
    };
  }
  const contentHash = hashRubric(snap.static, snap.contract);
  const tampered =
    contentHash !== snap.hash || (!!expectedHash && expectedHash !== snap.hash);
  if (snap.v !== 2) {
    return {
      frozen: true,
      tampered,
      legacy: true,
      changed: false,
      selfModified: false,
      codeChanged: false,
      agentChanged: false,
    };
  }
  const codeChanged = !tampered && snap.code_hash !== rubricCodeHash();
  const agentChanged =
    !tampered && snap.agent_hash !== null && snap.agent_hash !== rubricAgentHash();
  return {
    frozen: true,
    tampered,
    changed: contentHash !== currentRubricHash(),
    selfModified: codeChanged || agentChanged,
    codeChanged,
    agentChanged,
  };
}

/** severity の型は state.ts を正とする（凍結ファイルと状態で同じ形を使う） */
export type SeverityCounts = state.VerifierSeverityCounts;
const ZERO_SEVERITY: SeverityCounts = { must_fix: 0, should_fix: 0, nit: 0, pre_existing: 0 };

/** 最後の ```json フェンスをパース。無い・不正は null */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const re = /```json\s*\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1] ?? null;
  if (last === null) return null;
  try {
    const v = JSON.parse(last) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 判定の json フェンス規約（prompt に足す。パースは parseLensVerdict） */
export const VERDICT_CONTRACT = [
  "",
  "## 出力形式（必須）",
  "本文（findings と各 finding の証拠状態）を書いたあと、最後に次の形の json フェンスを1つだけ出す。",
  "```json",
  '{"level":"clean","summary":"判定の要約1〜2文","severity":{"must_fix":0,"should_fix":0,"nit":0,"pre_existing":0}}',
  "```",
  'drift の場合は {"level":"drift","target":"implementing|design|requirements","summary":"1〜2文","severity":{...}}。',
  "level=clean なら target は書かない。drift なら target は必須（巻き戻し先）。",
  "severity は任意だが、書くなら findings の件数を数えて入れる（must_fix=直さないと出せない / should_fix / nit / pre_existing=元からある問題）。",
  "severity は重要度の目安で、level/target の判定は変えない。数えられないなら省略する（未申告として扱う。0 と書かない）。",
  "findings の全文は本文に書き、json には入れない。json はフェンス1つだけ。",
  "指摘ファイル（前回の指摘）を渡されたときは、json に prior を足す: \"prior\":{\"valid\":妥当だった件数,\"invalid\":誤りだった件数,\"unresolved\":まだ直っていない件数}。",
  "unresolved に数えるのは、残っていると clean にできない指摘だけ（1 件でもあれば drift になる）。clean を妨げない指摘（nit・pre_existing）が残っていても数えない。",
].join("\n");

export interface LensPaths {
  designPath: string;
  diffPath: string;
  diagPath: string;
  /** 意図ログ（agreement 角度のみ。無ければ null） */
  intentPath: string | null;
}

/** 前回の指摘の判定（件数） */
export interface PriorCounts {
  valid: number;
  invalid: number;
  unresolved: number;
}

export interface ParsedVerdict {
  level: VerdictLevel;
  /** 前回の指摘の判定（指摘ファイルを渡したときだけ） */
  prior?: PriorCounts;
  target?: DriftTarget;
  summary: string;
  /** 重要度の件数（未申告なら undefined。0 件と区別する） */
  severity?: SeverityCounts;
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
  const severity = parseSeverity(obj["severity"]);
  const prior = parsePrior(obj["prior"]);
  const withSeverity = { ...(severity ? { severity } : {}), ...(prior ? { prior } : {}) };
  /* 前回の指摘が直っていないのに clean は矛盾なので drift に倒す */
  if (level === "clean" && prior && prior.unresolved > 0) {
    return { ok: true, verdict: { level: "drift", target: "implementing", summary, ...withSeverity } };
  }
  if (level === "clean") return { ok: true, verdict: { level, summary, ...withSeverity } };
  const target = obj["target"];
  if (target !== "implementing" && target !== "design" && target !== "requirements") {
    return { ok: false, reason: `drift なのに target が不正: ${String(target)}` };
  }
  return { ok: true, verdict: { level, target, summary, ...withSeverity } };
}

/** prior の読み取り。3 つの非負整数が揃っていなければ undefined */
export function parsePrior(v: unknown): PriorCounts | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!ok(r["valid"]) || !ok(r["invalid"]) || !ok(r["unresolved"])) return undefined;
  return { valid: r["valid"], invalid: r["invalid"], unresolved: r["unresolved"] };
}

/** severity の読み取り。不正値・欠落は無視する（判定を止めない）。
 * 1 つも読めなければ undefined（＝未申告。0 件と区別する）。 */
export function parseSeverity(v: unknown): SeverityCounts | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const rec = v as Record<string, unknown>;
  const keys = ["must_fix", "should_fix", "nit", "pre_existing"] as const;
  const out: Partial<SeverityCounts> = {};
  let any = false;
  for (const k of keys) {
    const n = rec[k];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) {
      out[k] = n;
      any = true;
    }
  }
  if (!any) return undefined;
  return { ...ZERO_SEVERITY, ...out };
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

export interface AnglePaths extends LensPaths {
  /** 前回の指摘（持ち越した角度にだけ渡す） */
  priorPath?: string | null;
  /** 今回の 1 巡目の指摘（追い検証の siblings にだけ渡す） */
  findingsPath?: string | null;
}

/** 角度 1 つ分の prompt（凍結した共通ルール＋角度の文面＋渡し物の path＋出力の形）。
 * 意図ログと進捗を渡すのは agreement だけ（design g-mwmqmg6b 判断1） */
export function buildAnglePrompt(
  root: string,
  goalId: string,
  entry: PlanEntry,
  paths: AnglePaths,
): string {
  const snap = loadRubric(root, goalId);
  const common = snap?.v === 2 ? (snap.static["common"] ?? commonRules()) : commonRules();
  const contract = snap?.contract ?? VERDICT_CONTRACT;
  const lines = [
    ...common,
    "",
    `## 角度: ${entry.title}（${entry.id}）`,
    `疑うこと: ${entry.doubt}`,
    `見る範囲: ${entry.scope}`,
    "diff が途中で切れていても、見る範囲のファイルは自分で開いて確かめる。",
    "",
    "## 渡し物（path で渡す。inline 展開は禁止）",
    `design: ${paths.designPath}`,
    `diff: ${paths.diffPath}`,
    `diagnostics: ${paths.diagPath}`,
  ];
  if (entry.id === AGREEMENT_ID && paths.intentPath) {
    lines.push(
      `intent（意図ログ）: ${paths.intentPath}`,
      "design と実装がユーザーの意図からズレていないかを見る根拠に使え（決定の再審議はしない）。",
    );
  }
  if (entry.id === AGREEMENT_ID) {
    const todos = todoSection(root, goalId);
    if (todos) lines.push(todos);
  }
  if (entry.id === SIBLINGS_ID && paths.findingsPath) {
    lines.push(
      `今回の指摘ファイル: ${paths.findingsPath}`,
      "今回の 1 巡目で出た指摘。同じ種類の問題が、指摘された場所以外にないかを探す。",
    );
  }
  if (entry.carried && paths.priorPath) {
    lines.push(
      `指摘ファイル: ${paths.priorPath}`,
      "前回の指摘。各指摘が今の実装で妥当か・誤りか・まだ直っていないかを判定し、json の prior に件数を書く（prior に数えるのはこのファイルの指摘だけ。今回の指摘ファイルの指摘は数えない）。",
    );
  }
  lines.push(contract);
  if (entry.carried && paths.priorPath) {
    /* 凍結した出力の形（前の形）には prior の説明が無いことがあるので、最後に形を念押しする */
    lines.push(
      '持ち越した角度なので、json に "prior":{"valid":N,"invalid":N,"unresolved":N} を必ず入れる（無いと判定不能になる）。unresolved には、残っていると clean にできない指摘だけを数える（nit は数えない）。',
    );
  }
  return lines.join("\n");
}
