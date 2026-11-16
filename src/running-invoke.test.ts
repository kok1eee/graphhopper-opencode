import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  STALE_AFTER_MS,
  addRunningInvoke,
  countRunningInvokes,
  defaultIsAlive,
  parseRunningInvokes,
  readRunningInvokeCount,
  recordInvokeEnd,
  recordInvokeStart,
  removeRunningInvoke,
  runningInvokesPath,
} from "./running-invoke";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gh-running-"));
  roots.push(root);
  return root;
}

const entry = (id: string, startedAt = new Date().toISOString(), pid = process.pid) => ({
  id,
  pid,
  started_at: startedAt,
});

describe("running-invoke: 純粋ロジック", () => {
  test("追加は冪等で、同じ id は置き換える", () => {
    const a = addRunningInvoke({ entries: [] }, entry("a"));
    const b = addRunningInvoke(a, entry("a"));
    expect(b.entries).toHaveLength(1);
    const c = addRunningInvoke(b, entry("b"));
    expect(c.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("削除は無い id でも壊れない", () => {
    const file = { entries: [entry("a")] };
    expect(removeRunningInvoke(file, "z").entries).toHaveLength(1);
    expect(removeRunningInvoke(file, "a").entries).toHaveLength(0);
  });

  test("pid が死んでいる entry は数えない", () => {
    const now = Date.now();
    const file = { entries: [entry("alive"), entry("dead")] };
    expect(countRunningInvokes(file, now, () => true)).toBe(2);
    expect(countRunningInvokes(file, now, () => false)).toBe(0);
  });

  test("古すぎる entry（310 秒超）は数えない", () => {
    const now = Date.now();
    const old = new Date(now - STALE_AFTER_MS - 1).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    const file = { entries: [entry("old", old), entry("fresh", fresh)] };
    expect(countRunningInvokes(file, now, () => true)).toBe(1);
  });

  test("壊れた JSON・不正な entry は空として扱う", () => {
    expect(parseRunningInvokes("{")).toEqual({ entries: [] });
    expect(parseRunningInvokes(JSON.stringify({ entries: [{ id: "x", pid: "no" }] }))).toEqual({ entries: [] });
    expect(
      parseRunningInvokes(JSON.stringify({ entries: [{ id: "x", pid: 1, started_at: "now" }] })),
    ).toEqual({ entries: [{ id: "x", pid: 1, started_at: "now" }] });
  });

  test("defaultIsAlive は自 pid を生存とみなす", () => {
    expect(defaultIsAlive(process.pid)).toBe(true);
    expect(defaultIsAlive(0)).toBe(false);
    expect(defaultIsAlive(-1)).toBe(false);
  });
});

describe("running-invoke: ファイル経由（直列キュー）", () => {
  test("start → count → end で 0 に戻る", async () => {
    const root = tmpRoot();
    await recordInvokeStart(root, entry("a"));
    expect(readRunningInvokeCount(root)).toBe(1);
    await recordInvokeEnd(root, "a");
    expect(readRunningInvokeCount(root)).toBe(0);
  });

  test("並行 2 件の start/end で取りこぼさない（read-modify-write の競合）", async () => {
    const root = tmpRoot();
    await Promise.all([recordInvokeStart(root, entry("a")), recordInvokeStart(root, entry("b"))]);
    expect(readRunningInvokeCount(root)).toBe(2);
    await Promise.all([recordInvokeEnd(root, "a"), recordInvokeEnd(root, "b")]);
    expect(readRunningInvokeCount(root)).toBe(0);
    const raw = JSON.parse(readFileSync(runningInvokesPath(root), "utf8")) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(0);
  });

  test("同じ id で 3 回 start しても 1 件（冪等）", async () => {
    const root = tmpRoot();
    await Promise.all([
      recordInvokeStart(root, entry("a")),
      recordInvokeStart(root, entry("a")),
      recordInvokeStart(root, entry("a")),
    ]);
    expect(readRunningInvokeCount(root)).toBe(1);
  });

  test("死んだ entry は次の書き込みで掃除される（溜めない）", async () => {
    const root = tmpRoot();
    /* 自分（生存）と、確実に死んでいる pid の entry を直接置く */
    const deadPid = 2 ** 22 + 12345;
    const now = new Date().toISOString();
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      runningInvokesPath(root),
      JSON.stringify({ entries: [entry("dead", now, deadPid), entry("alive", now)] }),
      "utf8",
    );
    await recordInvokeStart(root, entry("new"));
    const raw = JSON.parse(readFileSync(runningInvokesPath(root), "utf8")) as {
      entries: Array<{ id: string }>;
    };
    expect(raw.entries.map((e) => e.id).sort()).toEqual(["alive", "new"]);
  });

  test("壊れたファイルでも追加はできる（空から作り直す）", async () => {
    const root = tmpRoot();
    await recordInvokeStart(root, entry("seed"));
    writeFileSync(runningInvokesPath(root), "{ broken", "utf8");
    await recordInvokeStart(root, entry("a"));
    expect(readRunningInvokeCount(root)).toBe(1);
  });
});
