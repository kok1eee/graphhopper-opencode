/** compaction-store の unit test（design g-mvqa9uiu）。tmp に sqlite DB を作る。 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestSummary,
  opencodeDbPath,
  SUMMARY_MAX_CHARS,
  truncateSummary,
} from "./compaction-store";

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-compact-"));
  return join(dir, "opencode.db");
}

function makeDb(path: string, rows: { sid: string; ms: number; data: unknown }[], wal = false): void {
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE session_message (
    id text primary key, session_id text not null, type text not null, seq integer,
    time_created integer not null, time_updated integer, data text not null)`);
  let i = 0;
  const ins = db.prepare(
    "insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?,?,'compaction',?,?,?,?)",
  );
  for (const r of rows) {
    i += 1;
    ins.run(`m${i}`, r.sid, i, r.ms, r.ms, JSON.stringify(r.data));
  }
  db.close();
}

const done = (summary: string, extra: Record<string, unknown> = {}) => ({
  status: "completed",
  reason: "auto",
  model: { providerID: "claude-oauth", id: "claude-opus-5-5" },
  summary,
  time: { created: 1793080902544 },
  ...extra,
});

describe("latestSummary", () => {
  test("最新の completed を返す（model/at/reason 付き）", () => {
    const p = tmpDb();
    makeDb(p, [
      { sid: "s1", ms: 1000, data: done("古い要約") },
      { sid: "s1", ms: 2000, data: done("新しい要約") },
      { sid: "s2", ms: 3000, data: done("別セッション") },
    ]);
    const r = latestSummary("s1", { dbPath: p })!;
    expect(r.text).toBe("新しい要約");
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.at).toBe(new Date(1793080902544).toISOString());
    expect(r.reason).toBe("auto");
  });

  test("failed と空 summary を飛ばす", () => {
    const p = tmpDb();
    makeDb(p, [
      { sid: "s1", ms: 1000, data: done("生きている要約") },
      { sid: "s1", ms: 2000, data: { status: "failed", summary: "" } },
      { sid: "s1", ms: 3000, data: { status: "completed", summary: "   " } },
    ]);
    expect(latestSummary("s1", { dbPath: p })?.text).toBe("生きている要約");
  });

  test("直近10件が全部 failed なら null（11件目は見ない）", () => {
    const p = tmpDb();
    const rows: { sid: string; ms: number; data: unknown }[] = [
      { sid: "s1", ms: 1, data: done("古すぎる") },
    ];
    for (let i = 0; i < 10; i += 1) {
      rows.push({ sid: "s1", ms: 100 + i, data: { status: "failed" } });
    }
    makeDb(p, rows);
    expect(latestSummary("s1", { dbPath: p })).toBeNull();
  });

  test("該当なし・DB無し・壊れた data は null", () => {
    const p = tmpDb();
    makeDb(p, [{ sid: "s1", ms: 1, data: done("x") }]);
    expect(latestSummary("other", { dbPath: p })).toBeNull();
    expect(latestSummary("s1", { dbPath: join(tmpdir(), "no-such-dir", "x.db") })).toBeNull();
    const p2 = tmpDb();
    makeDb(p2, [{ sid: "s1", ms: 1, data: {} }]);
    expect(latestSummary("s1", { dbPath: p2 })).toBeNull();
  });

  test("WAL モードの DB でも readonly で読める", () => {
    const p = tmpDb();
    makeDb(p, [{ sid: "s1", ms: 1, data: done("wal") }], true);
    expect(latestSummary("s1", { dbPath: p })?.text).toBe("wal");
  });

  test("sessionID 空は null", () => {
    expect(latestSummary("")).toBeNull();
  });
});

describe("truncateSummary", () => {
  test("上限以下はそのまま", () => {
    expect(truncateSummary("短い")).toBe("短い");
  });

  test("長い場合は先頭と末尾を残して中略を入れる", () => {
    const text = `HEAD${"a".repeat(20000)}TAIL`;
    const out = truncateSummary(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("中略");
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 40);
  });
});

describe("opencodeDbPath", () => {
  test("実在する override を最優先し、無ければ実在する DB にフォールバックする", () => {
    const p = tmpDb();
    makeDb(p, []);
    expect(opencodeDbPath(p)).toBe(p);
    // 存在しない override は無視される（null か、実在する既定パス）
    const fallback = opencodeDbPath("/nope/none.db");
    expect(fallback === null || fallback.endsWith("/opencode/opencode.db")).toBe(true);
  });
});
