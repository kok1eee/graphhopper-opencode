/**
 * decision — d1 decision-model 共通基盤（入口route・selector等の利用元が共有）。
 *
 * Liquid decisions API専用。d1はchat LLMではなくテキストを生成しないため
 * opencode modelとしては配線できない。plugin/MCP toolから直接HTTPSで叩く。
 * POST https://api.liquid.ai/decisions/v1/systemone（model d1）。
 *
 * 構成: callDecision（HTTP・認証・timeout・例外握りの唯一の窓口）の上に
 * 用途別の関数（decideRoute／selectLenses）を載せる。新しい利用場所を足す時は
 * callDecisionを再利用し、HTTP部分をコピーしないこと。
 *
 * 失敗は呼び出し側が極性を決める（routeはfull、selectorはfallback=true）。
 * 本モジュールはstateを書かない。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as state from "./state";

export const DECISION_API_URL =
  "https://api.liquid.ai/decisions/v1/systemone";
export const DECISION_MODEL = "d1";
/** routeのconfidenceがこれ未満ならfullに倒す（初期値。scoreboardで調整） */
export const DECISION_CONFIDENCE_FLOOR = 0.6;
export const DECISION_TIMEOUT_MS = 15_000;
/** selectorはadvisory-onlyで取りこぼしの害が小さい。decision APIはレイテンシがぶれる
 * （無料枠 d1:free の実測で3〜15s超）ため、遅い時は短く切ってfallbackに倒す（待たせない）。
 * 現在は d1（有料・入力トークン課金のみ）を使うが、timeoutは無料枠時代の保守的な値を維持する */
export const SELECTOR_TIMEOUT_MS = 5_000;
/** selectorのみ、一過性の失敗（timeout/429/5xx/ネットワーク）を最大2回リトライする。
 * 無料枠 d1:free はコールドスタートで初回が15s級に遅れ、温まると0.3s台になるため、
 * 打ち切った初回がサーバーを起こし、2回目以降で拾える。最悪 5s×3=15s
 * （現在の d1 でも同じリトライ方針を維持する） */
export const SELECTOR_RETRIES = 2;
/** selectorのNoul採用閾値（0.5＝公式docの「最大不確実」中点。初期値） */
export const SELECTOR_NOUL_THRESHOLD = 0.5;

type FetchFn = typeof fetch;

/* d1の1問分の定義（公式doc: type=noul|choice|score） */
export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };

export type DecisionAnswers = Record<
  string,
  { noul?: unknown; choice?: unknown; confidence?: unknown }
>;

/* d1呼び出しの較正用ログ。`.graphhopper/decisions.jsonl` へ1call1行で追記する。
 * 使われなければ較正できないため、decide/selectの利用実績を残すのが目的。
 * requestは先頭200字のみ（較正には概要で足りる）。書込失敗は握り潰す */
export type DecisionLog = {
  ts: string;
  /** decide行のid。outcome行は decision_id で参照する */
  id?: string;
  decision_id?: string | null;
  kind: "decide" | "select" | "compact" | "compact-skip" | "outcome";
  request: string;
  result: string | string[];
  confidence: number | null;
  probs?: Record<string, number>;
  latencyMs: number;
  fallback: boolean;
  reason: string;
  /** decide時のd1難易度（較正用） */
  difficulty?: string | null;
  difficultyConfidence?: number | null;
  /** kind=outcome: goal終了時の実績 */
  outcome?: {
    goal_id: string;
    fail_streak: number;
    escalated: boolean;
    verifier: string | null;
    /** workflow runner を使った場合のテンプレ名と挿入ノード列 */
    workflow?: string;
    inserted?: string[];
  };
};

export async function logDecision(
  root: string,
  entry: Omit<DecisionLog, "ts">,
): Promise<void> {
  try {
    const dir = join(root, ".graphhopper");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "decisions.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    /* 較正ログの書込失敗で本体を止めない */
  }
}

/* d1応答からNoul確率を抜く（compact側と共有。応答形変更時の修正点集約） */
export function extractNoulProbs(
  answers: DecisionAnswers,
  keys: readonly string[],
): Record<string, number> {
  const probs: Record<string, number> = {};
  for (const k of keys) {
    const v = answers[k]?.noul;
    if (typeof v === "number") probs[k] = v;
  }
  return probs;
}

