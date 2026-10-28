/**
 * decision — decision-model 共通基盤（入口route・selector等の利用元が共有）。
 *
 * chat LLMではなくテキストを生成しないため opencode modelとしては配線できず、
 * plugin/MCP toolから直接HTTPSで叩く。プロバイダは2つ（同じ System One 形式）:
 *  - d1: POST https://api.liquid.ai/decisions/v1/systemone（LIQUID_API_KEY 必須）
 *  - jev: POST https://opencode.ai/inference/systemone/v1/systemone
 *         （既定 jev-1.13-free。APIキー無しでも叩ける。有料 jev-1.13 は OPENCODE_API_KEY がある時だけ）
 *
 * 構成: callDecision（HTTP・認証・timeout・例外握りの唯一の窓口）の上に
 * 用途別の関数（decideRoute／selectLenses）を載せる。新しい利用場所を足す時は
 * callDecisionを再利用し、HTTP部分をコピーしないこと。
 *
 * プロバイダ切替は入口判定（decideRoute）だけに適用する。selector/compact/recovery/
 * workflow は d1 固定（既定が無言で変わるのを避ける）。
 * 入口判定は primary とは別プロバイダへ shadow 呼び出しを投げ、較正ログに並べて残す
 * （shadow は route 判定・state に一切影響しない）。
 *
 * 失敗は呼び出し側が極性を決める（routeはfull、selectorはfallback=true）。
 * 本モジュールはstateを書かない。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as state from "./state";
import { RECOVERY_KINDS } from "./workflow";

export const DECISION_API_URL =
  "https://api.liquid.ai/decisions/v1/systemone";
export const DECISION_MODEL = "d1";
/** jev は d1 と同じ System One 形式。質問定義・応答の読み方は共通 */
export const JEV_API_URL =
  "https://opencode.ai/inference/systemone/v1/systemone";
/** 期間限定の無料枠。APIキー不要（2026-10 実測） */
export const JEV_DEFAULT_MODEL = "jev-1.13-free";
/** free枠が課金・権限系で落ちた時だけ試す有料モデル（OPENCODE_API_KEY が必要） */
export const JEV_PAID_MODEL = "jev-1.13";
/** 次のモデルへ落としてよいHTTP status（課金・権限・未知モデル・レート制限のみ）。
 * 400/422（リクエスト不正）で有料を叩かない＝無駄な課金を避ける */
const FALLBACK_STATUSES = new Set([402, 403, 404, 429]);
/** routeのconfidenceがこれ未満ならfullに倒す（初期値。scoreboardで調整） */
export const DECISION_CONFIDENCE_FLOOR = 0.6;
/** 回復手選択専用のconfidence下限。d1の「次の手」判断は routing より本質的に曖昧で、
 * 0.6では全部abortに落ちる（実測: 0.02〜0.52）。0.3は「ほぼ自信がない」場合だけを弾く */
export const RECOVERY_CONFIDENCE_FLOOR = 0.3;
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

export type FetchFn = typeof fetch;

/* ───────── プロバイダ定義 ───────── */

export type DecisionProviderName = "d1" | "jev";

export type DecisionProvider = {
  name: DecisionProviderName;
  url: string;
  /** 順に試すモデル（先頭が既定。2つ目以降は FALLBACK_STATUSES の時だけ） */
  models: () => string[];
  /** ヘッダに載せるキー（無ければヘッダ無し） */
  apiKey: () => string | undefined;
};

function jevModels(): string[] {
  const first = process.env.GRAPHHOPPER_JEV_MODEL?.trim() || JEV_DEFAULT_MODEL;
  return first === JEV_PAID_MODEL ? [first] : [first, JEV_PAID_MODEL];
}

export const PROVIDERS: Record<DecisionProviderName, DecisionProvider> = {
  d1: {
    name: "d1",
    url: DECISION_API_URL,
    models: () => [DECISION_MODEL],
    apiKey: () => process.env.LIQUID_API_KEY,
  },
  jev: {
    name: "jev",
    url: JEV_API_URL,
    models: jevModels,
    /* 無料枠はキー不要。有料フォールバックと課金上限のゲートを兼ねる */
    apiKey: () => process.env.OPENCODE_API_KEY,
  },
};

/** 入口判定の primary（既定 d1。大小不問、不正値は d1） */
export function primaryProviderName(): DecisionProviderName {
  return process.env.GRAPHHOPPER_DECISION_PROVIDER?.trim().toLowerCase() === "jev"
    ? "jev"
    : "d1";
}

/** primary と別のプロバイダへ shadow を投げるか。
 * 既定: primary=d1 なら jev、primary=jev なら off。
 * GRAPHHOPPER_DECISION_SHADOW=off で明示的に止められる（外部送信を止めたい時） */
