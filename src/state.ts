/**
 * graphhopper state 管理
 *
 * `.graphhopper/` 配下の JSON/JSONL ファイルを読み書きする。
 * - goals.json    : 目標キューと active 指定
 * - state.json    : 現在のループ状態（フェーズ・セッション紐付け・verifier サブステート）
 * - config.json   : プロジェクト毎の上書き設定（任意）
 * - history.jsonl : 監査ログ（append-only）
 * - plans/<goal-id>.md : design ドキュメント（designing フェーズで書く唯一の許可パス）
 *
 * 外部依存なし（node stdlib のみ）。全ての書き込みは tmp+rename で原子的に行う。
 * flywheel-opencode (src/state.ts) の atomic write パターンを踏襲。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** graphhopper 本体（Claude Code版）の3相グラフに合わせる。flywheelの8フェーズより薄い */
export const PHASES = ["designing", "implementing", "polish", "done"] as const;
export type Phase = (typeof PHASES)[number];

export type GoalStatus = "active" | "paused" | "done";

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  created_at: string;
  done_at: string | null;
}

export type VerdictLevel = "clean" | "drift";
/** drift 巻き戻し先。implementing 以外は人間の hand-back 待ち（flywheelのmonitor相当） */
export type DriftTarget = "implementing" | "design" | "requirements";
export type VerifierLens = "requirement" | "behavior" | "progress";

export interface VerifierVerdict {
  level: VerdictLevel;
  reason: string;
  target: DriftTarget | null;
  lens: VerifierLens[];
  at: string;
}

export type RouterRoute = "advisor" | "polish";

export interface RouterState {
  baseline_rev: string | null;
  diff_lines: number | null;
  route: RouterRoute | null;
  checked_at: string | null;
}

export interface LoopState {
  goal_id: string | null;
  /** ループ継続注入の対象セッション。null は未バインド */
  session_id: string | null;
  phase: Phase;
  /** 中断・再開用のメモ（「どこまでやったか」） */
  notes: string;
  /** router gate（loop-driver.sh 相当）が直近に測った diff サイズと分岐先 */
  router: RouterState;
  /** polish フェーズの verifier fan-out 結果。null = 未実行 */
  last_verifier: VerifierVerdict | null;
  updated_at: string;
}

export interface GoalsFile {
  goals: Goal[];
  active: string | null;
}

export interface GraphhopperConfig {
  /** router gate の分岐閾値（diff行数）。超えたら polish、以下なら advisor 相当の自己レビューで足りる */
  router_threshold_lines: number;
  /** designing フェーズで編集を許可する path（glob不可、prefix一致）。デフォルトは plans/ 配下のみ */
  design_gate_allow: string[];
  /** subagent 名で model を上書きする（例: { "graphhopper-verifier": "amazon-bedrock/anthropic.claude-opus-5" }） */
  agents: { [name: string]: string };
}

export const DEFAULT_CONFIG: GraphhopperConfig = {
  router_threshold_lines: 400,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
};

function dir(root: string): string {
  return join(root, ".graphhopper");
}

function goalsPath(root: string): string {
  return join(dir(root), "goals.json");
}

function statePath(root: string): string {
  return join(dir(root), "state.json");
}

function configPath(root: string): string {
  return join(dir(root), "config.json");
}

function historyPath(root: string): string {
  return join(dir(root), "history.jsonl");
}

