/**
 * herdr への操作（ワークスペースの一覧・focus・作成）。CLI をそのまま呼ぶ。
 * 実行関数は注入できるようにして、テストでは herdr を起動しない。
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface HerdrWorkspace {
  id: string;
  cwd: string | null;
  label: string | null;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[]) => RunResult;

const ID_KEYS = ["workspace_id", "id"];
const PATH_KEYS = ["cwd", "root_path", "worktree_path", "path", "directory"];
const LABEL_KEYS = ["label", "name", "title"];

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** `herdr workspace list` の JSON からワークスペースを取り出す。
 * 応答の入れ子（result.workspaces など）が変わっても拾えるよう、木を歩いて形で判定する */
export function parseWorkspaceList(text: string): HerdrWorkspace[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  const out: HerdrWorkspace[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || !v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const id = pick(o, ID_KEYS);
    const cwd = pick(o, PATH_KEYS);
    // cwd を持つ object だけをワークスペースと見なす（id だけの入れ子を弾く）
    if (id && cwd && !seen.has(id)) {
      seen.add(id);
      out.push({ id, cwd, label: pick(o, LABEL_KEYS) });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(root, 0);
  return out;
}

function norm(p: string): string {
  const r = resolve(p);
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

/** repoPath と同じワークスペースを優先。無ければ「その下」「その上」の順に近いものを選ぶ
 * （amu-repos のような親フォルダで開いたワークスペースも拾う） */
export function findWorkspace(list: HerdrWorkspace[], repoPath: string): HerdrWorkspace | null {
  const repo = norm(repoPath);
  const ranked: { ws: HerdrWorkspace; rank: number; distance: number }[] = [];
  for (const ws of list) {
    if (!ws.cwd) continue;
    const cwd = norm(ws.cwd);
    if (cwd === repo) ranked.push({ ws, rank: 0, distance: 0 });
    else if (cwd.startsWith(`${repo}/`)) ranked.push({ ws, rank: 1, distance: cwd.length - repo.length });
    else if (repo.startsWith(`${cwd}/`)) ranked.push({ ws, rank: 2, distance: repo.length - cwd.length });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
  return ranked[0]?.ws ?? null;
}

export interface MoveResult {
  action: "focused" | "created" | "failed";
  id?: string;
  message: string;
}

/** 既存のワークスペースへ移る。無ければ作って移る（opencode は起動しない） */
export function moveToRepo(
  repoPath: string,
  repoName: string,
  run: Runner,
): MoveResult {
  const listed = run(["workspace", "list"]);
  if (listed.status === 0) {
    const hit = findWorkspace(parseWorkspaceList(listed.stdout), repoPath);
    if (hit) {
      const focused = run(["workspace", "focus", hit.id]);
      if (focused.status === 0) return { action: "focused", id: hit.id, message: `${hit.label ?? repoName} に移りました` };
      return { action: "failed", message: `移れませんでした: ${firstLine(focused.stderr)}` };
    }
  }
  const created = run(["workspace", "create", "--cwd", repoPath, "--label", repoName, "--focus"]);
  if (created.status !== 0) {
    const listNote = listed.status === 0 ? "" : `（一覧も取れない: ${firstLine(listed.stderr)}）`;
    return { action: "failed", message: `作れませんでした${listNote}: ${firstLine(created.stderr)}` };
  }
  const id = parseCreatedId(created.stdout) ?? undefined;
  return { action: "created", ...(id ? { id } : {}), message: `${repoName} を開いて移りました` };
}

/** `workspace create` の応答から id を拾う（形が変わっても木を歩いて workspace_id を探す） */
export function parseCreatedId(text: string): string | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const direct = pick((root as { result?: { workspace?: Record<string, unknown> } })?.result?.workspace ?? {}, ID_KEYS);
  if (direct) return direct;
  let found: string | null = null;
  const walk = (v: unknown, depth: number): void => {
    if (found || depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const id = pick(o, ID_KEYS);
    if (id) {
      found = id;
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(root, 0);
  return found;
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").trim() || "理由不明";
}
