/**
 * モデルカスケードの plugin 配線。
 *
 * - メインセッション: goal のカスケード段（baseline / escalated）で切り替える
 * - 子セッション（subagent）: `cascade.agents.quality` に載った判定 node だけを昇格モデルに
 *   切り替える（`session.created` イベント経由。hooks.ts 側）。
 *
 * agent カタログ（agent.transform）は使わない。カタログはプロセス共有で他セッションの
 * subagent 呼び出しへ波及するため、goal 単位の保証ができない（経緯は .graphhopper/plans/<goal>.log.md）。
 */
import {
  type CascadeHost,
  type ModelRef,
  applyCascade,
  endCascade,
  formatModel,
  parseCascadeModel,
  resolveLevel,
  shouldFlushOrphan,
} from "../../../src/cascade";
import * as state from "../../../src/state";
import { readRun } from "../../../src/workflow";
import { logDecision } from "../../../src/decision";
import type { CascadeChild } from "../../../src/state";
import type { Gh } from "./shared";

function makeHost(gh: Gh): CascadeHost {
  return {
    async getModel(sessionID: string): Promise<ModelRef | null> {
      try {
        const info = await gh.ctx.session.get({ sessionID });
        const m = info?.model;
        if (!m?.providerID || !m?.id) return null;
        return { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) };
      } catch {
        return null;
      }
    },
    async switchModel(sessionID: string, model: ModelRef): Promise<void> {
      await gh.ctx.session.switchModel({ sessionID, model: model as never });
    },
  };
}

/**
 * 現在の difficulty / fail_streak からレベルを評価して適用する。
 * enabled=false のときは適用中のものを復元する。戻り値は表示用の1行（変更なしは null）。
 */
export async function syncCascade(gh: Gh): Promise<string | null> {
  const active = state.getActive(gh.root);
  if (!active) return null;
  const host = makeHost(gh);
  const config = state.readConfig(gh.root);

  if (!config.cascade.enabled) {
    if (!active.state.cascade) return null;
    await endCascade(host, active.state.session_id, active.state.cascade);
    state.setCascade(gh.root, null);
    return "cascade: disabled → restored";
  }

  const { level, reason } = resolveLevel({
    difficulty: active.state.difficulty ?? null,
    failStreak: active.state.fail_streak,
    currentLevel: active.state.cascade?.level ?? null,
    config: config.cascade,
  });

  const target = level === "escalated" ? config.cascade.escalate : config.cascade.baseline;
  const targetRef = parseCascadeModel(target);
  if (!targetRef) {
    return `cascade: モデル指定が不正（${target}）— このgoalでは切替しない`;
  }
  const targetKey = formatModel(targetRef);
  const current = active.state.cascade;
  if (current && current.level === level && current.model === targetKey) return null;

  const sessionID = active.state.session_id;
  if (!sessionID) return "cascade: session unbound（切替せず）";

  const next = await applyCascade(host, {
    sessionID,
    level,
    reason,
    config: config.cascade,
    previous: current,
  });
  if (!next) return "cascade: モデル不明のため切替せず";
  // await 中に detached な子セッション記録が追記され得るため、現在値を読み直してマージする
  const latest = state.readState(gh.root).cascade?.children ?? [];
  state.setCascade(gh.root, { ...next, children: mergeChildren(next.children, latest) });
  return `cascade: ${level}（${reason}）→ ${next.model}`;
}

/** 子セッション記録を sessionID で重複排除しつつマージする（新しい方を優先） */
export function mergeChildren(
  a: readonly CascadeChild[],
  b: readonly CascadeChild[],
): CascadeChild[] {
  const map = new Map<string, CascadeChild>();
  for (const item of a) map.set(item.sessionID, item);
  for (const item of b) map.set(item.sessionID, item);
  return [...map.values()].slice(-10);
}

/**
 * active goal が無いのに cascade だけ残っている場合の後始末。
 * MCP サーバー経由で complete/clear された場合、plugin 側の finishCascade が走らないため、
 * 次の idle でここが復元する（state.cascade は complete/clear では消えない）。
 */
export async function flushOrphanCascade(gh: Gh): Promise<string | null> {
  const active = state.getActive(gh.root);
  const raw = state.readState(gh.root);
  const cascade = raw.cascade;
  if (!shouldFlushOrphan(active ? { status: active.goal.status } : null, cascade)) return null;
  if (!cascade) return null;
  const ok = await endCascade(makeHost(gh), raw.session_id, cascade);
  state.clearCascadeState(gh.root);
  return ok ? `cascade: 孤児を復元 → ${cascade.restore?.providerID}/${cascade.restore?.id}` : null;
}

/** goal 終了時に goal 開始前のモデルへ戻す。active が消える前に呼ぶこと */
export async function finishCascade(gh: Gh): Promise<string | null> {
  const active = state.getActive(gh.root);
  if (active) {
    const run = readRun(gh.root, active.goal.id);
    /* decision_id は「このセッションの最後の成功 decide」を優先する。
     * goal start の保険は非同期で decide 行を書くため、start 時点の id では
     * 保険行に紐付かない。goal 中は hook が active_goal で skip するので、
     * 完了時点の最後の成功 decide は入口の判定行になる */
    const decisionId =
      state.readSessionDecisionId(gh.root, active.state.session_id ?? "") ??
      active.state.decision_id ??
      null;
    await logDecision(gh.root, {
      decision_id: decisionId,
      kind: "outcome",
      request: active.goal.title.slice(0, 200),
      result: active.state.cascade?.level ?? "none",
      confidence: null,
      latencyMs: 0,
      fallback: false,
      reason: `goal終了(${active.goal.status})`,
      difficulty: active.state.difficulty ?? null,
      outcome: {
        goal_id: active.state.goal_id ?? "",
        fail_streak: active.state.fail_streak,
        escalated: active.state.cascade?.level === "escalated",
        verifier: active.state.last_verifier?.level ?? null,
        ...(run ? { workflow: run.workflow, inserted: run.inserted } : {}),
      },
    });
  }
  const cascade = active?.state.cascade;
  if (!active || !cascade) return null;
  const ok = await endCascade(makeHost(gh), active.state.session_id, cascade);
  state.setCascade(gh.root, null);
  return ok ? `cascade: restored → ${cascade.restore?.providerID}/${cascade.restore?.id}` : null;
}
