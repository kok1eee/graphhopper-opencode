/**
 * graphhopper board — 各リポジトリの .graphhopper/ を読んで、goal の一覧に組み立てる。
 * 読み取り専用。壊れた記録は「読めない」として返し、呼び出し側（TUI）を止めない。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type GoalStatus = "active" | "paused" | "done";

export interface VerifyAngle {
  lens: string;
  level: "clean" | "drift" | "unknown";
  summary: string;
  /** drift の本文（指摘の中身）。clean は持たない */
  body?: string | null;
}

export interface VerifySummary {
  at: string | null;
  angles: VerifyAngle[];
  missing: { lens: string; reason: string }[];
  /** 判定が今の差分のものか。false=前の差分に対する判定。null=比べられない */
  currentDiff: boolean | null;
}

export interface BoardGoal {
  repo: string;
  repoName: string;
  id: string;
  title: string;
  status: GoalStatus;
  /** state.json がこの goal を指しているときだけ入る */
  phase: string | null;
  createdAt: string | null;
  doneAt: string | null;
  /** history の最後のイベント（この goal のもの） */
  lastEventAt: string | null;
  lastEventType: string | null;
  /** 自動継続が止まった理由（guard_pause / loop_stopped / eval_gave_up / goal_pause） */
  stop: { reason: string; at: string } | null;
  verify: VerifySummary | null;
  /** goals.json などが読めなかったときの説明 */
  error: string | null;
}

export interface Board {
  repos: { path: string; error: string | null }[];
  goals: BoardGoal[];
  errors: string[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".jj",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "vendor",
]);

export interface ScanRoot {
  dir: string;
  depth: number;
}

/** `.graphhopper/` を持つリポジトリを探す。見つけた下も潜る（複数リポジトリの親自身が持つことがある）。
 * 同じパスは 1 回だけ数える。根は文字列（既定の深さ）か、根ごとの深さ付きで渡す */
export function findRepos(roots: (string | ScanRoot)[], maxDepth = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number, limit: number): void => {
    if (depth > limit) return;
    let real: string;
    try {
      real = resolve(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let st;
    try {
      st = statSync(real);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    if (existsSync(join(real, ".graphhopper"))) out.push(real);
    let names: string[];
    try {
      names = readdirSync(real);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      if (SKIP_DIRS.has(n)) continue;
      walk(join(real, n), depth + 1, limit);
    }
  };
  for (const r of roots) {
    if (typeof r === "string") walk(r, 0, maxDepth);
    else walk(r.dir, 0, r.depth);
  }
  return out.sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const goals = (v as { goals?: unknown } | null)?.goals;
  return Array.isArray(goals) ? goals : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function statusOf(g: unknown): GoalStatus {
  const s = str((g as { status?: unknown }).status);
  return s === "active" || s === "paused" || s === "done" ? s : "paused";
}

interface RawEvent {
  ts?: unknown;
  type?: unknown;
  goal?: unknown;
  reason?: unknown;
}

function readHistory(path: string): RawEvent[] {
  if (!existsSync(path)) return [];
  const out: RawEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === "object") out.push(v as RawEvent);
    } catch {
      // 途中で切れた行は無視する
    }
  }
  return out;
}

const STOP_TYPES = new Set(["guard_pause", "loop_stopped", "eval_gave_up", "goal_pause"]);

/** 同じ停止とみなす間隔（goal_pause と guard_pause は同時に書かれる） */
const STOP_WINDOW_MS = 5000;

/** 一番新しい停止を返す。同じ停止の中に理由付きのイベント（guard_pause 等）があればその理由、
 * 無ければイベント種別（goal_pause / loop_stopped）を理由にする */
function findStop(events: RawEvent[]): { reason: string; at: string } | null {
  let newest: { type: string; at: string; t: number } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const type = str(e.type);
    const at = str(e.ts);
    if (!type || !STOP_TYPES.has(type) || !at) continue;
    const t = Date.parse(at);
    if (!newest) newest = { type, at, t };
    else if (Number.isNaN(t) || Number.isNaN(newest.t) || newest.t - t > STOP_WINDOW_MS) break;
    const reason = str(e.reason);
    if (reason) return { reason, at };
  }
  return newest ? { reason: newest.type, at: newest.at } : null;
}

/** 判定の json フェンス（先頭）を取り除いて本文だけにする。画面では level/summary を別に出すため */
export function stripVerdictBlock(text: string): string {
  return text.replace(/^\s*```json\s*\n[\s\S]*?```\s*/, "").trim();
}

/** tmp/verify-<goal>.json を読む。無ければ null。results は観点ごとの判定、
 * missing は計画にあって結果が無い観点（未実行か判定不能）。
 * currentDiffHash（今の差分の指紋）を渡すと、判定が今の差分のものかを比べる */
export function readVerify(root: string, goalId: string, currentDiffHash?: string | null): VerifySummary | null {
  const path = join(root, ".graphhopper", "tmp", `verify-${goalId}.json`);
  if (!existsSync(path)) return null;
  try {
    const v = readJson(path) as {
      diff_hash?: unknown;
      plan?: { entries?: { id?: unknown }[] };
      results?: {
        lens?: unknown;
        level?: unknown;
        summary?: unknown;
        body?: unknown;
      }[];
    };
    const angles: VerifyAngle[] = [];
    for (const r of v.results ?? []) {
      const lens = str(r.lens);
      const level = str(r.level);
      if (!lens || !level) continue;
      angles.push({
        lens,
        level: level === "clean" || level === "drift" ? level : "unknown",
        summary: str(r.summary) ?? "",
        body: str(r.body) ? stripVerdictBlock(str(r.body)!) : null,
      });
    }
    // 計画（plan.entries）にあって結果が無い観点（まだ走っていない・判定できなかった）
    const missing = (v.plan?.entries ?? [])
      .map((e) => str(e.id))
      .filter((id): id is string => id !== null && !angles.some((a) => a.lens === id))
      .map((lens) => ({ lens, reason: "この diff では判定が無い（未実行か判定不能）" }));
    let at: string | null = null;
    try {
      at = new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      at = null;
    }
    // 判定した差分と今の差分が違えば「前の差分の判定」。比べられなければ null
    const judged = str(v.diff_hash);
    const currentDiff = judged && currentDiffHash ? judged === currentDiffHash : null;
    return { at, angles, missing, currentDiff };
  } catch {
    return null;
  }
}

