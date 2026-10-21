/**
 * graphhopper の TUI 表示用スナップショット。
 *
 * TUI plugin は描画だけを担い、ここで `.graphhopper/` 配下のファイルを Snapshot に正規化する。
 * 読み取り専用・依存は node stdlib のみ（src/state.ts と同じ方針）。
 * state.json は tmp+rename で原子的に更新され、JSON は state.ts のキャッシュ付き readJson が
 * 直近の正常値を保持するため、書き込み途中の読み取りで表示が消えることはない。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  PHASES,
  type EntryRoute,
  type GoalStatus,
  type Phase,
  normalizeEntryRoute,
  readConfig,
  readJson,
  readTodosStatus,
  todoProgressView,
} from "./state";
import { formatTodoChip } from "./todos";

export type { EntryRoute, GoalStatus, Phase };

export type PhaseStatus = "done" | "current" | "pending";

export interface SnapshotVerdict {
  level: "clean" | "drift";
  reason: string;
  /** 判定時刻（ISO）。鮮度表示に使う */
  at: string | null;
}

export interface SnapshotHistoryEntry {
  ts: string;
  type: string;
  detail: string;
}

export interface Snapshot {
  /** repo のルート（表示用） */
  root: string;
  /** 表示用の短い repo 名 */
  repo: string;
  goalID: string;
  title: string;
  goalStatus: GoalStatus;
  phase: Phase;
  /** 入口 route。null は full 未判定（legacy） */
  entryRoute: EntryRoute | null;
  /** light/advised から full へ昇格済みか */
  escalated: boolean;
  sessionID: string | null;
  failStreak: number;
  /** モデルカスケード。null＝未適用 */
  cascade: { level: "baseline" | "escalated"; model: string | null; children: number } | null;
  /** router gate が最後に記録した差分規模（route 分岐の根拠。check 時点のスナップショット） */
  diff: {
    lines: number | null;
    threshold: number;
    route: "advisor" | "polish" | null;
    checkedAt: string | null;
  };
  loop: { stopCount: number; stopMax: number; blocked: boolean; streak: number };
  verifier: SnapshotVerdict | null;
  critic: SnapshotVerdict | null;
  /** 進捗タスク。null = タスク無し。unreadable=true はストア不読（進捗不明） */
  tasks: {
    total: number;
    done: number;
    open: number;
    unreadable: boolean;
    invalidCount: number;
  } | null;
  evalCmd: string | null;
  notes: string;
  updatedAt: string;
  history: SnapshotHistoryEntry[];
}

const DEFAULT_HISTORY_LIMIT = 8;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBoolean(v: unknown): boolean {
  return v === true;
}

/** 値が PHASES のいずれかなら Phase、そうでなければ null */
function parseCascade(v: unknown): Snapshot["cascade"] {
  const c = asRecord(v);
  const level = c?.level;
  if (!c || (level !== "baseline" && level !== "escalated")) return null;
  return {
    level,
    model: asString(c.model),
    children: Array.isArray(c.children) ? c.children.length : 0,
  };
}

/** "provider/model#variant" → 表示用の短い名前（model 部分だけ） */
export function shortModel(model: string | null): string {
  if (!model) return "";
  return (model.split("/").pop() ?? model).split("#")[0]!.replace(/^claude-/, "");
}

export function parsePhase(v: unknown): Phase | null {
  return typeof v === "string" && (PHASES as readonly string[]).includes(v) ? (v as Phase) : null;
}

/** 入口 route を正規化する（src/state.ts の実装を再利用。旧 A/B/C も受ける） */
export const parseEntryRoute = normalizeEntryRoute;

function parseVerdict(v: unknown): SnapshotVerdict | null {
  const r = asRecord(v);
  if (!r) return null;
  const level = asString(r.level);
  if (level !== "clean" && level !== "drift") return null;
  return { level, reason: asString(r.reason) ?? "", at: asString(r.at) };
}

/**
 * 進捗タスクの公開ビュー（state.todoProgressView の出力）から表示用の集計を作る。
 * ストア不読（unreadable）は「0 件」に潰さず、不読として出す。
 */
