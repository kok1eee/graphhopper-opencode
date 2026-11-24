/**
 * goal-watch — goal がループ・停滞・過剰設計に入っていないかを判断モデルに聞き、
 * decisions.jsonl に記録するだけの見張り（design g-mwu3tz06）。
 *
 * 方針:
 * - 記録だけ。警告・pause・steer・モデル切替はしない（state も書かない）
 * - 材料は作業記録（history.jsonl）の直近だけで、会話本文とコードの中身は渡さない
 * - 前回から記録が増えていなければ呼ばない（idle のたびに課金・送信しない）
 * - 失敗は握り潰す（見張りでループを止めない）
 *
 * outbox 監視の `src/watch.ts` とは別物。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  callDecision,
  decisionAvailable,
  extractNoulProbs,
  logDecision,
  primaryProviderName,
  PROVIDERS,
  type DecisionQuestion,
  type FetchFn,
} from "./decision";
import { readHistory, type HistoryRecord, type Phase } from "./state";

/** 判定材料にする履歴の件数（直近）。増やすと送信量とノイズが増える */
export const WATCH_TAIL = 30;
/** 1 行あたりの材料の上限（goal_summary など長い行を切る） */
const LINE_MAX = 160;
export const WATCH_TIMEOUT_MS = 15_000;

export const WATCH_KEYS = ["loop", "stall", "overscope"] as const;

/** 3 問ははい／いいえ（noul の値＝yes の確率） */
export const WATCH_QUESTIONS: Record<(typeof WATCH_KEYS)[number], DecisionQuestion> = {
  loop: {
    type: "noul",
    instructions:
      "作業ログで、同じ指摘・同じ失敗に対して同じ手（同じ修正・同じ確認）を繰り返しているか。繰り返しているならyes",
  },
  stall: {
    type: "noul",
    instructions:
      "作業ログで、成果（テスト通過・差分の前進・フェーズの前進）が出ないまま同じ段階に留まっているか。留まっているならyes",
  },
  overscope: {
    type: "noul",
    instructions:
      "作業ログで、目標に対して範囲が膨らんでいる（頼まれていない変更・抽象・ファイルが増えている）か。膨らんでいるならyes",
  },
};

/** その goal の履歴だけを直近 WATCH_TAIL 件に絞る */
export function goalHistory(
  records: HistoryRecord[],
  goalID: string,
): HistoryRecord[] {
  return records.filter((r) => (r as { goal?: unknown }).goal === goalID).slice(-WATCH_TAIL);
}

/** 材料に載せてよい文字列フィールド（短い機械的な値だけ）。title・text・notes・path などの自由文は載せない */
const STRING_FIELDS = new Set([
  "from",
  "to",
  "phase",
  "level",
  "route",
  "router_route",
  "verdict_level",
  "critic_level",
  "outcome",
  "stage",
  "agent",
  "diff_gate",
]);
/** 文字列の配列として載せてよいフィールド（角度の id など） */
const LIST_FIELDS = new Set(["lens", "lenses"]);

/** 許可リスト方式で 1 行分のフィールドを選ぶ。数値・真偽値はそのまま、文字列は許可したものだけ。
 * 会話本文やコードが混ざりうる自由文を外部の判断モデルへ送らないため（design g-mwu3tz06 やらないこと） */
export function pickFields(r: HistoryRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (k === "ts" || k === "type" || k === "goal") continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && STRING_FIELDS.has(k)) out[k] = v;
    else if (Array.isArray(v) && LIST_FIELDS.has(k) && v.every((x) => typeof x === "string")) out[k] = v;
  }
  return out;
}

/** 判定材料の文章と、変化検知用の指紋（件数＋最終行の時刻） */
export function buildWatchText(input: {
  goalID: string;
  phase: Phase;
  history: HistoryRecord[];
}): { text: string; fingerprint: string; count: number } {
  const mine = goalHistory(input.history, input.goalID);
  const lines = mine.map((r) => {
    const { type } = r as HistoryRecord;
    return `- ${type} ${JSON.stringify(pickFields(r)).slice(0, LINE_MAX)}`;
  });
  const text = [
    `goal ${input.goalID} の作業ログ（古い順・直近 ${mine.length} 件）。phase=${input.phase}`,
    "これはコードや会話ではなく、作業の進み方の記録である。",
    ...lines,
  ].join("\n");
  return {
    text,
    fingerprint: `${mine.length}:${String(mine.at(-1)?.ts ?? "")}:${input.phase}`,
    count: mine.length,
  };
}