export type CallResult =
  | { ok: true; answers: DecisionAnswers }
  /** retryable=true: 再試行で直りうる一過性の失敗（timeout/429/5xx/ネットワーク） */
  | { ok: false; reason: string; retryable: boolean };

/* d1を叩く唯一の窓口。key未設定・HTTP失敗・例外・不正JSONは ok:false（リトライなし）。
 * 極性（fullに倒すかfallbackにするか）は呼び出し側が決める */
export async function callDecision(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
): Promise<CallResult> {
  const key = process.env.LIQUID_API_KEY?.trim();
  if (!key) return { ok: false, reason: "LIQUID_API_KEY未設定", retryable: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(DECISION_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DECISION_MODEL,
        state: stateText,
        questions,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `d1 HTTP ${res.status}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    }
    const body = (await res.json()) as { answers?: DecisionAnswers };
    if (!body.answers || typeof body.answers !== "object") {
      return { ok: false, reason: "d1応答にanswersなし", retryable: false };
    }
    return { ok: true, answers: body.answers };
  } catch (e) {
    return {
      ok: false,
      reason: `d1呼出失敗(${e instanceof Error ? e.message : String(e)})`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* callDecision＋一過性失敗のみ最大retries回リトライ。key未設定・4xx・不正応答は即返す。
 * 入口routeは使わない（goal開始時の一度きりで待たせたくない。失敗してもfullに倒れるだけ） */
export async function callDecisionWithRetry(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
  retries: number = 0,
): Promise<CallResult> {
  let last: CallResult = { ok: false, reason: "未実行", retryable: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callDecision(stateText, questions, fetchFn, timeoutMs);
    if (last.ok || !last.retryable) return last;
  }
  return last.ok
    ? last
    : { ...last, reason: `${last.reason}（${retries + 1}回試行）` };
}

/* ───────── 入口route ───────── */

/* 5択criteria。現行判定基準の移植（ラベルのみ送付は不可）。
 * fullは「以下に当てはまらない全て」のため該当文で定義する */
export const DECISION_ROUTE_CRITERIA: Record<state.EntryRoute, string> = {
  full: "フルループ。設計判断を要する・複数関心にまたがる・規模不明・曖昧・以下のいずれにも当てはまらない全ての作業",
  light:
    "軽量。全て満たす時のみ → (1)単一関心 (2)設計判断なし (3)既存パターンの踏襲 (4)テスト容易。1つでも欠けたらfull",
  advised:
    "軽量＋第二意見。light条件を満たす＋影響範囲の読みに迷いがある／第二意見が欲しい軽微変更",
  oracle:
    "多角。full相当＋最初から多角的視点が必要（アーキテクチャ判断・複雑デバッグ・不慣れなパターン）",
  direct: "直行。単一ファイルの小修正・質問への回答・一回きりのコマンド実行",
};

export type DecideResult = {
  route: state.EntryRoute;
  confidence: number | null;
  reason: string;
  /** 難易度（d1判定）。null＝未判定・低confidence・失敗。nullは昇格しない */
  difficulty: Difficulty | null;
  /** difficulty の confidence（較正用） */
  difficultyConfidence: number | null;
};

export type { Difficulty } from "./state";
type Difficulty = state.Difficulty;

/* 難易度3択のcriteria。routeとは独立に「失敗コスト」を見る */
export const DECISION_DIFFICULTY_CRITERIA: Record<Difficulty, string> = {
  easy: "単純。既存パターンの踏襲で、設計判断なし・変更範囲が狭い・失敗しても即座に直せる",
  normal: "普通。設計判断が多少ある／複数ファイルに触れる／テストを書く必要がある。easyにもhardにも当てはまらない全て",
  hard: "難しい。設計判断が重い・未知の領域・変更範囲が広い／失敗コストが高い・アーキテクチャや契約に触れる",
};

/** d1 difficulty の choice を写像する（純関数）。不正・低confidenceは null（昇格しない） */
export function mapDifficultyAnswer(
  choice: unknown,
  confidence: unknown,
): { difficulty: Difficulty | null; confidence: number | null; reason: string } {
  const conf = typeof confidence === "number" ? confidence : null;
  if (choice !== "easy" && choice !== "normal" && choice !== "hard") {
    return { difficulty: null, confidence: conf, reason: "d1不正difficulty→未判定" };
  }
  if (conf !== null && conf < DECISION_CONFIDENCE_FLOOR) {
    return { difficulty: null, confidence: conf, reason: `d1低confidence(${conf})→未判定` };
  }
  return { difficulty: choice, confidence: conf, reason: `d1判定(${choice})` };
}

/* d1応答のchoice＋confidence→route写像（純粋関数。単体テスト対象）。
 * 不正choice・5択外・低confidenceはfull */
export function mapDecisionAnswer(
  choice: unknown,
  confidence: unknown,
): DecideResult {
  const route =
    typeof choice === "string" ? state.normalizeEntryRoute(choice) : null;
  if (!route) {
    return { route: "full", confidence: null, reason: "d1不正choice→full", difficulty: null, difficultyConfidence: null };
  }
  const conf = typeof confidence === "number" ? confidence : null;
  if (conf !== null && conf < DECISION_CONFIDENCE_FLOOR) {
    return {
      route: "full",
      confidence: conf,
      reason: `d1低confidence(${conf})→full`,
      difficulty: null,
      difficultyConfidence: null,
    };
  }
  return { route, confidence: conf, reason: `d1判定(${route})`, difficulty: null, difficultyConfidence: null };
}

/* 入口routeをd1で判定する。失敗は一律full（現行fail-safe極性＝重い側）。
 * opts.root があれば較正ログに追記する（無ければ記録しない。テストは無指定） */
export async function decideRoute(
  request: string,
  fetchFn: FetchFn = fetch,
  opts?: { root?: string },
): Promise<DecideResult> {
  const t0 = performance.now();
  const finish = async (
    d: DecideResult,
    failed = false,
  ): Promise<DecideResult> => {
    if (opts?.root) {
      const id = randomUUID().slice(0, 8);
      state.writeLastDecisionId(opts.root, id);
      await logDecision(opts.root, {
        id,
        kind: "decide",
        request: request.slice(0, 200),
        result: d.route,
        confidence: d.confidence,
        latencyMs: Math.round(performance.now() - t0),
        fallback: failed,
        reason: d.reason,
        difficulty: d.difficulty,
        difficultyConfidence: d.difficultyConfidence,
      });
    }
    return d;
  };
  const r = await callDecision(
    request,
    {
      route: {
        type: "choice",
        instructions:
          "この作業内容に適したgraphhopperの入口routeを1つ選べ。迷ったらfull",
        criteria: DECISION_ROUTE_CRITERIA,
      },
      difficulty: {
        type: "choice",
        instructions:
          "この作業自体の難易度を1つ選べ（routeとは独立。迷ったらnormal）",
        criteria: DECISION_DIFFICULTY_CRITERIA,
      },
    },
    fetchFn,
  );
  if (!r.ok) {
    return finish(
      {
        route: "full",
        confidence: null,
        reason: `${r.reason}→full`,
        difficulty: null,
        difficultyConfidence: null,
      },
      true,
    );
  }
  const base = mapDecisionAnswer(r.answers.route?.choice, r.answers.route?.confidence);
  const diff = mapDifficultyAnswer(
    r.answers.difficulty?.choice,
    r.answers.difficulty?.confidence,
  );
  return finish({
    ...base,
    difficulty: diff.difficulty,
    difficultyConfidence: diff.confidence,
    reason: `${base.reason} / ${diff.reason}`,
  });
}

/* ───────── verifier編成selector ───────── */

/* 契約変更系キーワード（日英混在）。design抜粋にマッチしたらrequirementを強制追加する。
 * 誤検出（「互換性テストの追加」等）は許容: requirementは取りこぼし防止側で、
 * 追加しても検証が1 lens増えるだけ。偽陽性より偽陰性の方が害が大きい */
export const SELECTOR_FORCE_REQUIREMENT =
  /契約|migration|互換|breaking|schema|スキーマ/i;

/* selectorがNoulで判定するlensのキー（generalは含めない）。質問定義・組立・欠測判定の単一源泉 */
export const SELECTOR_LENS_KEYS = ["requirement", "behavior", "progress"] as const;
export type SelectorLensKey = (typeof SELECTOR_LENS_KEYS)[number];

/* 3観点のNoul質問。generalは質問にしない（「3観点を統合した単発」で他lensと排他。
 * どれも閾値に届かなければ「該当なし→general」とする） */
export const SELECTOR_QUESTIONS: Record<SelectorLensKey, DecisionQuestion> = {
  requirement: {
    type: "noul",
    instructions:
      "この変更は、設計意図・done定義との一致を重点的に検証する必要があるか。契約・互換性・仕様の変更が絡むなら必要",
  },
  behavior: {
    type: "noul",
    instructions:
      "この変更は、振る舞い・テスト・副作用を重点的に検証する必要があるか。実行時の挙動や状態遷移に影響するなら必要",
  },
  progress: {
    type: "noul",
    instructions:
      "この変更は、進捗・残件・タスク列との対応を重点的に検証する必要があるか。複数タスクにまたがり取りこぼしが起きうるなら必要",
  },
};

export type SelectResult = {
  lenses: state.VerifierLens[];
  reason: string;
  /** true＝判定不能（API失敗等）。呼び出し側は従来routerを継続せよ（generalへ倒さない） */
  fallback: boolean;
  /** 各Noulの確率（較正用。欠測時は空） */
  probs: Partial<Record<SelectorLensKey, number>>;
};

/* Noul確率→lens集合の組立（純粋関数。単体テスト対象）。
 * - 閾値以上のlensを採用（最大3件）
 * - 全て閾値未満＝「該当なし」→ general（fallbackではない）
 * - design抜粋が契約変更系キーワードにマッチ → requirementを強制追加
 * - 有効なNoulが1件も無い（欠測）＝判定不能 → fallback=true（general倒しはしない） */
export function assembleLenses(
  answers: DecisionAnswers,
  designExcerpt: string,
): SelectResult {
  const probs = extractNoulProbs(answers, SELECTOR_LENS_KEYS);
  if (Object.keys(probs).length === 0) {
    return {
      lenses: [],
      reason: "d1応答に有効なNoulなし→従来router",
      fallback: true,
      probs,
    };
  }
  const hit = SELECTOR_LENS_KEYS.filter(
    (k) => (probs[k] ?? 0) >= SELECTOR_NOUL_THRESHOLD,
  );
  const forced =
    SELECTOR_FORCE_REQUIREMENT.test(designExcerpt) && !hit.includes("requirement");
  const picked: SelectorLensKey[] = forced ? ["requirement", ...hit] : hit;
  const lenses: state.VerifierLens[] = picked.length > 0 ? picked : ["general"];
  const fmt = (k: SelectorLensKey) => `${k}=${probs[k]?.toFixed(2) ?? "n/a"}`;
  const reason =
    `d1選択(${SELECTOR_LENS_KEYS.map(fmt).join(",")})` +
    (forced ? " requirement強制(契約変更系キーワード)" : "") +
    (picked.length === 0 ? " 該当なし→general" : "");
  return { lenses, reason, fallback: false, probs };
}

/* selector toolの人用テキスト（plugin/MCP両面の単一源泉。文面ズレ防止） */
export const SELECTOR_TOOL_DESCRIPTION =
  "verifier編成selectorをd1 decision-modelで判定する（advisory-only。現行routerは維持）。design抜粋とdiff統計を渡すとlens（1-3件）を返す。判定不能時はfallback=true（従来routerを継続。general倒しはしない）";

export function formatSelectorResult(r: SelectResult): string {
  return r.fallback
    ? `selector: 判定不能（${r.reason}）。従来router（advisor/polish）を継続せよ（general倒しはしない）。`
    : `selector: lenses=${r.lenses.join(",")}（${r.reason}）。verifier編成の参考にする（advisory-only。採否はmainが決める）。`;
}

/* verifier編成をd1で選ぶ。API失敗・key未設定・全Noul欠測は fallback=true。
 * opts.root があれば較正ログに追記する（無ければ記録しない。テストは無指定） */
export async function selectLenses(
  designExcerpt: string,
  diffStat: string,
  fetchFn: FetchFn = fetch,
  opts?: { root?: string },
): Promise<SelectResult> {
  const t0 = performance.now();
  const stateText = ["design抜粋:", designExcerpt, "", "diff統計:", diffStat].join(
    "\n",
  );
  const finish = async (s: SelectResult): Promise<SelectResult> => {
    if (opts?.root) {
      await logDecision(opts.root, {
        kind: "select",
        request: stateText.slice(0, 200),
        result: s.lenses,
        confidence: null,
        probs: s.probs as Record<string, number>,
        latencyMs: Math.round(performance.now() - t0),
        fallback: s.fallback,
        reason: s.reason,
      });
    }
    return s;
  };
  const r = await callDecisionWithRetry(
    ["design抜粋:", designExcerpt, "", "diff統計:", diffStat].join("\n"),
    SELECTOR_QUESTIONS,
    fetchFn,
    SELECTOR_TIMEOUT_MS,
    SELECTOR_RETRIES,
  );
  if (!r.ok) {
    return finish({
      lenses: [],
      reason: `${r.reason}→従来router`,
      fallback: true,
      probs: {},
    });
  }
  return finish(assembleLenses(r.answers, designExcerpt));
}

/* ───────── workflow 失敗時の回復選択 ───────── */

export const RECOVERY_CRITERIA: Record<string, string> = {
  oracle: "原因が不明・設計判断の誤りが疑われる。上位モデルに助言を求めてから再実行する",
  escalate_tier: "指示は妥当で、モデルの力不足が疑われる。上位モデルで同じノードを再実行する",
  abort: "要件が曖昧・環境の問題・人間の判断が要る。自動で続けず人間に戻す",
};

/* 失敗ノードの回復手をd1で選ぶ。失敗・不正・低confidenceは必ず "abort"。
 * 許可リストの強制（使用済み除外）は呼び出し側 allowRecovery が行う */
export async function chooseRecovery(
  failed: { id: string; reason: string; task: string },
  fetchFn: FetchFn = fetch,
  opts?: { root?: string },
): Promise<string> {
  const t0 = performance.now();
  const r = await callDecision(
    `workflowノード失敗\nタスク: ${failed.task.slice(0, 300)}\nノード: ${failed.id}\n理由: ${failed.reason.slice(0, 300)}`,
    { recovery: { type: "choice", instructions: "失敗への次の手を1つ選べ。迷ったらabort", criteria: RECOVERY_CRITERIA } },
    fetchFn,
  );
  let choice = "abort";
  let reason = r.ok ? "" : r.reason;
  let confidence: number | null = null;
  if (r.ok) {
    const a = r.answers.recovery;
    confidence = typeof a?.confidence === "number" ? a.confidence : null;
    if (typeof a?.choice === "string" && Object.hasOwn(RECOVERY_CRITERIA, a.choice)) {
      if (confidence !== null && confidence < DECISION_CONFIDENCE_FLOOR) reason = `低confidence(${confidence})→abort`;
      else choice = a.choice;
    } else reason = "不正choice→abort";
  }
  if (opts?.root) {
    await logDecision(opts.root, {
      kind: "select",
      request: `recovery:${failed.id} ${failed.reason}`.slice(0, 200),
      result: choice,
      confidence,
      latencyMs: Math.round(performance.now() - t0),
      fallback: !r.ok,
      reason,
    });
  }
  return choice;
}

/* タスクに適用するworkflowテンプレをd1で選ぶ。失敗・不正・低confidenceは "none"（自動起動しない） */
export const WORKFLOW_CRITERIA: Record<string, string> = {
  bugfix: "症状・再現手順のあるバグ修正。再現テスト→修正→検証で進められる",
  none: "新機能・設計・調査・リファクタなどバグ修正ではない、または曖昧",
};

export async function chooseWorkflow(task: string, fetchFn: FetchFn = fetch, opts?: { root?: string }): Promise<string> {
  const t0 = performance.now();
  const r = await callDecision(
    `タスク: ${task.slice(0, 400)}`,
    { workflow: { type: "choice", instructions: "適用するworkflowを1つ選べ。迷ったらnone", criteria: WORKFLOW_CRITERIA } },
    fetchFn,
  );
  let choice = "none";
  let confidence: number | null = null;
  if (r.ok) {
    const a = r.answers.workflow;
    confidence = typeof a?.confidence === "number" ? a.confidence : null;
    if (typeof a?.choice === "string" && Object.hasOwn(WORKFLOW_CRITERIA, a.choice) && (confidence === null || confidence >= DECISION_CONFIDENCE_FLOOR)) choice = a.choice;
  }
  if (opts?.root) {
    await logDecision(opts.root, {
      kind: "select",
      request: `workflow:${task}`.slice(0, 200),
      result: choice,
      confidence,
      latencyMs: Math.round(performance.now() - t0),
      fallback: !r.ok,
      reason: r.ok ? "" : r.reason,
    });
  }
  return choice;
}
