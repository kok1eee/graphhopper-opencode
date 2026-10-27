/**
 * compaction 要約の読み出し（design g-mvqa9uiu）。
 *
 * opencode は compact 時に要約を `session_message(type='compaction')` の
 * `data.summary` として保存する。生成済みなので読み出すだけならトークンを使わない。
 *
 * 重要: これは opencode の内部スキーマ。版が上がって変わったら null を返して
 * handoff を壊さない（黙って諦める）。要約は LLM 生成物であり、state ではない。
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 要約本文の上限（これを超えたら先頭と末尾を残して中略） */
export const SUMMARY_MAX_CHARS = 12000;
export const SUMMARY_HEAD_CHARS = 8000;
export const SUMMARY_TAIL_CHARS = 4000;
/** failed 行などを飛ばすため直近何件を見るか */
export const SCAN_ROWS = 10;

export interface CompactionSummary {
  text: string;
  /** 要約を書いたモデル（不明なら空） */
  model: string;
  /** ISO。不明なら空 */
  at: string;
  /** auto | manual */
  reason: string;
}

/** opencode の DB パス。存在しなければ null。 */
export function opencodeDbPath(override?: string | null): string | null {
  const candidates = [
    override ?? null,
    process.env["XDG_DATA_HOME"]
      ? join(process.env["XDG_DATA_HOME"], "opencode", "opencode.db")
      : null,
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** 先頭と末尾を残して切る（要約は時系列で末尾に直近の状態が入るため）。 */
export function truncateSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, SUMMARY_HEAD_CHARS);
  const tail = text.slice(-SUMMARY_TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n…（中略: ${omitted}文字）…\n\n${tail}`;
}

function toIso(v: unknown): string {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * 指定セッションの最新の completed な compaction 要約。
 * 失敗はすべて null（handoff を壊さない）。
 */
export function latestSummary(
  sessionID: string,
  opts: { dbPath?: string | null } = {},
): CompactionSummary | null {
  if (!sessionID) return null;
  const path = opencodeDbPath(opts.dbPath);
  if (!path) return null;
  let db: Database | null = null;
  try {
    /* readonly。常駐で握ると WAL checkpoint を妨げ得るので毎回閉じる */
    db = new Database(path, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 1000");
    } catch {
      // 古い sqlite でも読めればよい
    }
    const rows = db
      .query(
        `select time_created, data from session_message
         where type = 'compaction' and session_id = ?
         order by time_created desc limit ${SCAN_ROWS}`,
      )
      .all(sessionID) as { time_created: number; data: string }[];
    for (const row of rows) {
      let parsed: {
        status?: unknown;
        reason?: unknown;
        model?: { id?: unknown } | string;
        summary?: unknown;
        time?: { created?: unknown };
      };
      try {
        parsed = JSON.parse(row.data) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.status !== "completed") continue;
      const text = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!text) continue;
      const model =
        typeof parsed.model === "string"
          ? parsed.model
          : typeof parsed.model?.id === "string"
            ? parsed.model.id
            : "";
      return {
        text: truncateSummary(text),
        model,
        at: toIso(parsed.time?.created) || toIso(row.time_created),
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
