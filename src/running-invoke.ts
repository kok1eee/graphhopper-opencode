/**
 * invoke の実行中一覧（design g-mwkfisl7 判断3）。
 *
 * TUI のチップは `.graphhopper/*.json` を読む方式なので、`gh-invoke` の実行数も
 * ファイル経由で共有する（プロセス境界に依存しない）。書き込みは plugin プロセス
 * だけが行い、同一プロセス内の並行 invoke（verifier の角度の並列実行）は
 * 直列キューで read-modify-write を直列化する。
 *
 * 純粋ロジック（add / remove / count）は IO を持たない。読み書きは下の 2 関数。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_TIMEOUT_MS } from "./invoke-limits";

/** 1 実行の記録。pid は残骸の判定に使う */
export interface RunningInvokeEntry {
  id: string;
  pid: number;
  /** ISO 8601 */
  started_at: string;
}

export interface RunningInvokesFile {
  entries: RunningInvokeEntry[];
}

/** これを過ぎた entry は数えない（invoke の上限 + 猶予。上限を変えたら自動で追従する） */
export const STALE_AFTER_MS = MAX_TIMEOUT_MS + 10_000;

export const RUNNING_INVOKES_FILE = "invoke-running.json";

export function runningInvokesPath(root: string): string {
  return join(root, ".graphhopper", RUNNING_INVOKES_FILE);
}

/** JSON を読む。壊れていても空として扱う（表示のためのファイルなので厳密にしない） */
export function parseRunningInvokes(raw: string): RunningInvokesFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries)) return { entries: [] };
    const out: RunningInvokeEntry[] = [];
    for (const e of entries) {
      const rec = e as Record<string, unknown> | null;
      if (!rec) continue;
      if (typeof rec["id"] !== "string") continue;
      if (typeof rec["pid"] !== "number") continue;
      if (typeof rec["started_at"] !== "string") continue;
      out.push({ id: rec["id"], pid: rec["pid"], started_at: rec["started_at"] });
    }
    return { entries: out };
  } catch {
    return { entries: [] };
  }
}

/** entry を足す。同じ id があれば置き換える（冪等） */
export function addRunningInvoke(
  file: RunningInvokesFile,
  entry: RunningInvokeEntry,
): RunningInvokesFile {
  return { entries: [...file.entries.filter((e) => e.id !== entry.id), entry] };
}

/** entry を消す。無ければそのまま */
export function removeRunningInvoke(
  file: RunningInvokesFile,
  id: string,
): RunningInvokesFile {
  return { entries: file.entries.filter((e) => e.id !== id) };
}

/** 実行中として数える entry。pid が死んでいる・古すぎる entry は落とす */
export function countRunningInvokes(
  file: RunningInvokesFile,
  now: number,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): number {
  return file.entries.filter((e) => {
    const started = Date.parse(e.started_at);
    if (!Number.isFinite(started)) return false;
    if (now - started > STALE_AFTER_MS) return false;
    return isAlive(e.pid);
  }).length;
}

/** pid が生きているか（EPERM は「居るが触れない」なので生存扱い） */
export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** 期限切れ・pid 死亡の entry を落とす（落ちた invoke の残骸を溜めない） */
export function pruneRunningInvokes(
  file: RunningInvokesFile,
  now: number,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): RunningInvokesFile {
  return {
    entries: file.entries.filter((e) => {
      const started = Date.parse(e.started_at);
      return Number.isFinite(started) && now - started <= STALE_AFTER_MS && isAlive(e.pid);
    }),
  };
}

/* ---------- IO（直列キュー＋原子的置換） ---------- */

function readRunningInvokesFile(path: string): RunningInvokesFile {
  try {
    if (!existsSync(path)) return { entries: [] };
    return parseRunningInvokes(readFileSync(path, "utf8"));
  } catch {
    return { entries: [] };
  }
}

/** 一時ファイルに書いて rename する（読み手が半端な JSON を見ない） */
function writeFileAtomic(path: string, file: RunningInvokesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, "utf8");
  renameSync(tmp, path);
}

/** 同一プロセスの書き込みを直列化するキュー */
let writeQueue: Promise<void> = Promise.resolve();

function enqueue(update: (file: RunningInvokesFile) => RunningInvokesFile, root: string): Promise<void> {
  const path = runningInvokesPath(root);
  const next = writeQueue
    .catch(() => {})
    .then(() => {
      /* 死んだ entry はここで掃除する（数え上げと寿命を揃える） */
      const before = pruneRunningInvokes(readRunningInvokesFile(path), Date.now());
      const after = update(before);
      /* 変化が無いなら書かない（不要な watch 発火を避ける） */
      if (JSON.stringify(before) !== JSON.stringify(after)) writeFileAtomic(path, after);
    });
  writeQueue = next.catch(() => {});
  return next;
}

/** 実行開始を記録する。失敗は握りつぶす（invoke 自体を止めない） */
export function recordInvokeStart(root: string, entry: RunningInvokeEntry): Promise<void> {
  return enqueue((file) => addRunningInvoke(file, entry), root).catch(() => {});
}

/** 実行終了を記録する。失敗は握りつぶす */
export function recordInvokeEnd(root: string, id: string): Promise<void> {
  return enqueue((file) => removeRunningInvoke(file, id), root).catch(() => {});
}

/** 表示用に現在の実行数を読む（TUI から呼ばれる） */
export function readRunningInvokeCount(
  root: string,
  now = Date.now(),
  isAlive: (pid: number) => boolean = defaultIsAlive,
): number {
  return countRunningInvokes(readRunningInvokesFile(runningInvokesPath(root)), now, isAlive);
}