function parseTasks(raw: unknown): {
  total: number;
  done: number;
  open: number;
  unreadable: boolean;
  invalidCount: number;
} | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const unreadable = rec.unreadable === true;
  const total = asNumber(rec.total) ?? 0;
  if (!unreadable && total === 0) return null;
  return {
    total,
    done: asNumber(rec.done) ?? 0,
    open: asNumber(rec.open) ?? 0,
    unreadable,
    invalidCount: asNumber(rec.invalidCount) ?? 0,
  };
}

/** designing → implementing → polish のラダー。done は全項目 done として扱う */
export function phaseLadder(phase: Phase): { phase: Phase; status: PhaseStatus }[] {
  const steps = PHASES.filter((p): p is Exclude<Phase, "done"> => p !== "done");
  const currentIndex = phase === "done" ? steps.length : steps.indexOf(phase as Exclude<Phase, "done">);
  return steps.map((step, index) => ({
    phase: step,
    status: index < currentIndex ? "done" : index === currentIndex ? "current" : "pending",
  }));
}

/** history 1行を表示用に短縮する */
export function historyDetail(entry: Record<string, unknown>): string {
  const type = asString(entry.type) ?? "?";
  switch (type) {
    case "phase":
      return `${asString(entry.from) ?? "?"} → ${asString(entry.to) ?? "?"}`;
    case "goal_start":
    case "goal_resume":
      return asString(entry.title) ?? "";
    case "goal_complete": {
      const score = asNumber(entry.score);
      return score === null ? "" : `score ${score}`;
    }
    case "router_check":
      return `${asString(entry.route) ?? "?"} diff ${asNumber(entry.diff_lines) ?? "?"}`;
    case "verifier_verdict":
      return asString(entry.level) ?? "";
    case "critic_review_set":
      return asString(entry.level) ?? "";
    case "attempt":
      return `${asBoolean(entry.ok) ? "ok" : "fail"} streak ${asNumber(entry.fail_streak) ?? "?"}`;
    case "design_gate_block":
    case "design_doc_locked_block":
      return `${asString(entry.tool) ?? "?"} ${asString(entry.path) ?? ""}`.trim();
    case "hash_edit_applied":
      return asString(entry.path) ?? "";
    default:
      return "";
  }
}

/** history.jsonl の行を新しい順に limit 件まで SnapshotHistoryEntry にする */
export function parseHistory(lines: readonly string[], limit = DEFAULT_HISTORY_LIMIT): SnapshotHistoryEntry[] {
  const out: SnapshotHistoryEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 壊れた行は捨てる（履歴は表示専用）
    }
    const entry = asRecord(raw);
    if (!entry) continue;
    const type = asString(entry.type);
    if (!type) continue;
    out.push({ ts: asString(entry.ts) ?? "", type, detail: historyDetail(entry) });
  }
  return out;
}

/**
 * 読み込み済みの JSON 値から Snapshot を組み立てる（純関数）。
 *
 * goal の基準は `goals.active`（他経路と同じ）。goals.json 自体が無い場合だけ
 * `state.goal_id` にフォールバックする。これで clear 後に done goal が
 * 表示され続ける「ゴースト」を避ける。goal が無い・phase が不正なら null。
 */
