/**
 * decision — decision-model 共通基盤（入口route・compact等の利用元が共有）。
 *
 * chat LLMではなくテキストを生成しないため opencode modelとしては配線できず、
 * plugin tool から直接HTTPSで叩く。プロバイダは2つ（同じ System One 形式）:
 *  - d1: POST https://api.liquid.ai/decisions/v1/systemone（LIQUID_API_KEY 必須）
 *  - jev: POST https://opencode.ai/inference/systemone/v1/systemone
 *         （既定 jev-1.13-free。APIキー無しでも叩ける。有料 jev-1.13 は OPENCODE_API_KEY がある時だけ）
 *
 * 構成: callDecision（HTTP・認証・timeout・例外握りの唯一の窓口）の上に
 * 用途別の関数（decideRoute）を載せる。新しい利用場所を足す時は
 * callDecisionを再利用し、HTTP部分をコピーしないこと。
 *
 * プロバイダ切替は入口判定（decideRoute）だけに適用する。compact は d1 固定
 * （既定が無言で変わるのを避ける）。
 * 入口判定は primary とは別プロバイダへ shadow 呼び出しを投げ、較正ログに並べて残す
 * （shadow は route 判定・state に一切影響しない）。
 *
 * 失敗は呼び出し側が極性を決める（routeはfull）。
 * 本モジュールはstateを書かない。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as state from "./state";

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
/** routeのconfidenceがこれ未満ならgoalに倒す（初期値。scoreboardで調整） */
export const DECISION_CONFIDENCE_FLOOR = 0.6;
export const DECISION_TIMEOUT_MS = 15_000;
/** 一過性の失敗（timeout/429/5xx/ネットワーク）のリトライ回数（テストが参照する） */
export const DECISION_RETRIES = 2;

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
  kind:
    | "decide"
    | "decide-skip"
    | "difficulty"
    | "select"
    | "compact"
    | "compact-skip"
    | "outcome"
    | "shadow"
    /** goal の見張り（ループ・停滞・過剰設計。記録のみ。design g-mwu3tz06） */
    | "watch"
    /** 入口判定の一言をモデルに届けた記録。decision_id で decide 行を参照する（g-mwujrhv6） */
    | "nudge";
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
  /** 判定結果を会話に出したか（false＝裏で記録しただけ。既定 true） */
  delivered?: boolean;
  difficultyConfidence?: number | null;
  /** decide行: d1が選んだ生のchoice（fail-safe適用前。較正用）。
   * route は confidence 下限で goal に寄せられうるので、判定の意図は raw を見る */
  rawChoice?: string | null;
  /** 判定を行ったセッション（hook経由の自動判定で発生。null=不明） */
  sessionID?: string | null;
  /** kind="watch" の対象 goal（後から実際の停止と突き合わせる） */
  goal?: string;
  /** kind="difficulty" の出所（"goal-start" / "implementing"。較正用） */
  source?: string;
  /** 判定に対応するユーザーメッセージのID（hook経由。null=不明）。
   * 同じターンの decide 行をまとめる手がかりになる */
  messageID?: string | null;
  /** kind=outcome: goal終了時の実績 */
  outcome?: {
    goal_id: string;
    fail_streak: number;
    escalated: boolean;
    verifier: string | null;
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

/** decide/select 結果を 1 行の要約にする（tool 応答と注入文の共通文面） */
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

/** decide結果から次に採る行動の指示文 */
export function formatDecisionNextStep(r: DecideResult): string {
  if (r.route === "direct") return "次: loopなしで直接対応せよ。goalは作らない。";
  return "次: graphhopper_goal(action: 'start', title: ...) でループを開始する。";
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
 * 入口routeは使わない（goal開始時の一度きりで待たせたくない。失敗してもgoalに倒れるだけ） */
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

/** 入口の判定は 2 択（goal＝ループを回す / direct＝直接対応） */
export type EntryRoute = "goal" | "direct";

/** 旧 5 値・旧 A/B/C は direct 以外すべて goal に寄せる（読み取り時の変換） */
export function normalizeRoute(v: unknown): EntryRoute | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "direct" || t === "c") return "direct";
  if (["goal", "full", "light", "advised", "oracle", "a", "b"].includes(t)) return "goal";
  return null;
}

export const DECISION_ROUTE_CRITERIA: Record<EntryRoute, string> = {
  goal: "ループを回す。複数ファイルにまたがる変更・設計判断を含む実装・規模不明・曖昧な依頼",
  direct: "直行。単一ファイルの小修正・質問への回答・一回きりのコマンド実行",
};