export function shadowProviderName(
  primary: DecisionProviderName,
): DecisionProviderName | null {
  const v = process.env.GRAPHHOPPER_DECISION_SHADOW?.trim().toLowerCase();
  if (v === "off") return null;
  /* 未指定の既定: d1 で判定しつつ jev を並走。primary が jev なら並走しない */
  const name: DecisionProviderName | null =
    v === "jev" || v === "d1" ? v : primary === "d1" ? "jev" : null;
  return name === primary ? null : name;
}

/** 入口判定を実行できるか（primary がキー必須ならキー有無）。
 * jev は無料枠がキー不要なので常に true */
export function decisionAvailable(
  name: DecisionProviderName = primaryProviderName(),
): boolean {
  return name === "jev" || !!process.env.LIQUID_API_KEY?.trim();
}

/* 1問分の定義（d1/jev 共通。公式doc: type=noul|choice|score） */
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
  kind: "decide" | "decide-skip" | "select" | "compact" | "compact-skip" | "outcome" | "shadow";
  /** 判定を行ったプロバイダ／実際に答えたモデル（shadow 行は shadow 側） */
  provider?: DecisionProviderName;
  model?: string | null;
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
  /** decide行: d1が選んだ生のchoice（fail-safe適用前。較正用）。
   * route は confidence 下限で full に潰されうるので、判定の意図は raw 才知道る */
  rawChoice?: string | null;
  /** 判定を行ったセッション（hook経由の自動判定で発生。null=不明） */
  sessionID?: string | null;
  /** 判定に対応するユーザーメッセージのID（hook経由。null=不明）。
   * 同じターンの decide 行をまとめる手がかりになる */
  messageID?: string | null;
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

/** 較正ログの request は先頭200字だけ残す（単一源泉。呼び出し側で切らない） */
export const DECISION_REQUEST_MAX = 200;

