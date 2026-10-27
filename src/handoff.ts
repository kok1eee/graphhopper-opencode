/**
 * handoff メモ（design g-mvq907g4）。
 *
 * 会話が長引く前に「今どこまで進んだか」を .graphhopper/HANDOFF.md に書き出し、
 * 新しいセッションがそれを読んで再開できるようにする。
 *
 * 原則: **正は state**。メモは state から機械生成した写像であり、
 * load は state を読み直して再開する（メモは文脈提示とズレ警告にだけ使う）。
 * LLM 生成はしない（捏造・トークン消費を避ける）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectivePhaseAction, goalResumeContext } from "./gate";
import * as state from "./state";

export const HANDOFF_FILE = "HANDOFF.md";

export function handoffPath(root: string): string {
  return join(root, ".graphhopper", HANDOFF_FILE);
}

/** メモの front matter（機械可読部）。staleness 判定の材料。 */
export interface HandoffMeta {
  goal_id: string;
  goal_title: string;
  status: string;
  phase: string;
  /** true = まだ load されていない */
  pending: boolean;
  written_at: string;
  /** write したセッション。このセッションには load 案内を出さない */
  written_by: string;
  /** write 時点の state.updated_at */
  state_updated_at: string;
  /** タスク進捗の指紋（done/total|open id+status の sha 風ハッシュ） */
  todo_sig: string;
  /** design doc の mtime(ISO)。無ければ空 */
  design_mtime: string;
  /** VCS HEAD commit id。取得できなければ空 */
  vcs_head: string;
  /** write 時点の history 件数 */
  history_count: string;
}

export interface HandoffMemo {
  meta: HandoffMeta;
  body: string;
  /** 生テキスト（front matter 込み） */
  raw: string;
}

const FIELDS: (keyof HandoffMeta)[] = [
  "goal_id",
  "goal_title",
  "status",
  "phase",
  "pending",
  "written_at",
  "written_by",
  "state_updated_at",
  "todo_sig",
  "design_mtime",
  "vcs_head",
  "history_count",
];

function emptyMeta(): HandoffMeta {
  return {
    goal_id: "",
    goal_title: "",
    status: "",
    phase: "",
    pending: false,
    written_at: "",
    written_by: "",
    state_updated_at: "",
    todo_sig: "",
    design_mtime: "",
    vcs_head: "",
    history_count: "",
  };
}

/** front matter を組み立てる。値は1行に収まるよう改行を潰す。 */
function renderFront(meta: HandoffMeta): string {
  const one = (s: string) => s.replace(/\r?\n/g, " ").trim();
  return ["---", ...FIELDS.map((k) => `${k}: ${one(String(meta[k]))}`), "---"].join("\n");
}

/** メモをパースする。front matter が無い/壊れている場合は null。 */
export function parseMemo(raw: string): HandoffMemo | null {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const meta = emptyMeta();
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim() as keyof HandoffMeta;
    if (!FIELDS.includes(k)) continue;
    const v = line.slice(idx + 1).trim();
    if (k === "pending") meta.pending = v === "true";
    else meta[k] = v;
  }
  if (!meta.goal_id) return null;
  return { meta, body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""), raw };
}

