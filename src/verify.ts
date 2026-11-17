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
import { PROMPT_DEFS, PROMPT_DYNAMIC, PROMPT_STATIC } from "./prompts";
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
  /** lens prompt name -> 固定部分の行 */
  static: Record<string, string[]>;
  contract: string;
  /** 採点コード（verify.ts / prompts.ts / state.ts）の sha1 */
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
  return { static: PROMPT_STATIC, contract: VERDICT_CONTRACT };
}

/** static + contract の sha1（凍結・現行・改ざん検知で同じ関数を使う） */
function hashRubric(staticText: Record<string, string[]>, contract: string): string {
  return sha1Hex(JSON.stringify({ static: staticText, contract }));
}

export function currentRubricHash(): string {
  const c = rubricContent();
  return hashRubric(c.static, c.contract);
}

/** 採点コードの sha1。state.ts は aggregateVerdicts を含むため対象（goal が触ると
 * verifier_self_modified が記録される。止めはしない） */
export function rubricCodeHash(): string {
  const dir = import.meta.dir;
  const parts = ["verify.ts", "prompts.ts", "state.ts"].map((f) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return "";
    }
  });
  return sha1Hex(parts.join("\n"));
}

/** verifier agent md の sha1（bake 済みの実体）。見つからなければ null */
export function rubricAgentHash(): string | null {
  try {
    const home = process.env["HOME"] ?? "";
    if (!home) return null;
    const path = join(home, ".config", "opencode", "agents", "graphhopper-verifier.md");
    if (!existsSync(path)) return null;
    return sha1Hex(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** goal 開始時に基準を凍結する。失敗しても start は止めない（呼び出し側が記録） */
export function snapshotRubric(root: string, goalId: string): RubricSnapshot | null {
  try {
    const c = rubricContent();
    const snap: RubricSnapshot = {
      goal_id: goalId,
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
  /* 注意: def.render は使わない（凍結を見ない）。ここが prompt 合成の唯一の点 */
  const name = promptNameFor(lens);
  const def = PROMPT_DEFS.find((p) => p.name === name);
  if (!def) throw new Error(`lens 指示文が無い: ${lens}`);
  /* 固定部分は goal 開始時の凍結を使う（無ければ現行＝legacy）。
   * 動的部分（phase・todo）は毎回現行から作る（design g-mwmnvx3x 判断1） */
  const snap = loadRubric(root, goalId);
  const fixed = snap?.static[name] ?? PROMPT_STATIC[name] ?? def.staticText;
  const dynamic = (PROMPT_DYNAMIC[name] ?? def.dynamic)(root, goalId);
  const contract = snap?.contract ?? VERDICT_CONTRACT;
  const lines = [
    ...fixed,
    "",
    ...dynamic,
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
  lines.push(contract);
  return lines.join("\n");
}

export interface ParsedVerdict {
  level: VerdictLevel;
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
  const withSeverity = severity ? { severity } : {};
  if (level === "clean") return { ok: true, verdict: { level, summary, ...withSeverity } };
  const target = obj["target"];
  if (target !== "implementing" && target !== "design" && target !== "requirements") {
    return { ok: false, reason: `drift なのに target が不正: ${String(target)}` };
  }
  return { ok: true, verdict: { level, target, summary, ...withSeverity } };
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
