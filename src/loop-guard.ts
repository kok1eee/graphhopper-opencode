/**
 * 自動継続の上限ガード（純関数）。
 * opencode 組み込み /goal の上限（maxRounds / maxStalls / 待ち上限 / 再起動時 paused）と
 * 同趣旨の歯止めを graphhopper 側でも持つ。
 */
import type { GraphhopperConfig, LoopGuard } from "./state";

export type GuardPauseReason = "rounds" | "stalls" | "wait" | "restart";

export type GuardDecision =
  | { action: "wait"; next: LoopGuard }
  | { action: "continue"; next: LoopGuard }
  | { action: "pause"; reason: GuardPauseReason; next: LoopGuard };

export interface GuardConfig {
  loop_max_rounds: GraphhopperConfig["loop_max_rounds"];
  loop_max_stalls: GraphhopperConfig["loop_max_stalls"];
  loop_wait_limit_ms: GraphhopperConfig["loop_wait_limit_ms"];
}

export interface GuardInput {
  guard: LoopGuard;
  config: GuardConfig;
  /** 現在時刻（ms）。テストで固定できるようにする */
  now: number;
  /** 継続を積もうとしている時点の進捗キー */
  progressKey: string;
  /** background（subagent / shell）が実行中か */
  waiting: boolean;
  /** このプロセスの boot id */
  boot: string;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function parseIso(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * 継続してよいか / 待つか / 止めるかを決める。
 * - waiting: background 実行中。待ち始めを記録し、上限超過で pause。
 * - 進捗キーが前回と同じなら stalls を増やす。
 * - rounds は「積んだ回数」。上限に達したら pause（上限回数までは継続できる）。
 */
export function evaluateGuard(input: GuardInput): GuardDecision {
  const { guard, config, now, progressKey, waiting, boot } = input;

  if (waiting) {
    const since = parseIso(guard.wait_since);
    if (since === null) {
      return { action: "wait", next: { ...guard, wait_since: iso(now) } };
    }
    if (now - since >= config.loop_wait_limit_ms) {
      return { action: "pause", reason: "wait", next: { ...guard, wait_since: null } };
    }
    return { action: "wait", next: guard };
  }

  /* background が空になったら待ち時間はリセット */
  const base: LoopGuard = { ...guard, wait_since: null };

  if (config.loop_max_rounds > 0 && base.rounds >= config.loop_max_rounds) {
    return { action: "pause", reason: "rounds", next: base };
  }

  const stalls =
    base.progress_key !== null && base.progress_key === progressKey
      ? base.stalls + 1
      : 0;
  if (config.loop_max_stalls > 0 && stalls >= config.loop_max_stalls) {
    return {
      action: "pause",
      reason: "stalls",
      next: { ...base, stalls, progress_key: progressKey },
    };
  }

  return {
    action: "continue",
    next: {
      ...base,
      rounds: base.rounds + 1,
      stalls,
      progress_key: progressKey,
      pending: true,
      boot,
    },
  };
}

/** 継続を積んだままプロセスが落ちたか（起動時に pause する対象） */
export function isMidRoundRestart(
  guard: LoopGuard | null | undefined,
  boot: string,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (!guard) return false;
  return guard.pending === true && guard.boot !== null && guard.boot !== boot;
}

/**
 * 進捗キー。phase が変わった / todos が進んだ / eval 結果が変わった / 差分が変わった /
 * design doc が更新された のいずれかで別の値になる。
 */
export function progressKeyOf(input: {
  phase: string;
  todosDone: number;
  evalFingerprint: string | null;
  diffLines: number | null;
  planSize: number | null;
}): string {
  return [
    input.phase,
    input.todosDone,
    input.evalFingerprint ?? "-",
    input.diffLines ?? "-",
    input.planSize ?? "-",
  ].join("|");
}
