/**
 * モデルカスケード — d1 の難易度と連続失敗数から、メインセッションのモデルと
 * サブエージェント割当を切り替える。
 *
 * 判断（resolveLevel / shouldSwitchChild / resolveChildModel）は純関数。適用・復元は
 * CascadeHost / ChildHost を注入して行うので、ctx 依存の部分を fake に差し替えてテストできる。
 * state の読み書きは呼び出し側（plugin / tools）が行う。
 */
import type { CascadeConfig, CascadeState, Difficulty } from "./state";

export type CascadeLevel = "baseline" | "escalated";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** ctx に依存する操作の最小面。実装は plugin 側（graphhopper の Gh.ctx） */
export interface CascadeHost {
  /** 現在のモデル。取れない場合は null（＝切替しない） */
  getModel(sessionID: string): Promise<ModelRef | null>;
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
}

/** "provider/model#variant" → ModelRef。不正・空は null（例外にしない） */
export function parseCascadeModel(ref: string | null | undefined): ModelRef | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const [providerModel, variant] = trimmed.split("#", 2);
  const slash = (providerModel ?? "").indexOf("/");
  if (slash <= 0 || slash === (providerModel ?? "").length - 1) return null;
  const providerID = providerModel!.slice(0, slash);
  const id = providerModel!.slice(slash + 1);
  if (!providerID || !id) return null;
  return variant ? { providerID, id, variant } : { providerID, id };
}

/** 正規化表記 "provider/id"（variant があれば "#variant"）。比較にも使う */
export function formatModel(model: ModelRef | null): string | null {
  if (!model) return null;
  return model.variant
    ? `${model.providerID}/${model.id}#${model.variant}`
    : `${model.providerID}/${model.id}`;
}

/**
 * 適用すべきレベルを決める（ラチェット付き）。
 * 上から評価する:
 *  0. 無効 → baseline
 *  1. 既に escalated → escalated（ok attempt で fail_streak が 0 に戻っても降格しない）
 *  2. 連続失敗が閾値以上 → escalated
 *  3. 難易度が escalate_on に含まれる → escalated
 *  4. それ以外 → baseline
 */
export function resolveLevel(input: {
  difficulty: Difficulty | null;
  failStreak: number;
  currentLevel: CascadeLevel | null;
  config: CascadeConfig;
}): { level: CascadeLevel; reason: string } {
  const { difficulty, failStreak, currentLevel, config } = input;
  if (!config.enabled) return { level: "baseline", reason: "cascade disabled" };
  if (currentLevel === "escalated") {
    return { level: "escalated", reason: "already escalated（ラチェット）" };
  }
  if (config.fail_threshold > 0 && failStreak >= config.fail_threshold) {
    return {
      level: "escalated",
      reason: `fail_streak ${failStreak} >= ${config.fail_threshold}`,
    };
  }
  if (difficulty && config.escalate_on.includes(difficulty)) {
    return { level: "escalated", reason: `difficulty ${difficulty}` };
  }
  return {
    level: "baseline",
    reason: difficulty ? `difficulty ${difficulty}` : "difficulty unknown",
  };
}

/** main が「弱い」か（未取得・baseline と同じ）。確認用の main 指定で使う */
function isWeakMain(main: ModelRef | null, config: CascadeConfig): boolean {
  if (!main) return true;
  return formatModel(main) === formatModel(parseCascadeModel(config.baseline));
}

/** "main" 指定の解決先。main が弱ければ main_fallback → expert → escalate の順 */
export function resolveMainModel(input: {
  main: ModelRef | null;
  config: CascadeConfig;
}): { ref: ModelRef | null; raw: string } {
  if (!isWeakMain(input.main, input.config)) {
    return { ref: input.main, raw: formatModel(input.main) ?? "" };
  }
  for (const raw of [input.config.main_fallback, input.config.expert, input.config.escalate]) {
    const ref = parseCascadeModel(raw);
    if (ref) return { ref, raw: raw! };
  }
  return { ref: null, raw: "main" };
}

/**
 * 切替先モデルの決定。優先順位:
 * 1. implementing の途中確認中（checkpoint=reviewing）→ main
 * 2. phase_models[phase]（"main" は main 解決、解決できなければ level へ）
 * 3. level のモデル（baseline / escalated）
 */
export function resolveTargetModel(input: {
  phase?: string | null;
  level: CascadeLevel;
  config: CascadeConfig;
  /** goal 開始時のモデル（cascade.restore） */
  main?: ModelRef | null;
  checkpoint?: string | null;
}): { ref: ModelRef | null; raw: string; source: "phase" | "level" | "main" } {
  const levelRaw = input.level === "escalated" ? input.config.escalate : input.config.baseline;
  const wantMain = input.checkpoint === "reviewing" && input.phase === "implementing";
  const phaseRaw = input.phase ? input.config.phase_models?.[input.phase] : undefined;
  if (wantMain || phaseRaw?.trim() === "main") {
    const main = resolveMainModel({ main: input.main ?? null, config: input.config });
    if (main.ref) return { ref: main.ref, raw: main.raw, source: "main" };
    /* main が解決できないときは level へフォールバック（切替しないより安い） */
    return { ref: parseCascadeModel(levelRaw), raw: levelRaw, source: "level" };
  }
  const phaseRef = parseCascadeModel(phaseRaw);
  if (phaseRaw && phaseRef) return { ref: phaseRef, raw: phaseRaw, source: "phase" };
  return { ref: parseCascadeModel(levelRaw), raw: levelRaw, source: "level" };
}