export type DecideResult = {
  /** decisions.jsonl の decide 行の id（root 未指定なら null）。nudge 行が参照する */
  id: string | null;
  route: EntryRoute;
  /** d1が選んだ生のchoice文字列（fail-safe適用前）。不正応答ならnull */
  rawChoice: string | null;
  /** rawChoiceを正規化したroute（fail-safe適用前）。不正choiceならnull。
   * route は confidence 下限で goal に寄せられるので「d1の意図」を見るのはこちら */
  rawRoute: EntryRoute | null;
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

/* 難易度は route と別の下限を使う（design g-mwjsd3om 判断5）。
 * easy は advisor 省略に直結するので高く、normal は「メインが決める」側なので低く、
 * hard は cascade の昇格に効くので実在の大型作業だけが通る高さにする。 */
export const DIFFICULTY_CONFIDENCE_FLOOR: Record<Difficulty, number> = {
  easy: 0.9,
  normal: 0.4,
  hard: 0.6,
};

/* 難易度3択のcriteria。routeとは独立に「変更の形」を見る（失敗コストより判別が良い。§2 実測）。
 * 「迷ったらnormal」は書かない（normal に寄ると hard が出なくなる）。 */
export const DECISION_DIFFICULTY_CRITERIA: Record<Difficulty, string> = {
  easy: "小さい変更。1〜2ファイルの文言・コメント・設定値の修正や、既存パターンをそのまま踏襲する追加。設計判断がない",
  normal: "通常の機能追加・修正。数ファイルに触れ、テストを書く。設計判断はあるが既存の仕組みの中に収まる",
  hard: "大きい変更。新しい仕組みの設計、既存の仕組みの置き換え・削除・移行、複数のサブシステムにまたがる変更、hook・状態遷移・並行実行・課金など失敗が見えにくい箇所の変更",
};

/** 難易度の質問文（route とは別呼び出しで聞く） */
export const DECISION_DIFFICULTY_INSTRUCTIONS = "この作業自体の難易度を1つ選べ";

/** d1 difficulty の choice を写像する（純関数）。不正・下限未満は null（昇格しない） */
export function mapDifficultyAnswer(
  choice: unknown,
  confidence: unknown,
  floors: Record<Difficulty, number> = DIFFICULTY_CONFIDENCE_FLOOR,
): { difficulty: Difficulty | null; confidence: number | null; reason: string } {
  const conf = typeof confidence === "number" ? confidence : null;
  if (choice !== "easy" && choice !== "normal" && choice !== "hard") {
    return { difficulty: null, confidence: conf, reason: "d1不正difficulty→未判定" };
  }
  const floor = floors[choice];
  if (conf !== null && conf < floor) {
    return {
      difficulty: null,
      confidence: conf,
      reason: `d1低confidence(${conf}<${floor})→未判定`,
    };
  }
  return { difficulty: choice, confidence: conf, reason: `d1判定(${choice})` };
}

/** 難易度だけを d1 に聞く結果 */
export type DifficultyResult = {
  difficulty: Difficulty | null;
  confidence: number | null;
  reason: string;
  /** 呼び出し自体が失敗した（判定不能） */
  fallback: boolean;
  model: string | null;
};

/**
 * 難易度だけを判定する（design g-mwjsd3om 判断4）。route とは別の呼び出しにするのは、
 * 入力が違う（題・決定記録の「決めたこと」）ため。opts.root があれば decisions.jsonl に
 * kind="difficulty" で残す（route の decide 行を汚さない）。
 */
export async function decideDifficulty(
  request: string,
  fetchFn: FetchFn = fetch,
  opts?: {
    root?: string;
    sessionID?: string | null;
    timeoutMs?: number;
    floors?: Record<Difficulty, number>;
    /** 呼び出しの出所（較正用。例 "goal-start" / "implementing"） */
    source?: string;
  },
): Promise<DifficultyResult> {
  const question: DecisionQuestion = {
    type: "choice",
    instructions: DECISION_DIFFICULTY_INSTRUCTIONS,
    criteria: DECISION_DIFFICULTY_CRITERIA,
  };
  const timeoutMs = opts?.timeoutMs ?? DECISION_TIMEOUT_MS;
  const primary = primaryProviderName();
  const t0 = performance.now();
  const r = await callDecision(request, { difficulty: question }, fetchFn, timeoutMs, PROVIDERS[primary]);
  if (!r.ok) {
    if (opts?.root) {
      await logDecision(opts.root, {
        kind: "difficulty",
        provider: primary,
        model: null,
        request,
        result: "error",
        confidence: null,
        latencyMs: Math.round(performance.now() - t0),
        fallback: true,
        reason: r.reason,
        difficulty: null,
        difficultyConfidence: null,
        sessionID: opts.sessionID ?? null,
        source: opts.source,
      });
    }
    return { difficulty: null, confidence: null, reason: r.reason, fallback: true, model: null };
  }
  const mapped = mapDifficultyAnswer(
    r.answers.difficulty?.choice,
    r.answers.difficulty?.confidence,
    opts?.floors ?? DIFFICULTY_CONFIDENCE_FLOOR,
  );
  if (opts?.root) {
    await logDecision(opts.root, {
      kind: "difficulty",
      provider: primary,
      model: r.model,
      request,
      result: mapped.difficulty ?? "unknown",
      confidence: mapped.confidence,
      latencyMs: Math.round(performance.now() - t0),
      fallback: false,
      reason: mapped.reason,
      difficulty: mapped.difficulty,
      difficultyConfidence: mapped.confidence,
      rawChoice: typeof r.answers.difficulty?.choice === "string" ? r.answers.difficulty.choice : null,
      sessionID: opts.sessionID ?? null,
      source: opts.source,
    });
  }
  return {
    difficulty: mapped.difficulty,
    confidence: mapped.confidence,
    reason: mapped.reason,
    fallback: false,
    model: r.model,
  };
}

/* d1応答のchoice＋confidence→route写像（純粋関数。単体テスト対象）。
 * 不正choice・低confidenceはgoal（旧5値はdirect以外をgoalに寄せて受理） */
export function mapDecisionAnswer(
  choice: unknown,
  confidence: unknown,
): DecideResult {
  const rawChoice = typeof choice === "string" ? choice : null;
  const route = rawChoice ? normalizeRoute(rawChoice) : null;
  if (!route) {
    return { id: null, route: "goal", rawChoice, rawRoute: null, confidence: null, reason: "d1不正choice→goal", fallback: false, difficulty: null, difficultyConfidence: null };
  }
  const conf = typeof confidence === "number" ? confidence : null;
  if (conf !== null && conf < DECISION_CONFIDENCE_FLOOR) {
    return {
      id: null,
      route: "goal",
      rawChoice,
      rawRoute: route,
      confidence: conf,
      reason: `d1低confidence(${conf})→goal`,
      fallback: false,
      difficulty: null,
      difficultyConfidence: null,
    };
  }
  return { id: null, route, rawChoice, rawRoute: route, confidence: conf, reason: `d1判定(${route})`, fallback: false, difficulty: null, difficultyConfidence: null };
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
        difficulty: null,
        difficultyConfidence: null,
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

/* 入口routeを判定モデルで判定する。失敗は一律goal（fail-safe極性＝重い側）。
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
    /** false のときは案内を出さない（裏で記録するだけ）。既定 true */
    delivered?: boolean;
  },
): Promise<DecideResult> {
  const t0 = performance.now();
  const primary = primaryProviderName();
  const shadowName = shadowProviderName(primary);
  const decisionId = opts?.root ? randomUUID().slice(0, 8) : null;
  const timeoutMs = opts?.timeoutMs ?? DECISION_TIMEOUT_MS;
  const questions: Record<string, DecisionQuestion> = {
    /* 難易度は decideDifficulty で別に聞く（design g-mwjsd3om 判断4）。
     * 入力が違う（発話ではなく goal の題・決定記録の「決めたこと」）ため同居させない。 */
    route: {
      type: "choice",
      instructions:
        "この作業内容に適したgraphhopperの入口routeを1つ選べ。迷ったらgoal",
      criteria: DECISION_ROUTE_CRITERIA,
    },
  };
  const finish = async (
    d: DecideResult,
    failed = false,
    model: string | null = null,
  ): Promise<DecideResult> => {
    const root = opts?.root;
    const id = decisionId;
    d.id = id;
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
        delivered: opts?.delivered !== false,
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
        id: decisionId,
        route: "goal",
        rawChoice: null,
        rawRoute: null,
        confidence: null,
        reason: `${r.reason}→goal`,
        fallback: true,
        difficulty: null,
        difficultyConfidence: null,
      },
      true,
    );
  }
  const base = mapDecisionAnswer(r.answers.route?.choice, r.answers.route?.confidence);
  return finish(
    {
      ...base,
      id: decisionId,
      difficulty: null,
      difficultyConfidence: null,
      reason: base.reason,
    },
    false,
    r.model,
  );
}