export function planPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.md`);
}

export type HistoryEvent =
  | { type: "goal_start"; goal: string; title: string }
  | { type: "goal_pause"; goal: string }
  | { type: "goal_resume"; goal: string }
  | { type: "goal_complete"; goal: string }
  | { type: "phase"; goal: string; from: Phase; to: Phase; notes?: string }
  | {
      type: "router_check";
      goal: string;
      diff_lines: number;
      route: RouterRoute;
    }
  | {
      type: "verifier_verdict";
      goal: string;
      level: VerdictLevel;
      target: DriftTarget | null;
      lens: VerifierLens[];
    }
  | { type: "design_gate_block"; goal: string; tool: string; path: string };

/** append-only の履歴ログ。LLMの自己申告ではなくplugin機械記録の監査証跡 */
export function recordEvent(root: string, event: HistoryEvent): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(historyPath(root), line, "utf8");
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readConfig(root: string): GraphhopperConfig {
  const raw = readJson<Partial<GraphhopperConfig>>(configPath(root), {});
  return {
    router_threshold_lines:
      raw.router_threshold_lines ?? DEFAULT_CONFIG.router_threshold_lines,
    design_gate_allow:
      raw.design_gate_allow ?? DEFAULT_CONFIG.design_gate_allow,
    agents: { ...(DEFAULT_CONFIG.agents ?? {}), ...(raw.agents ?? {}) },
  };
}

export function readGoals(root: string): GoalsFile {
  return readJson<GoalsFile>(goalsPath(root), { goals: [], active: null });
}

function emptyState(): LoopState {
  return {
    goal_id: null,
    session_id: null,
    phase: "designing",
    notes: "",
    router: {
      baseline_rev: null,
      diff_lines: null,
      route: null,
      checked_at: null,
    },
    last_verifier: null,
    updated_at: new Date().toISOString(),
  };
}

export function readState(root: string): LoopState {
  const loaded = readJson<Partial<LoopState>>(statePath(root), emptyState());
  return {
    ...emptyState(),
    ...loaded,
    router: { ...emptyState().router, ...(loaded.router ?? {}) },
  };
}

function writeGoals(root: string, data: GoalsFile): void {
  atomicWrite(goalsPath(root), data);
}

function writeState(root: string, state: LoopState): void {
  state.updated_at = new Date().toISOString();
  atomicWrite(statePath(root), state);
}

export interface ActiveLoop {
  goal: Goal;
  state: LoopState;
}

/** active な goal と state の組を返す。無ければ null */
export function getActive(root: string): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  return { goal, state: readState(root) };
}

export function startGoal(
  root: string,
  title: string,
  sessionID: string,
): ActiveLoop {
  const goals = readGoals(root);
  const goal: Goal = {
    id: `g-${Date.now().toString(36)}`,
    title,
    status: "active",
    created_at: new Date().toISOString(),
    done_at: null,
  };
  for (const g of goals.goals) {
    if (g.status === "active") g.status = "paused";
  }
  goals.goals.push(goal);
  goals.active = goal.id;
  writeGoals(root, goals);

  const next: LoopState = {
    ...emptyState(),
    goal_id: goal.id,
    session_id: sessionID,
  };
  writeState(root, next);
  recordEvent(root, { type: "goal_start", goal: goal.id, title: goal.title });
  return { goal, state: next };
}

function mutateActive(
  root: string,
  fn: (
    goal: Goal,
    state: LoopState,
  ) => Partial<{ goal: Partial<Goal>; state: Partial<LoopState> }>,
): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  const state = readState(root);
  const patch = fn(goal, state);
  if (patch.goal) Object.assign(goal, patch.goal);
  if (patch.state) Object.assign(state, patch.state);
  writeGoals(root, goals);
  writeState(root, state);
  return { goal, state };
}

export function pauseGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({ goal: { status: "paused" } }));
  if (r) recordEvent(root, { type: "goal_pause", goal: r.goal.id });
  return r;
}

export function resumeGoal(root: string, sessionID: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "active" },
    state: { session_id: sessionID },
  }));
  if (r) recordEvent(root, { type: "goal_resume", goal: r.goal.id });
  return r;
}

export function completeGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "done", done_at: new Date().toISOString() },
    state: { phase: "done" },
  }));
  if (r) recordEvent(root, { type: "goal_complete", goal: r.goal.id });
  return r;
}

export function setPhase(
  root: string,
  phase: Phase,
  notes?: string,
): ActiveLoop | null {
  if (!PHASES.includes(phase)) return null;
  const before = getActive(root);
  const r = mutateActive(root, () => ({
    state: { phase, ...(notes !== undefined ? { notes } : {}) },
  }));
  if (r && before && before.state.phase !== phase) {
    recordEvent(root, {
      type: "phase",
      goal: r.goal.id,
      from: before.state.phase,
      to: phase,
      ...(notes ? { notes } : {}),
    });
  }
  return r;
}

export function unbindSession(root: string, sessionID: string): void {
  const state = readState(root);
  if (state.session_id !== sessionID) return;
  writeState(root, { ...state, session_id: null });
}

/* ================================================================== *
 * router gate（loop-driver.sh 相当）: diff サイズを機械測定して分岐
 * ================================================================== */
import type { PluginInput } from "@opencode-ai/plugin";
type Shell = PluginInput["$"];

/** baseline_rev を VCS から取得（jj → git → null） */
export async function captureBaselineRev(
  shell: Shell,
  root: string,
): Promise<string | null> {
  try {
    const r =
      await shell`sh -c ${"jj log -r 'heads() & ~empty()' -T commit_id --no-graph --limit 1"}`
        .cwd(root)
        .nothrow()
        .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out.split("\n")[0] ?? null;
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${"git rev-parse HEAD"}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out;
  } catch {
    // ignore
  }
  return null;
}

/** baseline からの diff 行数を測定する（jj → git fallback） */
export async function measureDiffLines(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<number> {
  if (!baseline) return 0;
  try {
    const r =
      await shell`sh -c ${`jj diff --from ${baseline} --stat 2>/dev/null | tail -1`}`
        .cwd(root)
        .nothrow()
        .quiet();
    const out = r.stdout.toString().trim();
    const m = out.match(/(\d+) insertions?.*?(\d+) deletions?/);
    if (m) return Number(m[1]) + Number(m[2]);
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${`git diff --shortstat ${baseline}`}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    const ins = out.match(/(\d+) insertion/);
    const del = out.match(/(\d+) deletion/);
    return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
  } catch {
    return 0;
  }
}

export function recordRouterCheck(
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    router: {
      baseline_rev: baseline,
      diff_lines: diffLines,
      route,
      checked_at: new Date().toISOString(),
    },
  };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, {
      type: "router_check",
      goal: state.goal_id,
      diff_lines: diffLines,
      route,
    });
  return next;
}

export function setVerifierVerdict(
  root: string,
  verdict: Omit<VerifierVerdict, "at">,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    last_verifier: { ...verdict, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "verifier_verdict",
      goal: state.goal_id,
      level: verdict.level,
      target: verdict.target,
      lens: verdict.lens,
    });
  }
  return next;
}

/* ================================================================== *
 * design gate（C-2不変条件）: designing フェーズで edit/write を許可パス以外に通さない
 * tool.execute.before hook から呼ばれる純関数（副作用なし）
 * ================================================================== */

export function isDesignGateBlocked(
  cfg: GraphhopperConfig,
  phase: Phase,
  filePath: string,
): boolean {
  if (phase !== "designing") return false;
  return !cfg.design_gate_allow.some((prefix) => filePath.includes(prefix));
}

/* ================================================================== *
 * discover（loop-until-dry）: phase graph の外にあるオンデマンド探索。
 * round cap / dedupe を code側で強制する（opencodeにWorkflow相当が無いため、
 * 「尽きるまで周回・でも確実に止まる」の保証をTS toolに持たせる）。
 * dedupeは「既見全体」（reject/未採用も含む）に対して行う——確定済みだけに
 * 対すると、一度リジェクトされたfindingが毎ラウンド再発見されて無限空転する。
 * ================================================================== */

const MAX_DISCOVER_ROUNDS = 8;
const DRY_ROUNDS_TO_STOP = 2;

export interface DiscoverState {
  target: string;
  scope: string;
  round: number;
  dry_streak: number;
  seen: string[];
  confirmed: {
    title: string;
    severity: string;
    confidence: number;
    quote: string;
  }[];
  stopped_reason: "dry" | "max_rounds" | null;
  started_at: string;
}

function discoverPath(root: string): string {
  return join(dir(root), "discover.json");
}

export function startDiscover(
  root: string,
  target: string,
  scope: string,
): DiscoverState {
  const s: DiscoverState = {
    target,
    scope,
    round: 0,
    dry_streak: 0,
    seen: [],
    confirmed: [],
    stopped_reason: null,
    started_at: new Date().toISOString(),
  };
  atomicWrite(discoverPath(root), s);
  return s;
}

export function readDiscover(root: string): DiscoverState | null {
  if (!existsSync(discoverPath(root))) return null;
  return readJson<DiscoverState | null>(discoverPath(root), null);
}

export interface DiscoverFinding {
  title: string;
  severity: string;
  confidence: number;
  quote: string;
}

/**
 * 1ラウンド分のfindingsを渡してdedupe・round/dry_streak更新を行う。
 * round capとdry判定はここで機械的に強制する（呼び出し側の自己申告に依存しない）。
 */
export function tickDiscover(
  root: string,
  findings: DiscoverFinding[],
): DiscoverState {
  const s = readDiscover(root);
  if (!s)
    throw new Error("no active discover session. call startDiscover first.");
  if (s.stopped_reason) return s; // 既に停止済みなら何もしない（冪等）

  s.round += 1;
  const seenSet = new Set(s.seen);
  const newOnes = findings.filter((f) => !seenSet.has(f.title));
  for (const f of findings) seenSet.add(f.title); // reject/未採用も含め全件seenに入れる
  s.seen = Array.from(seenSet);

  if (newOnes.length === 0) {
    s.dry_streak += 1;
  } else {
    s.dry_streak = 0;
    const adopted = newOnes.filter(
      (f) =>
        f.confidence >= 80 &&
        (f.severity === "critical" || f.severity === "high"),
    );
    s.confirmed.push(...adopted);
  }

  if (s.dry_streak >= DRY_ROUNDS_TO_STOP) s.stopped_reason = "dry";
  else if (s.round >= MAX_DISCOVER_ROUNDS) s.stopped_reason = "max_rounds";

  atomicWrite(discoverPath(root), s);
  return s;
}

export function clearDiscover(root: string): void {
  if (existsSync(discoverPath(root))) atomicWrite(discoverPath(root), null);
}