export async function logDecision(
  root: string,
  entry: Omit<DecisionLog, "ts">,
): Promise<void> {
  try {
    const dir = join(root, ".graphhopper");
    mkdirSync(dir, { recursive: true });
    /* request は先頭200字だけ残す（単一源泉。呼び出し側で切らない） */
    const row = { ...entry, request: entry.request.slice(0, DECISION_REQUEST_MAX) };
    appendFileSync(
      join(dir, "decisions.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n",
    );
  } catch {
    /* 較正ログの書込失敗で本体を止めない */
  }
}

/** decide/select 結果を 1 行の要約にする（plugin tool・MCP tool・注入文の共通文面） */
export function formatDecisionSummary(r: DecideResult): string[] {
  const conf = r.confidence === null ? "n/a" : r.confidence.toFixed(2);
  const diff = r.difficulty ?? "unknown";
  const diffConf = r.difficultyConfidence !== null ? `（confidence=${r.difficultyConfidence}）` : "";
  const rawNote = r.rawRoute ? `（d1の生の選択=${r.rawRoute}）` : "";
  return [
    `route=${r.route}（confidence=${conf}。${r.reason}）${rawNote}`,
    `difficulty=${diff}${diffConf}`,
  ];
}

/** decide結果から次に採る行動の指示文（route_set 引数つき） */
export function formatDecisionNextStep(r: DecideResult): string {
  if (r.route === "direct") {
    return "次: loopなしで直接対応せよ。goalは作らない（必要なら graphhopper_route_set(route: 'direct') でhistoryに残す）。";
  }
  const diffArg = r.difficulty
    ? `, difficulty: '${r.difficulty}'`
    : "（difficulty は unknown なので省略。easy/normal/hard 以外は渡せない）";
  return `次: graphhopper_route_set(route, reason${diffArg}) で記録する。full/light/advised/oracleなら graphhopper_goal(start)（pending routeが消費される）。`;
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
  | {
      ok: true;
      answers: DecisionAnswers;
      /** 実際に答えたプロバイダ／モデル（較正ログ用） */
      provider: DecisionProviderName;
      model: string;
    }
  /** retryable=true: 再試行で直りうる一過性の失敗（timeout/429/5xx/ネットワーク） */
  | { ok: false; reason: string; retryable: boolean };

/* 1モデル分の呼び出し。status はフォールバック可否の判定にだけ使う */
async function callOnce(
  provider: DecisionProvider,
  model: string,
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<{ r: CallResult; status?: number }> {
  const key = provider.apiKey()?.trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(provider.url, {
      method: "POST",
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        state: stateText,
        questions,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        r: {
          ok: false,
          reason: `${provider.name} HTTP ${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        },
        status: res.status,
      };
    }
    const body = (await res.json()) as { answers?: DecisionAnswers };
    if (!body.answers || typeof body.answers !== "object") {
      return { r: { ok: false, reason: `${provider.name}応答にanswersなし`, retryable: false } };
    }
    return { r: { ok: true, answers: body.answers, provider: provider.name, model } };
  } catch (e) {
    return {
      r: {
        ok: false,
        reason: `${provider.name}呼出失敗(${e instanceof Error ? e.message : String(e)})`,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/* 判定モデルを叩く唯一の窓口。key未設定・HTTP失敗・例外・不正JSONは ok:false（リトライなし）。
 * 極性（fullに倒すかfallbackにするか）は呼び出し側が決める。
 * provider 既定は d1（切替は入口判定だけが明示で渡す）。
 * timeoutMs は全モデル合計の予算（無料枠→有料のフォールバックで待ち時間を倍にしない） */
export async function callDecision(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
  provider: DecisionProvider = PROVIDERS.d1,
): Promise<CallResult> {
  const key = provider.apiKey()?.trim();
  if (provider.name === "d1" && !key) {
    return { ok: false, reason: "LIQUID_API_KEY未設定", retryable: false };
  }
  const models = provider.models();
  const deadline = Date.now() + timeoutMs;
  let last: CallResult = { ok: false, reason: `${provider.name}未実行`, retryable: false };
  for (let i = 0; i < models.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      last = { ok: false, reason: `${provider.name} timeout(${timeoutMs}ms)`, retryable: true };
      break;
    }
    const { r, status } = await callOnce(
      provider,
      models[i],
      stateText,
      questions,
      fetchFn,
      remaining,
    );
    if (r.ok) return r;
    last = r;
    /* 次のモデルは「課金・権限系で落ちた」かつキーがある時だけ（無駄な課金と待ちを避ける） */
    const canNext =
      i < models.length - 1 &&
      status !== undefined &&
      FALLBACK_STATUSES.has(status) &&
      (provider.name !== "jev" || !!key);
    if (!canNext) break;
  }
  return last;
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
  /** d1が選んだ生のchoice文字列（fail-safe適用前）。不正応答ならnull */
  rawChoice: string | null;
  /** rawChoiceを正規化したroute（fail-safe適用前）。不正choiceならnull。
   * route は confidence 下限で full に潰されるので「d1の意図」を見るのはこちら */
  rawRoute: state.EntryRoute | null;
  confidence: number | null;
  reason: string;
  /** true＝d1 呼び出しが失敗した（判定不能）。呼び出し側は極性を決める */
  fallback: boolean;
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
  const rawChoice = typeof choice === "string" ? choice : null;
  const route = rawChoice ? state.normalizeEntryRoute(rawChoice) : null;
  if (!route) {
    return { route: "full", rawChoice, rawRoute: null, confidence: null, reason: "d1不正choice→full", fallback: false, difficulty: null, difficultyConfidence: null };
  }
  const conf = typeof confidence === "number" ? confidence : null;
  if (conf !== null && conf < DECISION_CONFIDENCE_FLOOR) {
    return {
      route: "full",
      rawChoice,
      rawRoute: route,
      confidence: conf,
      reason: `d1低confidence(${conf})→full`,
      fallback: false,
      difficulty: null,
      difficultyConfidence: null,
    };
  }
  return { route, rawChoice, rawRoute: route, confidence: conf, reason: `d1判定(${route})`, fallback: false, difficulty: null, difficultyConfidence: null };
}

/* shadow 呼び出しの in-flight 集合。テストが `await Promise.all(pendingShadows())` で
 * 完了を待つための口（本番では誰も参照しない） */
const inflightShadows = new Set<Promise<void>>();
export function pendingShadows(): Promise<void>[] {
  return [...inflightShadows];
}

/* shadow 判定（primary とは別プロバイダ）。route・state・last_decision_id には一切触らない。
 * 内部で全例外を握るので未捕捉 rejection にならない */
function scheduleShadow(args: {
  root: string;
  decisionId: string;
  request: string;
  questions: Record<string, DecisionQuestion>;
  provider: DecisionProvider;
  fetchFn: FetchFn;
  timeoutMs: number;
}): void {
  const { root, decisionId, request, questions, provider, fetchFn, timeoutMs } = args;
  const run = async (): Promise<void> => {
    const t0 = performance.now();
    try {
      const r = await callDecision(request, questions, fetchFn, timeoutMs, provider);
      if (!r.ok) {
        await logDecision(root, {
          decision_id: decisionId,
          kind: "shadow",
          provider: provider.name,
          model: null,
          request,
          result: "error",
          confidence: null,
          latencyMs: Math.round(performance.now() - t0),
          fallback: true,
          reason: r.reason,
        });
        return;
      }
      const base = mapDecisionAnswer(r.answers.route?.choice, r.answers.route?.confidence);
      const diff = mapDifficultyAnswer(
        r.answers.difficulty?.choice,
        r.answers.difficulty?.confidence,
      );
      await logDecision(root, {
        decision_id: decisionId,
        kind: "shadow",
        provider: provider.name,
        model: r.model,
        request,
        result: base.rawChoice ?? "invalid",
        confidence: base.confidence,
        latencyMs: Math.round(performance.now() - t0),
        fallback: false,
        reason: base.reason,
        difficulty: diff.difficulty,
        difficultyConfidence: diff.confidence,
        rawChoice: base.rawChoice,
      });
    } catch (e) {
      await logDecision(root, {
        decision_id: decisionId,
        kind: "shadow",
        provider: provider.name,
        model: null,
        request,
        result: "error",
        confidence: null,
        latencyMs: Math.round(performance.now() - t0),
        fallback: true,
        reason: `shadow失敗(${e instanceof Error ? e.message : String(e)})`,
      });
    }
  };
  const p = run().catch(() => {});
  inflightShadows.add(p);
  void p.finally(() => inflightShadows.delete(p));
}

/* 入口routeを判定モデルで判定する。失敗は一律full（現行fail-safe極性＝重い側）。
 * opts.root があれば較正ログに追記する（無ければ記録しない。テストは無指定）
 * opts.sessionID を渡すと較正ログにセッションを残せる（hook経由の自動判定用）
 * opts.timeoutMs で timeout を上書きできる（hook経路は短い待ち時間に切る）
 * primary は GRAPHHOPPER_DECISION_PROVIDER（既定 d1）。別プロバイダの shadow は
 * opts.root がある時だけ走り、判定結果には影響しない */
export async function decideRoute(
  request: string,
  fetchFn: FetchFn = fetch,
  opts?: {
    root?: string;
    sessionID?: string | null;
    messageID?: string | null;
    timeoutMs?: number;
  },
): Promise<DecideResult> {
  const t0 = performance.now();
  const primary = primaryProviderName();
  const shadowName = shadowProviderName(primary);
  const decisionId = opts?.root ? randomUUID().slice(0, 8) : null;
  const timeoutMs = opts?.timeoutMs ?? DECISION_TIMEOUT_MS;
  const questions: Record<string, DecisionQuestion> = {
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
  };
  const finish = async (
    d: DecideResult,
    failed = false,
    model: string | null = null,
  ): Promise<DecideResult> => {
    const root = opts?.root;
    const id = decisionId;
    if (root && id) {
      /* 失敗した判定は last decision id を更新しない。更新すると
       * 次の goal が偽の decide に紐付き、較正データを汚染する。
         （行には id を残す。calibrate は outcome 側から引くため一致しない） */
      if (!failed) state.writeLastDecisionId(root, id);
      await logDecision(root, {
        id,
        kind: "decide",
        provider: primary,
        model,
        request,
        result: d.route,
        confidence: d.confidence,
        latencyMs: Math.round(performance.now() - t0),
        fallback: failed,
        reason: d.reason,
        difficulty: d.difficulty,
        difficultyConfidence: d.difficultyConfidence,
        rawChoice: d.rawChoice,
        sessionID: opts?.sessionID ?? null,
        messageID: opts?.messageID ?? null,
      });
      /* primary が落ちた回も shadow は走らせる（比較の母数を減らさない） */
      if (shadowName) {
        scheduleShadow({
          root,
          decisionId: id,
          request,
          questions,
          provider: PROVIDERS[shadowName],
          fetchFn,
          timeoutMs,
        });
      }
    }
    return d;
  };
  const r = await callDecision(
    request,
    questions,
    fetchFn,
    timeoutMs,
    PROVIDERS[primary],
  );
  if (!r.ok) {
    return finish(
      {
        route: "full",
        rawChoice: null,
        rawRoute: null,
        confidence: null,
        reason: `${r.reason}→full`,
        fallback: true,
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
  return finish(
    {
      ...base,
      difficulty: diff.difficulty,
      difficultyConfidence: diff.confidence,
      reason: `${base.reason} / ${diff.reason}`,
    },
    false,
    r.model,
  );
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
  oracle: "原因が不明・設計判断の誤りが疑われる。お手上げモデルに助言を求めてから再実行する",
  escalate_tier: "指示は妥当で、モデルの力不足が疑われる。信頼モデルで同じノードを再実行する",
  second_opinion: "同じ手順では同じ結果が出そう。別角度のモデルで同じノードを再実行する",
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
  let raw = "";
  if (r.ok) {
    const a = r.answers.recovery;
    confidence = typeof a?.confidence === "number" ? a.confidence : null;
    if (typeof a?.choice === "string" && (RECOVERY_KINDS as readonly string[]).includes(a.choice)) {
      raw = a.choice;
      if (confidence !== null && confidence < RECOVERY_CONFIDENCE_FLOOR) reason = `低confidence(${confidence})→abort`;
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
      reason: raw && raw !== choice ? `${reason || ""} d1の選択=${raw}` : reason,
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
