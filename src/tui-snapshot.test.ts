/**
 * TUI 表示用 Snapshot のパース・整形の単体テスト。
 * bun test で実行する: `bun test src/tui-snapshot.test.ts`
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  formatAge,
  formatChip,
  loadSnapshot,
  parseEntryRoute,
  parseHistory,
  parsePhase,
  phaseLadder,
  truncate,
  shortModel,
} from "./tui-snapshot";

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal_id: "g-test",
    session_id: "ses_1",
    phase: "implementing",
    notes: "wip",
    router: { baseline_rev: null, diff_lines: 12, route: "advisor", checked_at: null, deep: false, deep_reason: null },
    last_verifier: { level: "clean", reason: "ok", target: null, lens: ["general"], at: "2026-10-20T00:00:00.000Z" },
    critic_review: { level: "drift", reason: "gap", at: "2026-10-20T00:00:00.000Z" },
    advisor_consult: null,
    oracle_consult: null,
    fail_streak: 2,
    eval_cmd: "bun test",
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 1,
    entry_route: "full",
    escalated_at: null,
    updated_at: "2026-10-20T01:00:00.000Z",
    ...over,
  };
}

const goals = { goals: [{ id: "g-test", title: "TUI表示", status: "active" }], active: "g-test" };

describe("parsePhase / parseEntryRoute", () => {
  test("既知の phase だけ通す", () => {
    expect(parsePhase("polish")).toBe("polish");
    expect(parsePhase("done")).toBe("done");
    expect(parsePhase("bogus")).toBeNull();
    expect(parsePhase(undefined)).toBeNull();
  });

  test("旧 A/B/C 表記を写像する", () => {
    expect(parseEntryRoute("A")).toBe("full");
    expect(parseEntryRoute("b")).toBe("light");
    expect(parseEntryRoute("C")).toBe("direct");
    expect(parseEntryRoute("advised")).toBe("advised");
    expect(parseEntryRoute("")).toBeNull();
  });
});

describe("phaseLadder", () => {
  test("現在地と前後を分類する", () => {
    expect(phaseLadder("implementing")).toEqual([
      { phase: "designing", status: "done" },
      { phase: "implementing", status: "current" },
      { phase: "polish", status: "pending" },
    ]);
  });

  test("done は全ステップ done", () => {
    expect(phaseLadder("done").every((s) => s.status === "done")).toBe(true);
  });
});

describe("buildSnapshot", () => {
  test("state と goals から組み立てる", () => {
    const snap = buildSnapshot({ root: "/repo/a", state: state(), goals, config: { loop_stop_max: 3 }, history: [] });
    expect(snap).not.toBeNull();
    expect(snap?.repo).toBe("a");
    expect(snap?.goalID).toBe("g-test");
    expect(snap?.title).toBe("TUI表示");
    expect(snap?.phase).toBe("implementing");
    expect(snap?.entryRoute).toBe("full");
    expect(snap?.failStreak).toBe(2);
    expect(snap?.verifier?.level).toBe("clean");
    expect(snap?.verifier?.at).toBe("2026-10-20T00:00:00.000Z");
    expect(snap?.critic?.level).toBe("drift");
    expect(snap?.diff.lines).toBe(12);
    expect(snap?.diff.threshold).toBe(400);
    expect(snap?.diff.route).toBe("advisor");
    expect(snap?.loop.stopCount).toBe(1);
    expect(snap?.loop.blocked).toBe(false);
  });

  test("router の閾値は config から取る", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals,
      config: { router_threshold_lines: 120 },
      history: [],
    });
    expect(snap?.diff.threshold).toBe(120);
  });

  test("goal_id が無い・phase が不正なら null（表示しない）", () => {
    expect(buildSnapshot({ root: "/r", state: state({ goal_id: null }), goals: null, config: null, history: [] })).toBeNull();
    expect(buildSnapshot({ root: "/r", state: state({ phase: "nope" }), goals, config: null, history: [] })).toBeNull();
    expect(buildSnapshot({ root: "/r", state: null, goals, config: null, history: [] })).toBeNull();
  });

  test("goals.active は state.goal_id より優先される", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals: { goals: [{ id: "g-other", title: "別goal", status: "active" }], active: "g-other" },
      config: null,
      history: [],
    });
    expect(snap?.goalID).toBe("g-other");
    expect(snap?.title).toBe("別goal");
  });

  test("goals.active が null なら表示しない（clear 後のゴースト防止）", () => {
    const snap = buildSnapshot({ root: "/r", state: state(), goals: { goals: [], active: null }, config: null, history: [] });
    expect(snap).toBeNull();
  });

  test("goals.json が無い場合は state.goal_id にフォールバック", () => {
    const snap = buildSnapshot({ root: "/r", state: state(), goals: null, config: null, history: [] });
    expect(snap?.goalID).toBe("g-test");
  });

  test("goals に該当が無くても title 空で組み立てる", () => {
    const snap = buildSnapshot({ root: "/r", state: state(), goals: { goals: [], active: "g-test" }, config: null, history: [] });
    expect(snap?.title).toBe("");
    expect(snap?.goalStatus).toBe("active");
  });

  test("loop_stop_max 到達で blocked", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state({ loop_stop_count: 3 }),
      goals,
      config: { loop_stop_max: 3 },
      history: [],
    });
    expect(snap?.loop.blocked).toBe(true);
  });
});

describe("parseHistory", () => {
  const lines = [
    JSON.stringify({ ts: "t1", type: "goal_start", goal: "g-test", title: "TUI表示" }),
    "broken",
    JSON.stringify({ ts: "t2", type: "phase", goal: "g-test", from: "designing", to: "implementing" }),
    JSON.stringify({ ts: "t3", type: "hash_edit_applied", goal: "g-test", path: "package.json" }),
  ];

  test("新しい順・壊れた行は捨てる", () => {
    const out = parseHistory(lines, 2);
    expect(out.map((e) => e.type)).toEqual(["hash_edit_applied", "phase"]);
    expect(out[1]?.detail).toBe("designing → implementing");
  });

  test("空でも落ちない", () => {
    expect(parseHistory([], 5)).toEqual([]);
    expect(parseHistory([""], 5)).toEqual([]);
  });
});

describe("loadSnapshot", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "gh-tui-"));
    roots.push(root);
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(root, ".graphhopper", name), body, "utf8");
    }
    return root;
  }

  test("実ファイルから読む", () => {
    const root = repo({
      "state.json": JSON.stringify(state()),
      "goals.json": JSON.stringify(goals),
      "config.json": JSON.stringify({ loop_stop_max: 5 }),
      "history.jsonl": JSON.stringify({ ts: "t1", type: "phase", from: "designing", to: "implementing" }) + "\n",
    });
    const snap = loadSnapshot(root);
    expect(snap?.goalID).toBe("g-test");
    expect(snap?.loop.stopMax).toBe(5);
    expect(snap?.history).toHaveLength(1);
  });

  test("state.json が無い／壊れているなら null", () => {
    expect(loadSnapshot(repo({}))).toBeNull();
    expect(loadSnapshot(repo({ "state.json": "{oops" }))).toBeNull();
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");

  test("null / 不正値は空文字", () => {
    expect(formatAge(null, now)).toBe("");
    expect(formatAge("not-a-date", now)).toBe("");
  });

  test("分・時間・日で丸める", () => {
    expect(formatAge("2026-10-20T11:59:40.000Z", now)).toBe("now");
    expect(formatAge("2026-10-20T11:55:00.000Z", now)).toBe("5m");
    expect(formatAge("2026-10-20T09:00:00.000Z", now)).toBe("3h");
    expect(formatAge("2026-10-17T12:00:00.000Z", now)).toBe("3d");
  });

  test("未来時刻は now に丸める", () => {
    expect(formatAge("2026-10-20T13:00:00.000Z", now)).toBe("now");
  });
});

describe("formatChip / truncate", () => {
  test("チップは phase と差分行数と fail 数", () => {
    const snap = buildSnapshot({ root: "/r", state: state(), goals, config: null, history: [] });
    expect(snap).not.toBeNull();
    expect(formatChip(snap!)).toBe("implementing·Δ12·f2");
  });

  test("router 未計測なら Δ を省く", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state({ router: { baseline_rev: null, diff_lines: null, route: null, checked_at: null } }),
      goals,
      config: null,
      history: [],
    });
    expect(formatChip(snap!)).toBe("implementing·f2");
  });

  test("loop 停止中は !loop を出す", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state({ loop_stop_count: 3 }),
      goals,
      config: { loop_stop_max: 3 },
      history: [],
    });
    expect(formatChip(snap!)).toBe("implementing·Δ12·!loop");
  });

  test("truncate は文字数で切る（サロゲート安全）", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("あいうえお", 2)).toBe("あ…");
    expect(truncate("abc", 0)).toBe("");
    expect([...truncate("🙂🙂🙂", 2)]).toHaveLength(2);
  });
});

describe("formatChip: 進捗タスク", () => {
  const todos = (items: { status: string }[]) => {
    const total = items.length;
    const done = items.filter((i) => i.status === "completed").length;
    const open = items.filter(
      (i) => i.status === "pending" || i.status === "in_progress",
    ).length;
    return { total, done, open, unreadable: false, invalidCount: 0 };
  };

  test("タスク 0 件なら ✓ を出さない", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals,
      config: null,
      history: [],
      todos: todos([]),
    });
    expect(formatChip(snap!)).toBe("implementing·Δ12·f2");
  });

  test("タスクがあれば ✓完了/全体 を出す", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals,
      config: null,
      history: [],
      todos: todos([{ status: "completed" }, { status: "pending" }, { status: "in_progress" }]),
    });
    expect(formatChip(snap!)).toBe("implementing·Δ12·f2·✓1/3");
  });

  test("cancelled は done に数えない（open のみ別管理）", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals,
      config: null,
      history: [],
      todos: todos([{ status: "completed" }, { status: "cancelled" }]),
    });
    expect(formatChip(snap!)).toContain("✓1/2");
  });

  test("ストア不読なら ✓? を出す（0件に潰さない）", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state(),
      goals,
      config: null,
      history: [],
      todos: { total: 0, done: 0, open: 0, unreadable: true, invalidCount: 0 },
    });
    expect(formatChip(snap!)).toContain("✓?");
  });

  test("チップは 40 文字以内に収まる（最悪ケース）", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: state({
        fail_streak: 9,
        router: { baseline_rev: "x", diff_lines: 12345, route: "polish", checked_at: null },
        cascade: { level: "escalated", model: "anthropic/claude-sonnet-5-5", children: 0 },
      }),
      goals,
      config: null,
      history: [],
      todos: todos([
        { status: "completed" },
        { status: "completed" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
      ]),
    });
    const chip = formatChip(snap!);
    expect(chip.length).toBeLessThanOrEqual(40);
  });
});

describe("cascade 表示", () => {
  test("shortModel は model 部分だけ・claude- と #variant を落とす", () => {
    expect(shortModel("claude-oauth/claude-sonnet-5-5#default")).toBe("sonnet-5-5");
    expect(shortModel("opencode-go/minimax-m3.1-flash-free")).toBe("minimax-m3.1-flash-free");
    expect(shortModel(null)).toBe("");
  });
});

describe("formatChip: 完了 goal", () => {
  test("done では Δ・進捗を出さない", () => {
    const snap = buildSnapshot({
      root: "/r",
      state: { ...state(), phase: "done", router: { diff_lines: 1282 } },
      goals,
      config: null,
      history: [],
      todos: { total: 28, done: 23, open: 0, unreadable: false, invalidCount: 0 },
    });
    expect(formatChip(snap!)).toBe("done");
  });
});