/** history.jsonl の大きさと更新時刻。変わっていなければ読まずに諦めるための安い指紋 */
function historySignature(root: string): string | null {
  try {
    const s = statSync(join(root, ".graphhopper", "history.jsonl"));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/** 前回判定した goal 単位の指紋（プロセス内のみ。再起動で 1 回だけ余分に判定するのは許容） */
const seen = new Map<string, string>();
/** 前回見た history.jsonl の stat。同じならファイルを読まずに諦める（goal 単位の判定は seen が行う） */
const seenStat = new Map<string, string>();
/** 実行中の key（同じ goal の判定を並走させない） */
const inFlight = new Set<string>();

/** テスト用: 変化検知の記憶を消す */
export function resetWatchMemory(): void {
  seen.clear();
  seenStat.clear();
  inFlight.clear();
}

export type WatchOutcome = {
  status: "recorded" | "no_change" | "skipped" | "failed" | "empty";
  probs?: Record<string, number>;
  reason?: string;
};

/** 見張りを 1 回実行する。呼び出し側は待たない（void） */
export async function watchGoal(input: {
  root: string;
  goalID: string;
  sessionID: string;
  phase: Phase;
  /** 渡さなければ history.jsonl を読む（テストは差し替える） */
  history?: HistoryRecord[];
  fetchFn?: FetchFn;
  timeoutMs?: number;
}): Promise<WatchOutcome> {
  const key = `${input.root}\u0000${input.goalID}`;
  const sig = input.history ? null : historySignature(input.root);
  if (!decisionAvailable()) return { status: "skipped" };
  if (inFlight.has(key)) return { status: "no_change" };
  /* 安い指紋（ファイルの大きさと更新時刻）が同じなら、履歴を読まずに諦める */
  if (sig !== null && seenStat.get(key) === sig) return { status: "no_change" };

  const t0 = performance.now();
  const base = {
    kind: "watch" as const,
    sessionID: input.sessionID,
    goal: input.goalID,
    delivered: false,
  };
  const provider = primaryProviderName();

  inFlight.add(key);
  try {
    const { text, fingerprint, count } = buildWatchText({
      goalID: input.goalID,
      phase: input.phase,
      history: input.history ?? readHistory(input.root),
    });
    if (sig !== null) seenStat.set(key, sig);
    /* 別 goal の書き込みでファイルが変わっても、この goal の記録が同じなら呼ばない。
     * 呼ぶ前に覚える。失敗しても idle のたびに叩き直さない（次の記録が増えるまで待つ） */
    if (seen.get(key) === fingerprint) return { status: "no_change" };
    seen.set(key, fingerprint);
    if (count === 0) return { status: "empty" };

    const r = await callDecision(
      text,
      WATCH_QUESTIONS,
      input.fetchFn ?? fetch,
      input.timeoutMs ?? WATCH_TIMEOUT_MS,
      PROVIDERS[provider],
    );
    const latencyMs = Math.round(performance.now() - t0);
    if (!r.ok) {
      await logDecision(input.root, {
        ...base,
        provider,
        model: null,
        request: text,
        result: "error",
        confidence: null,
        latencyMs,
        fallback: true,
        reason: r.reason,
      });
      return { status: "failed", reason: r.reason };
    }
    const probs = extractNoulProbs(r.answers, WATCH_KEYS);
    await logDecision(input.root, {
      ...base,
      provider: r.provider,
      model: r.model,
      request: text,
      result: WATCH_KEYS.map((k) => `${k}=${(probs[k] ?? 0).toFixed(2)}`),
      confidence: null,
      probs,
      latencyMs,
      fallback: false,
      reason: "記録のみ（介入しない）",
    });
    return { status: "recorded", probs };
  } catch (e) {
    /* 内部例外も 1 行残す（design 判断4「失敗は記録して握り潰す」）。
     * 材料の組み立てに失敗した場合は text が無いので短い request で残す */
    const reason = `内部例外(${e instanceof Error ? e.message : String(e)})`;
    await logDecision(input.root, {
      ...base,
      provider,
      model: null,
      request: reason,
      result: "error",
      confidence: null,
      latencyMs: Math.round(performance.now() - t0),
      fallback: true,
      reason,
    });
    return { status: "failed", reason };
  } finally {
    inFlight.delete(key);
  }
}
