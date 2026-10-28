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
  resolveTargetModel,
  shouldFlushOrphan,
} from "../../../src/cascade";
import * as state from "../../../src/state";
import { readRun } from "../../../src/workflow";
import { logDecision } from "../../../src/decision";
import { INTERNAL_PROMPT_METADATA_KEY } from "../../../src/entry-decide";
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
  let active = state.getActive(gh.root);
  if (!active) return null;
  /* implementing を外れたら途中確認は終わり（polish は main 指定なので不要） */
  const cp = active.state.cascade?.checkpoint;
  if (active.state.phase !== "implementing" && cp && cp !== "done") {
    state.setCascadeCheckpoint(gh.root, "done", `phase ${active.state.phase} で途中確認を終了`);
    active = state.getActive(gh.root) ?? active;
  }
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

  const phase = active.state.phase;
  const current = active.state.cascade;
  const sessionID = active.state.session_id;
  /* main 指定の解決基準。restore は最初の適用時に固定される */
  const main = current?.restore ?? (sessionID ? await host.getModel(sessionID) : null);
  const resolved = resolveTargetModel({
    phase,
    level,
    config: config.cascade,
    main,
    checkpoint: current?.checkpoint ?? null,
  });
  const targetRef = resolved.ref;
  if (!targetRef) {
    return `cascade: モデル指定が不正（${resolved.raw}）— このgoalでは切替しない`;
  }
  const targetKey = formatModel(targetRef);
  if (current && current.level === level && current.model === targetKey) return null;

  if (!sessionID) return "cascade: session unbound（切替せず）";

  const next = await applyCascade(host, {
    sessionID,
    level,
    reason,
    config: config.cascade,
    previous: current,
    phase,
  });
  if (!next) return "cascade: モデル不明のため切替せず";
  const fromModel =
    current?.model ?? (next.restore ? `${next.restore.providerID}/${next.restore.id}` : "(不明)");
  state.recordEvent(gh.root, {
    type: "cascade_switch",
    goal: active.goal.id,
    from: fromModel,
    to: next.model ?? targetKey ?? "(不明)",
    phase,
    reason:
      resolved.source === "phase"
        ? `phase ${phase}`
        : resolved.source === "main"
          ? `${resolved.raw === "main" ? "main" : `main(${resolved.raw})`}`
          : reason,
  });
  // await 中に detached な子セッション記録が追記され得るため、現在値を読み直してマージする
  const latest = state.readState(gh.root).cascade?.children ?? [];
  state.setCascade(gh.root, { ...next, children: mergeChildren(next.children, latest) });
  return `cascade: ${level}（${reason}）→ ${next.model}`;
}

/** implementing の途中（タスク半分到達）で main 確認を1回要求する。戻り値は表示用の1行 */
export function maybeRequestCheckpoint(gh: Gh): string | null {
  const active = state.getActive(gh.root);
  if (!active || active.state.phase !== "implementing") return null;
  const cfg = state.readConfig(gh.root).cascade;
  if (!cfg.enabled || !cfg.checkpoint) return null;
  const current = active.state.cascade;
  if (!current || current.checkpoint) return null; // 1 goal 1回
  const loaded = state.readTodosStatus(gh.root, active.goal.id);
  if (!loaded.valid) return null;
  const items = loaded.store.items;
  const done = items.filter((i) => i.status === "completed").length;
  if (items.length < 2 || done * 2 < items.length) return null;
  state.setCascadeCheckpoint(gh.root, "requested", `完了 ${done}/${items.length}`);
  return `checkpoint: 半分到達（${done}/${items.length}）— 次の idle で main に1ターン切り替えて方向を確認する`;
}

/**
 * requested → reviewing。main へ切り替えて確認 prompt を送る。
 * 切替できなかったときは checkpoint を done にして false（prompt を送らない）。
 */
export async function beginCheckpointReview(gh: Gh, sessionID: string): Promise<boolean> {
  const before = state.getActive(gh.root);
  if (!before?.state.cascade) return false;
  state.setCascadeCheckpoint(gh.root, "reviewing", "途中確認を開始");
  const note = await syncCascade(gh);
  const after = state.getActive(gh.root);
  if (note?.includes("切替せず") || note?.includes("不正")) {
    state.setCascadeCheckpoint(gh.root, "done", `切替できず中止: ${note}`);
    return false;
  }
  const model = after?.state.cascade?.model ?? "(不明)";
  await gh.ctx.session.prompt({
    sessionID,
    text: [
      `[graphhopper] 途中確認: main モデル（${model}）に切り替えた。実装の方向だけを確認せよ。`,
      "- design と現在の差分（jj diff / git diff）を読み、要件とずれていないか・このまま続けて良いかを見る",
      `- 問題があれば修正方針を .graphhopper/plans/${before.goal.id}.log.md に書く。このターンで大きな実装はしない`,
      "- 問題が無ければ「方向OK」と1行で述べる",
      "次のターンで実装用モデルへ戻して続ける。",
    ].join("\n"),
    metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
  });
  return true;
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