/** 1 リポジトリ分の goal を集める */
export function readRepo(repoPath: string): { goals: BoardGoal[]; errors: string[] } {
  const repo = resolve(repoPath);
  const repoName = basename(repo);
  const dir = join(repo, ".graphhopper");
  const errors: string[] = [];
  const goalsFile = join(dir, "goals.json");
  let rawGoals: unknown[] = [];
  try {
    rawGoals = asArray(readJson(goalsFile));
  } catch (e) {
    // 読めない（壊れている）ものだけ知らせる。ファイルが無いのは「まだ goal が無い」で正常
    if (existsSync(goalsFile)) errors.push(`${repoName}: goals.json が読めない（${(e as Error).message}）`);
    return { goals: [], errors };
  }
  if (rawGoals.length === 0) {
    const raw = readJson(goalsFile);
    if (!Array.isArray(raw) && !Array.isArray((raw as { goals?: unknown } | null)?.goals)) {
      errors.push(`${repoName}: goals.json の形が想定と違う`);
    }
  }
  let state: { goal_id?: unknown; phase?: unknown; stash_diff_hash?: unknown } = {};
  try {
    state = readJson(join(dir, "state.json")) as typeof state;
  } catch {
    // state.json は無いこともある（goal が全部終わった後など）
  }
  const activeId = str(state.goal_id);
  // 今の差分の指紋（最後に退避した diff）。検証結果が今の差分のものか比べるのに使う
  const currentDiffHash = str(state.stash_diff_hash);
  const events = readHistory(join(dir, "history.jsonl"));
  const out: BoardGoal[] = [];
  for (const g of rawGoals) {
    const id = str((g as { id?: unknown }).id);
    if (!id) continue;
    const status = statusOf(g);
    const goalEvents = events.filter((e) => str(e.goal) === id);
    const last = goalEvents[goalEvents.length - 1];
    const verify = readVerify(repo, id, currentDiffHash);
    if (!verify && existsSync(join(dir, "tmp", `verify-${id}.json`))) {
      errors.push(`${repoName}: ${id} の検証結果が読めない`);
    }
    out.push({
      repo,
      repoName,
      id,
      title: str((g as { title?: unknown }).title) ?? "(無題)",
      status,
      phase: activeId === id ? str(state.phase) : null,
      createdAt: str((g as { created_at?: unknown }).created_at),
      doneAt: str((g as { done_at?: unknown }).done_at),
      lastEventAt: last ? str(last.ts) : null,
      lastEventType: last ? str(last.type) : null,
      // 止まった理由は止まっている goal にだけ付ける（再開済みの goal に古い理由を出さない）
      stop: status === "paused" ? findStop(goalEvents) : null,
      verify,
      error: null,
    });
  }
  return { goals: out, errors };
}

/** 詳細に出す 1 goal 分の history（時系列・そのまま） */
export function readGoalEvents(root: string, goalId: string): Record<string, unknown>[] {
  return readHistory(join(root, ".graphhopper", "history.jsonl"))
    .filter((e) => str(e.goal) === goalId)
    .map((e) => e as Record<string, unknown>);
}

/** 決定記録の本文。無ければ null */
export function readDesign(root: string, goalId: string): string | null {
  const p = join(root, ".graphhopper", "plans", `${goalId}.md`);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

export function readBoard(repoPaths: string[]): Board {
  const goals: BoardGoal[] = [];
  const errors: string[] = [];
  const repos: { path: string; error: string | null }[] = [];
  for (const p of repoPaths) {
    const r = readRepo(p);
    repos.push({ path: p, error: r.errors[0] ?? null });
    errors.push(...r.errors);
    goals.push(...r.goals);
  }
  return { repos, goals, errors };
}

const STATUS_ORDER: Record<GoalStatus, number> = { active: 0, paused: 1, done: 2 };

function timeOf(g: BoardGoal): number {
  const t = g.lastEventAt ?? g.doneAt ?? g.createdAt;
  const n = t ? Date.parse(t) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

/** 並び: 進行中 → 止まっている → 完了。各中は最後に動いた順（新しい方が上） */
export function sortGoals(goals: BoardGoal[]): BoardGoal[] {
  return [...goals].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    return timeOf(b) - timeOf(a);
  });
}

/** done を隠す（既定）。--all のときはそのまま */
export function visibleGoals(goals: BoardGoal[], showDone: boolean): BoardGoal[] {
  return sortGoals(showDone ? goals : goals.filter((g) => g.status !== "done"));
}

/** paused のまま 3 日以上動いていない goal は「古い」 */
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;

export function isStale(g: BoardGoal, now: number): boolean {
  if (g.status !== "paused") return false;
  const t = timeOf(g);
  // 日時が全く無い paused は「いつ止まったか分からない」ので古い扱いにする
  if (t === 0) return true;
  return now - t >= STALE_MS;
}