/**
 * レベルの適用。restore（goal開始前のモデル）は previous から引き継ぎ、
 * 無ければ現在のモデルを保存する。モデルが取れない場合は何もせず null を返す。
 */
export async function applyCascade(
  host: CascadeHost,
  input: {
    sessionID: string;
    level: CascadeLevel;
    reason: string;
    config: CascadeConfig;
    previous: CascadeState | null;
    phase?: string | null;
    /** checkpoint を引き継ぐ（syncCascade の書き込みで消さない） */
    checkpoint?: CascadeState["checkpoint"];
  },
): Promise<CascadeState | null> {
  /* restore は最初の適用時に固定する（以後の main 解決の基準になる） */
  const restore = input.previous?.restore ?? (await host.getModel(input.sessionID));
  if (!restore) return null; // 復元先が無い切替はしない
  const checkpoint = input.checkpoint ?? input.previous?.checkpoint;
  const target = resolveTargetModel({
    phase: input.phase,
    level: input.level,
    config: input.config,
    main: restore,
    checkpoint: checkpoint ?? null,
  }).ref;
  if (!target) return null;

  try {
    await host.switchModel(input.sessionID, target);
  } catch {
    return null; // 切替失敗は状態を書かない（呼び出し側のループを止めない）
  }

  return {
    level: input.level,
    reason: input.reason,
    model: formatModel(target),
    restore,
    children: input.previous?.children ?? [],
    ...(checkpoint ? { checkpoint } : {}),
    at: new Date().toISOString(),
  };
}

/** quality マップから子セッションのモデルを決める。マップ外・agent 未指定は null */
export function resolveChildModel(input: {
  childAgent?: string | null;
  quality: Record<string, string>;
}): string | null {
  const agent = input.childAgent?.trim();
  if (!agent) return null;
  return input.quality[agent] ?? null;
}

/**
 * 子セッションのモデルを切り替えるべきか。
 * 親が goal の bound セッションであること・goal が active であること・
 * マップに該当すること・現在モデルが対象と異なることを要求する。
 */
export function shouldSwitchChild(input: {
  parentID?: string | null;
  boundSessionID?: string | null;
  goalStatus?: string | null;
  childAgent?: string | null;
  currentModel?: string | null;
  target?: string | null;
  apply?: "always" | "escalated";
  level?: "baseline" | "escalated" | null;
}): boolean {
  if (!input.parentID || !input.boundSessionID) return false;
  if (input.parentID !== input.boundSessionID) return false;
  if (input.goalStatus !== "active") return false;
  if (!input.target) return false;
  if (input.apply === "escalated" && input.level !== "escalated") return false;
  if (input.currentModel && input.currentModel === input.target) return false;
  return true;
}

/** 子セッション切替に必要な host（差し替えてテストできる） */
export interface ChildHost {
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
  getModel(sessionID: string): Promise<ModelRef | null>;
}

/**
 * 子セッションのモデルを切り替え、読み返しで一致を確かめる。
 * 失敗しても例外は投げない（呼び出し側のイベントループを止めない）。
 */
export async function escalateChildSession(
  host: ChildHost,
  input: { sessionID: string; agent: string; target: string; timeoutMs?: number },
): Promise<{ model: string; readback_match: boolean } | null> {
  const target = parseCascadeModel(input.target);
  if (!target) return null;
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timedOut = false;
  try {
    await Promise.race([
      host.switchModel(input.sessionID, target),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      }),
    ]);
  } catch {
    return null;
  }
  if (timedOut) return { model: formatModel(target) ?? input.target, readback_match: false };
  let readback: ModelRef | null = null;
  try {
    readback = await host.getModel(input.sessionID);
  } catch {
    readback = null;
  }
  // 比較は provider+id のみ（readback には variant="default" が付くため完全一致では必ず外れる）
  const readback_match = !!readback && readback.providerID === target.providerID && readback.id === target.id;
  return { model: formatModel(target) ?? input.target, readback_match };
}

/**
 * 孤児 cascade（active でない goal に紐づく適用状態）を復元すべきか。
 * completeGoal は goals.active を null にしない（status=done のまま残る）ため、
 * 「active が無い」ではなく「active な goal が無い」で判定する。
 */
export function shouldFlushOrphan(
  active: { status: string } | null,
  cascade: CascadeState | null,
): boolean {
  if (!cascade) return false;
  return !active || active.status !== "active";
}

/** goal 終了時の復元。sessionID か restore が無ければ何もしない */
export async function endCascade(
  host: CascadeHost,
  sessionID: string | null,
  state: CascadeState | null,
): Promise<boolean> {
  const restore = state?.restore;
  if (!sessionID || !restore) return false;
  try {
    await host.switchModel(sessionID, restore);
  } catch {
    return false; // セッション消失などは無視（他セッションへ影響させない）
  }
  return true;
}