export function readHandoff(root: string): HandoffMemo | null {
  const p = handoffPath(root);
  if (!existsSync(p)) return null;
  try {
    return parseMemo(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 進捗指紋。id と status の組を並べた安定文字列（暗号強度は不要）。 */
export function todoSignature(root: string, goalId: string): string {
  const loaded = state.readTodosStatus(root, goalId);
  if (!loaded.valid) return "invalid";
  const items = loaded.store.items;
  if (items.length === 0) return "0/0|empty";
  const done = items.filter((i) => i.status === "completed").length;
  const key = items.map((i) => `${i.id}:${i.status}`).join(",");
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `${done}/${items.length}|${h.toString(16)}`;
}

function designMtime(root: string, goalId: string): string {
  try {
    return statSync(state.planPath(root, goalId)).mtime.toISOString();
  } catch {
    return "";
  }
}

/** goal に紐づく history。旧レコードは goal 欠落があるため undefined を許容する。 */
function historyForGoal(root: string, goalId: string): state.HistoryRecord[] {
  return state.readHistory(root).filter((h) => {
    const g = (h as { goal?: unknown }).goal;
    return g === undefined || g === goalId;
  });
}

export interface RenderOpts {
  sessionID?: string;
  /** VCS HEAD（plugin 側で取得。テストでは省略） */
  vcsHead?: string | null;
  /** 未コミットの有無（plugin 側で取得。省略時は「不明」） */
  dirty?: boolean | null;
  /** pause 前に取得した再開文脈（pause 後は goalResumeContext が null を返すため） */
  resumeContext?: string | null;
  now?: Date;
}

/** 現在の state からメモ全文を生成する。goal が無ければ null。 */
export function renderHandoff(root: string, opts: RenderOpts = {}): string | null {
  const active = state.getActive(root);
  if (!active) return null;
  const { goal, state: s } = active;
  const history = historyForGoal(root, goal.id);
  const store = state.readTodosStatus(root, goal.id);
  const open = store.valid
    ? store.store.items
        .filter((i) => i.status === "pending" || i.status === "in_progress")
        .slice(0, 20)
    : [];
  const now = opts.now ?? new Date();
  const meta: HandoffMeta = {
    goal_id: goal.id,
    goal_title: goal.title,
    status: goal.status,
    phase: s.phase,
    pending: true,
    written_at: now.toISOString(),
    written_by: opts.sessionID ?? "",
    state_updated_at: s.updated_at,
    todo_sig: todoSignature(root, goal.id),
    design_mtime: designMtime(root, goal.id),
    vcs_head: opts.vcsHead ?? "",
    history_count: String(history.length),
  };
  const recent = history.slice(-5).map((h) => `  - ${summarizeEvent(h)}`);
  const body = [
    `# handoff: ${goal.title} (${goal.id})`,
    "",
    "このメモは graphhopper の state から機械生成したスナップショット。",
    "**正は state**（.graphhopper/state.json・goals.json・todos/）。メモと食い違ったら state に従う。",
    "",
    "## 状態",
    "",
    `- goal: ${goal.status} / phase: ${s.phase} / entry_route: ${s.entry_route ?? "(未判定)"}`,
    `- difficulty: ${s.difficulty ?? "(未判定)"} / cascade: ${s.cascade?.level ?? "(none)"}${s.cascade?.reason ? `（${s.cascade.reason}）` : ""}`,
    `- eval_cmd: ${s.eval_cmd ?? "(未設定)"}`,
    `- fail_streak: ${s.fail_streak} / loop: stop_count=${s.loop_stop_count}`,
    s.notes ? `- notes: ${s.notes}` : null,
    "",
    "## 次のアクション",
    "",
    effectivePhaseAction(s.phase, s.entry_route),
    "",
    "## タスク",
    "",
    state.todoSummaryLine(root, goal.id) ?? "tasks: (なし)",
    ...(open.length ? ["", "未完了:", ...open.map((i) => `  - ${i.id}: ${i.text}`)] : []),
    "",
    "## レビュー",
    "",
    s.last_verifier
      ? `- verifier: ${s.last_verifier.level}（${s.last_verifier.reason}） lens=${s.last_verifier.lens.join(",")} at=${s.last_verifier.at}`
      : "- verifier: (未実行)",
    s.critic_review ? `- critic: ${s.critic_review.level}（${s.critic_review.reason}）` : "- critic: (未実行)",
    s.advisor_consult ? `- advisor: ${s.advisor_consult.summary}` : null,
    s.oracle_consult ? `- oracle: ${s.oracle_consult.summary}` : null,
    "",
    "## 参照ファイル",
    "",
    `- design: .graphhopper/plans/${goal.id}.md`,
    state.planLogExists(root, goal.id) ? `- log: .graphhopper/plans/${goal.id}.log.md` : null,
    `- todos: .graphhopper/todos/${goal.id}.json`,
    diffStashExists(root, goal.id) ? `- diff stash: .graphhopper/tmp/gh-verify-${goal.id}.txt` : null,
    "",
    "## VCS",
    "",
    `- HEAD: ${opts.vcsHead || "(不明)"}`,
    `- 未コミット: ${opts.dirty === null || opts.dirty === undefined ? "(不明)" : opts.dirty ? "あり" : "なし"}`,
    "",
    "## 直近の履歴",
    "",
    ...(recent.length ? recent : ["  - (記録なし)"]),
    "",
    "## 再開手順",
    "",
    "1. `graphhopper_handoff` (action: \"load\") を呼ぶ（goal をこのセッションに bind し直す）",
    "2. `graphhopper_status` で phase とタスクを確認する",
    "3. 上の「次のアクション」から続行する。design は designing 終了後は不変（変更は log に追記）",
    "",
    "```",
    opts.resumeContext ?? goalResumeContext(root, { includeLoop: true }) ?? "(state に active goal なし)",
    "```",
    "",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  return `${renderFront(meta)}\n\n${body}`;
}

function summarizeEvent(h: state.HistoryRecord): string {
  const e = h as Record<string, unknown>;
  const type = String(e.type ?? "?");
  const parts = Object.entries(e)
    .filter(([k]) => !["type", "goal", "ts", "deep_reason"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${type}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** メモを書き出す。goal が無ければ null（呼び出し側が error にする）。 */
export function writeHandoff(root: string, opts: RenderOpts = {}): string | null {
  const content = renderHandoff(root, opts);
  if (!content) return null;
  atomicWrite(handoffPath(root), content);
  return handoffPath(root);
}

/** pending だけ書き換える（load 成功時）。本文と他フィールドは保つ。 */
export function setPending(root: string, pending: boolean): boolean {
  const memo = readHandoff(root);
  if (!memo) return false;
  const meta = { ...memo.meta, pending };
  atomicWrite(handoffPath(root), `${renderFront(meta)}\n\n${memo.body}`);
  return true;
}

export function clearHandoff(root: string): boolean {
  const p = handoffPath(root);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
  } catch {
    return false;
  }
  return true;
}

export interface StalenessItem {
  key: string;
  memo: string;
  live: string;
  same: boolean;
}

function diffStashExists(root: string, goalId: string): boolean {
  try {
    return existsSync(join(root, ".graphhopper", "tmp", `gh-verify-${goalId}.txt`));
  } catch {
    return false;
  }
}

/** メモと現在 state のズレを列挙する。goal_id の不一致は呼び出し側が拒否に使う。
 * vcsHead は呼び出し側（shell を持つ plugin）が渡す。undefined は比較しない。 */
export function staleness(
  root: string,
  memo: HandoffMemo,
  opts: { vcsHead?: string | null } = {},
): StalenessItem[] {
  const active = state.getActive(root);
  if (!active) {
    return [{ key: "goal", memo: memo.meta.goal_id, live: "(none)", same: false }];
  }
  const { goal, state: s } = active;
  const historyCount = historyForGoal(root, goal.id).length;
  const live: Record<string, string> = {
    goal_id: goal.id,
    status: goal.status,
    phase: s.phase,
    state_updated_at: s.updated_at,
    todo_sig: todoSignature(root, goal.id),
    design_mtime: designMtime(root, goal.id),
    history_count: String(historyCount),
    ...(opts.vcsHead !== undefined && opts.vcsHead !== null ? { vcs_head: opts.vcsHead } : {}),
  };
  return Object.entries(live).map(([k, v]) => {
    const m = String(memo.meta[k as keyof HandoffMeta] ?? "");
    return { key: k, memo: m, live: v, same: m === v };
  });
}
