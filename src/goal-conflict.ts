/**
 * opencode 組み込み `/goal`（opencode.goal プラグイン）との併用検知。
 *
 * 組み込み goal が active のセッションで graphhopper も継続を積むと、
 * 2 つのループが同じ idle 地点で競合する。開始時と継続時に検知して避ける。
 *
 * RPC が無い・応答しない・形が違う場合は fail-open（false）にする。
 * 古い opencode で graphhopper が止まる方が実害が大きいため。
 */

export type GoalCheckReason =
  | "active"
  | "none"
  | "rpc_missing"
  | "timeout"
  | "shape";

export interface GoalCheckResult {
  active: boolean;
  reason: GoalCheckReason;
}

export interface RpcCaller {
  (input: {
    rpcID: string;
    method: string;
    input?: unknown;
    signal?: AbortSignal;
  }): Promise<{ output?: unknown }>;
}

/** RPC の output から「goal が active か」を読む。形が不明なら null */
export function parseGoalActive(output: unknown): boolean | null {
  if (output === null || output === undefined) return false;
  if (typeof output !== "object") return null;
  const status = (output as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  return status === "active";
}

export const GOAL_RPC_ID = "opencode.goal";

/** 組み込み goal の状態を読む（timeout 付き・fail-open） */
export async function checkBuiltinGoal(
  rpc: RpcCaller,
  sessionID: string,
  timeoutMs = 1500,
): Promise<GoalCheckResult> {
  if (!sessionID) return { active: false, reason: "none" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await rpc({
      rpcID: GOAL_RPC_ID,
      method: "get",
      input: { sessionID },
      signal: controller.signal,
    });
    const active = parseGoalActive(res?.output);
    if (active === null) return { active: false, reason: "shape" };
    return { active, reason: active ? "active" : "none" };
  } catch (e) {
    const aborted =
      controller.signal.aborted ||
      (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));
    return { active: false, reason: aborted ? "timeout" : "rpc_missing" };
  } finally {
    clearTimeout(timer);
  }
}
