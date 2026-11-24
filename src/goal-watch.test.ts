import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWatchText,
  goalHistory,
  resetWatchMemory,
  WATCH_KEYS,
  WATCH_TAIL,
  watchGoal,
} from "./goal-watch";
import type { HistoryRecord } from "./state";
import type { DecisionLog } from "./decision";

const SAVED_KEY = process.env.LIQUID_API_KEY;
const setKey = (v: string | undefined) => {
  if (v === undefined) delete process.env.LIQUID_API_KEY;
  else process.env.LIQUID_API_KEY = v;
};

function root(): string {
  return mkdtempSync(join(tmpdir(), "gh-watch-"));
}

/** 常に yes（noul=0.9）を返す偽 fetch。呼び出し回数を数える */
function okFetch(probs: Record<string, number> = {}) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    const answers: Record<string, { noul: number }> = {};
    for (const k of WATCH_KEYS) answers[k] = { noul: probs[k] ?? 0.9 };
    return { ok: true, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

function rows(dir: string): DecisionLog[] {
  const p = join(dir, ".graphhopper", "decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DecisionLog);
}

const hist = (goal: string, n: number): HistoryRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    type: "eval_run",
    goal,
    ok: i % 2 === 0,
    fail_streak: 0,
    ts: `2026-11-24T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  })) as HistoryRecord[];

describe("buildWatchText（判定材料）", () => {
  test("その goal の直近 WATCH_TAIL 件だけを渡し、phase を添える", () => {
    const records = [...hist("g-a", 40), ...hist("g-b", 5)];
    const { text, count, fingerprint } = buildWatchText({
      goalID: "g-a",
      phase: "implementing",
      history: records,
    });
    expect(WATCH_TAIL).toBe(30);
    expect(count).toBe(WATCH_TAIL);
    expect(text).toContain("phase=implementing");
    expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(WATCH_TAIL);
    expect(text).toContain("g-a");
    expect(fingerprint.startsWith(`${WATCH_TAIL}:`)).toBe(true);
  });

  test("別 goal の記録は混ぜない", () => {
    const records = [...hist("g-a", 3), ...hist("g-b", 5)];
    expect(goalHistory(records, "g-a").length).toBe(3);
    expect(goalHistory(records, "g-a").every((r) => (r as { goal: string }).goal === "g-a")).toBe(true);
  });

  test("長い行は切る（goal_summary などで膨らませない）", () => {
    const long = [
      { type: "goal_summary", goal: "g-a", stage: "x".repeat(2000), ts: "t" },
    ] as unknown as HistoryRecord[];
    const { text } = buildWatchText({ goalID: "g-a", phase: "polish", history: long });
    const line = text.split("\n").find((l) => l.startsWith("- goal_summary"))!;
    expect(line.length).toBeLessThanOrEqual("- goal_summary ".length + 160);
  });

  test("自由文のフィールド（title・text・notes・path など）は材料に載せない（許可リスト）", () => {
    const leak = [
      {
        type: "goal_start",
        goal: "g-a",
        ts: "t1",
        title: "SECRET_TITLE",
        text: "SECRET_TEXT",
        notes: "SECRET_NOTES",
        path: "SECRET_PATH",
        reason: "SECRET_REASON",
        content: "SECRET_CONTENT",
        files: ["SECRET_FILE"],
        diff_lines: 12,
        ok: true,
        from: "designing",
        lens: ["cleanup"],
      },
    ] as unknown as HistoryRecord[];
    const { text } = buildWatchText({ goalID: "g-a", phase: "implementing", history: leak });
    expect(text).not.toContain("SECRET");
    expect(text).toContain('"diff_lines":12');
    expect(text).toContain('"ok":true');
    expect(text).toContain('"from":"designing"');
    expect(text).toContain('"lens":["cleanup"]');
  });

  test("記録が増えると指紋が変わる", () => {
    const a = buildWatchText({ goalID: "g-a", phase: "polish", history: hist("g-a", 3) });
    const b = buildWatchText({ goalID: "g-a", phase: "polish", history: hist("g-a", 4) });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("watchGoal（記録だけ。介入しない）", () => {
  test("判定モデルの答えを kind=watch で残す（probs・goal・delivered=false）", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const dir = root();
    const f = okFetch({ loop: 0.81, stall: 0.2, overscope: 0.05 });
    try {
      const r = await watchGoal({
        root: dir,
        goalID: "g-a",
        sessionID: "s1",
        phase: "implementing",
        history: hist("g-a", 5),
        fetchFn: f.fn,
      });
      expect(r.status).toBe("recorded");
      expect(r.probs).toEqual({ loop: 0.81, stall: 0.2, overscope: 0.05 });
      const w = rows(dir).filter((x) => x.kind === "watch");
      expect(w.length).toBe(1);
      expect(w[0]!.goal).toBe("g-a");
      expect(w[0]!.delivered).toBe(false);
      expect(w[0]!.probs).toEqual({ loop: 0.81, stall: 0.2, overscope: 0.05 });
      expect(w[0]!.result).toEqual(["loop=0.81", "stall=0.20", "overscope=0.05"]);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("記録が増えていなければ 2 回目は呼ばない", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const dir = root();
    const f = okFetch();
    try {
      const input = {
        root: dir,
        goalID: "g-a",
        sessionID: "s1",
        phase: "implementing" as const,
        history: hist("g-a", 5),
        fetchFn: f.fn,
      };
      expect((await watchGoal(input)).status).toBe("recorded");
      expect((await watchGoal(input)).status).toBe("no_change");
      expect(f.calls()).toBe(1);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("失敗しても記録だけ残して投げない。次の記録が増えるまで再試行しない", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const dir = root();
    let calls = 0;
    const fail = (async () => {
      calls += 1;
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;
    try {
      const base = {
        root: dir,
        goalID: "g-a",
        sessionID: "s1",
        phase: "polish" as const,
        fetchFn: fail,
      };
      expect((await watchGoal({ ...base, history: hist("g-a", 2) })).status).toBe("failed");
      expect((await watchGoal({ ...base, history: hist("g-a", 2) })).status).toBe("no_change");
      expect(calls).toBe(1);
      const w = rows(dir).filter((x) => x.kind === "watch");
      expect(w.length).toBe(1);
      expect(w[0]!.fallback).toBe(true);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("判定できない環境では呼ばない（記録もしない）", async () => {
    resetWatchMemory();
    setKey(undefined);
    const dir = root();
    const f = okFetch();
    try {
      const r = await watchGoal({
        root: dir,
        goalID: "g-a",
        sessionID: "s1",
        phase: "implementing",
        history: hist("g-a", 5),
        fetchFn: f.fn,
      });
      expect(r.status).toBe("skipped");
      expect(f.calls()).toBe(0);
      expect(rows(dir).length).toBe(0);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("記録が 0 件なら判定しない", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const f = okFetch();
    try {
      const r = await watchGoal({
        root: root(),
        goalID: "g-a",
        sessionID: "s1",
        phase: "implementing",
        history: [],
        fetchFn: f.fn,
      });
      expect(r.status).toBe("empty");
      expect(f.calls()).toBe(0);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("内部例外も 1 行残す（材料の組み立てに失敗しても投げない）", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const dir = root();
    const f = okFetch();
    try {
      const r = await watchGoal({
        root: dir,
        goalID: "g-a",
        sessionID: "s1",
        phase: "polish",
        history: 42 as unknown as HistoryRecord[],
        fetchFn: f.fn,
      });
      expect(r.status).toBe("failed");
      expect(r.reason).toContain("内部例外");
      const w = rows(dir).filter((x) => x.kind === "watch");
      expect(w.length).toBe(1);
      expect(w[0]!.fallback).toBe(true);
      expect(f.calls()).toBe(0);
    } finally {
      setKey(SAVED_KEY);
    }
  });

  test("history.jsonl から読む経路: 別 goal の書き込みだけでは呼ばず、この goal の記録が増えたら呼ぶ", async () => {
    resetWatchMemory();
    setKey("liquid_test");
    const dir = root();
    const f = okFetch();
    const st = await import("./state");
    try {
      st.recordEvent(dir, { type: "phase", goal: "g-a", from: "designing", to: "implementing" });
      const input = { root: dir, goalID: "g-a", sessionID: "s1", phase: "implementing" as const, fetchFn: f.fn };
      expect((await watchGoal(input)).status).toBe("recorded");
      /* ファイルが変わらない: 読まずに諦める */
      expect((await watchGoal(input)).status).toBe("no_change");
      /* 別 goal の書き込み: ファイルは変わるが、この goal の記録は同じ */
      st.recordEvent(dir, { type: "phase", goal: "g-b", from: "designing", to: "implementing" });
      expect((await watchGoal(input)).status).toBe("no_change");
      expect(f.calls()).toBe(1);
      /* この goal の記録が増えた */
      st.recordEvent(dir, { type: "phase", goal: "g-a", from: "implementing", to: "polish" });
      expect((await watchGoal(input)).status).toBe("recorded");
      expect(f.calls()).toBe(2);
    } finally {
      setKey(SAVED_KEY);
    }
  });
});