export function buildSnapshot(input: {
  root: string;
  state: unknown;
  goals: unknown;
  config: unknown;
  history: readonly string[];
  historyLimit?: number;
  /** 進捗タスクストア（.graphhopper/todos/<goalId>.json の中身） */
  todos?: unknown;
}): Snapshot | null {
  const state = asRecord(input.state);
  if (!state) return null;

  const goals = asRecord(input.goals);
  const goalID = (input.goals === null ? asString(state.goal_id) : asString(goals?.active)) ?? null;
  if (!goalID) return null;

  const phase = parsePhase(state.phase);
  if (!phase) return null;

  const goalList = Array.isArray(goals?.goals) ? goals.goals : [];
  const goal = goalList.map(asRecord).find((g) => g && asString(g.id) === goalID);
  const rawStatus = asString(goal?.status);
  const goalStatus: GoalStatus = rawStatus === "done" || rawStatus === "paused" ? rawStatus : "active";

  const config = asRecord(input.config);
  const router = asRecord(state.router);

  const stopCount = asNumber(state.loop_stop_count) ?? 0;
  const stopMax = asNumber(config?.loop_stop_max) ?? 3;

  const rawRouterRoute = asString(router?.route);
  const routerRoute = rawRouterRoute === "advisor" || rawRouterRoute === "polish" ? rawRouterRoute : null;

  return {
    root: input.root,
    repo: basename(input.root),
    goalID,
    title: asString(goal?.title) ?? "",
    goalStatus,
    phase,
    entryRoute: parseEntryRoute(state.entry_route),
    escalated: asString(state.escalated_at) !== null,
    sessionID: asString(state.session_id),
    failStreak: asNumber(state.fail_streak) ?? 0,
    cascade: parseCascade(state.cascade),
    diff: {
      lines: asNumber(router?.diff_lines),
      threshold: asNumber(config?.router_threshold_lines) ?? 400,
      route: routerRoute,
      checkedAt: asString(router?.checked_at),
    },
    loop: {
      stopCount,
      stopMax,
      blocked: stopMax > 0 && stopCount >= stopMax,
      streak: asNumber(state.loop_streak) ?? 0,
    },
    verifier: parseVerdict(state.last_verifier),
    critic: parseVerdict(state.critic_review),
    tasks: parseTasks(input.todos),
    evalCmd: asString(state.eval_cmd),
    notes: asString(state.notes) ?? "",
    updatedAt: asString(state.updated_at) ?? "",
    history: parseHistory(input.history, input.historyLimit ?? DEFAULT_HISTORY_LIMIT),
  };
}

const HISTORY_TAIL_BYTES = 64 * 1024;

/** append-only の history.jsonl から末尾だけ読む（行数に比例した I/O を避ける） */
function readTail(path: string, limit = HISTORY_TAIL_BYTES): string | null {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - limit);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * `.graphhopper/` を読み、表示用 Snapshot を返す。読めない・不正なら null。
 * JSON は state.ts のキャッシュ付き readJson（直近の正常値を保持）を使い、
 * config はグローバル既定とプロジェクト上書きをマージした readConfig を使う。
 */
export function loadSnapshot(root: string, opts?: { historyLimit?: number }): Snapshot | null {
  const dir = join(root, ".graphhopper");
  const goalsRaw = readJson<unknown>(join(dir, "goals.json"), null);
  const goalID =
    (asRecord(goalsRaw)?.active as string | undefined) ??
    (asString(asRecord(readJson<unknown>(join(dir, "state.json"), null))?.goal_id) ??
      undefined);
  return buildSnapshot({
    root,
    state: readJson<unknown>(join(dir, "state.json"), null),
    goals: goalsRaw,
    config: readConfig(root),
    history: (readTail(join(dir, "history.jsonl")) ?? "").split("\n"),
    historyLimit: opts?.historyLimit,
    todos: goalID ? todoProgressView(readTodosStatus(root, goalID)) : null,
  });
}

/** フッター用の1行チップ（サイドバーが隠れていても見える面） */
export function formatChip(snapshot: Snapshot): string {
  const loop = snapshot.loop.blocked ? `·!loop` : snapshot.failStreak > 0 ? `·f${snapshot.failStreak}` : "";
  const diff = snapshot.diff.lines === null ? "" : `·Δ${snapshot.diff.lines}`;
  const c = snapshot.cascade;
  const model = c?.level === "escalated" ? `·↑${shortModel(c.model)}` : "";
  const t = snapshot.tasks;
  const chip = !t
    ? null
    : t.unreadable
      ? "✓?"
      : formatTodoChip({ total: t.total, done: t.done });
  const tasks = chip ? `·${chip}` : "";
  return `${snapshot.phase}${diff}${loop}${tasks}${model}`;
}

/** 判定時刻からの経過を 1〜2 文字の相対表記にする（鮮度の目安） */
export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** 表示幅に収める。max 以下ならそのまま、超えたら末尾を省略記号にする */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max === 1) return "…";
  return chars.slice(0, max - 1).join("") + "…";
}
