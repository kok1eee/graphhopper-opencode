import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRepos,
  isStale,
  readBoard,
  readDesign,
  readGoalEvents,
  readRepo,
  sortGoals,
  visibleGoals,
} from "./model";

function repo(root: string, name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, ".graphhopper", "tmp"), { recursive: true });
  mkdirSync(join(p, ".graphhopper", "plans"), { recursive: true });
  return p;
}

function setup(
  p: string,
  goals: unknown[],
  state: unknown,
  events: unknown[],
): void {
  writeFileSync(join(p, ".graphhopper", "goals.json"), JSON.stringify(goals));
  if (state !== null) writeFileSync(join(p, ".graphhopper", "state.json"), JSON.stringify(state));
  writeFileSync(join(p, ".graphhopper", "history.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const NOW = Date.parse("2026-11-26T06:00:00Z");

describe("board/model: リポジトリ探索", () => {
  test("findRepos は .graphhopper を持つリポジトリだけ返し、node_modules と深すぎる先は潜らない", () => {
    const root = mkdtempSync(join(tmpdir(), "board-scan-"));
    const a = repo(root, "repo-a");
    const inner = repo(join(a, "nested"), "inner"); // 入れ子も別リポジトリなら拾う
    mkdirSync(join(root, "plain", "node_modules", "x"), { recursive: true });
    repo(join(root, "plain", "node_modules", "x"), "ghost"); // node_modules は潜らない
    repo(join(root, "deep", "one"), "repo-b");
    repo(join(root, "too", "deep", "a"), "repo-c"); // 深さ 4 は既定で拾わない
    const found = findRepos([root], 3);
    expect(found).toEqual([a, inner, join(root, "deep", "one", "repo-b")].sort());
  });

  test("根ごとの深さを守る", () => {
    const root = mkdtempSync(join(tmpdir(), "board-depth-"));
    const shallow = repo(root, "shallow");
    repo(join(root, "x", "y"), "deep");
    expect(findRepos([{ dir: root, depth: 1 }])).toEqual([shallow]);
    expect(findRepos([{ dir: root, depth: 3 }]).length).toBe(2);
  });
});

describe("board/model: goal の読み取り", () => {
  test("状態・phase・止まった理由・最終イベントを組み立てる", () => {
    const root = mkdtempSync(join(tmpdir(), "board-read-"));
    const p = repo(root, "amu-tool");
    setup(
      p,
      [
        { id: "g-1", title: "止まった goal", status: "paused" },
        { id: "g-2", title: "進行中", status: "active" },
        { id: "g-3", title: "完了", status: "done", done_at: "2026-11-20T00:00:00Z" },
      ],
      { goal_id: "g-2", phase: "implementing" },
      [
        {"ts":"2026-11-25T10:00:00.000Z","type":"goal_pause","goal":"g-1"},
        {"ts":"2026-11-25T10:00:00.001Z","type":"guard_pause","goal":"g-1","reason":"stalls"},
        {"ts":"2026-11-26T05:50:00.000Z","type":"eval_run","goal":"g-2","ok":true},
        '{"ts":"2026-11-26T05:51:00.000Z","type":"phase","goal":"g-2","from":"designing","to":"impl', // 途中で切れた行
      ],
    );
    const { goals, errors } = readRepo(p);
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(goals.map((g) => [g.id, g]));
    expect(byId["g-1"]!.stop).toEqual({ reason: "stalls", at: "2026-11-25T10:00:00.001Z" });
    expect(byId["g-1"]!.phase).toBeNull();
    expect(byId["g-2"]!.phase).toBe("implementing");
    expect(byId["g-2"]!.lastEventType).toBe("eval_run");
    expect(byId["g-3"]!.status).toBe("done");
  });

  test("理由付きイベントが無い停止は種別を理由にし、古い停止の理由を持ち越さない", () => {
    const root = mkdtempSync(join(tmpdir(), "board-stop-"));
    const p = repo(root, "r");
    setup(
      p,
      [
        { id: "g-1", title: "goal_pause だけ", status: "paused" },
        { id: "g-2", title: "loop_stopped だけ", status: "paused" },
      ],
      null,
      [
        { ts: "2026-11-20T10:00:00.000Z", type: "guard_pause", goal: "g-1", reason: "stalls" },
        { ts: "2026-11-25T10:00:00.000Z", type: "goal_pause", goal: "g-1" },
        { ts: "2026-11-25T11:00:00.000Z", type: "loop_stopped", goal: "g-2" },
      ],
    );
    const byId = Object.fromEntries(readRepo(p).goals.map((g) => [g.id, g]));
    expect(byId["g-1"]!.stop).toEqual({ reason: "goal_pause", at: "2026-11-25T10:00:00.000Z" });
    expect(byId["g-2"]!.stop).toEqual({ reason: "loop_stopped", at: "2026-11-25T11:00:00.000Z" });
  });

  test("goals.json が壊れていても他のリポジトリは読める（エラーを返すだけ）", () => {
    const root = mkdtempSync(join(tmpdir(), "board-broken-"));
    const bad = repo(root, "bad");
    writeFileSync(join(bad, ".graphhopper", "goals.json"), "{壊れ");
    const good = repo(root, "good");
    setup(good, [{ id: "g-9", title: "ok", status: "active" }], null, []);
    const board = readBoard([bad, good]);
    expect(board.goals.map((g) => g.id)).toEqual(["g-9"]);
    expect(board.errors[0]).toContain("goals.json が読めない");
    expect(board.repos.find((r) => r.path === bad)?.error).toContain("読めない");
  });

  test("検証結果と決定記録・履歴を読む", () => {
    const root = mkdtempSync(join(tmpdir(), "board-verify-"));
    const p = repo(root, "amu-tool");
    setup(p, [{ id: "g-1", title: "t", status: "paused" }], null, [
      {"ts":"2026-11-26T05:00:00.000Z","type":"verifier_verdict","goal":"g-1","level":"drift"},
    ]);
    writeFileSync(
      join(p, ".graphhopper", "tmp", "verify-g-1.json"),
      JSON.stringify({
        v: 2,
        diff_hash: "h1",
        plan: { entries: [{ id: "agreement" }, { id: "premise" }, { id: "wiring" }] },
        results: [
          { lens: "agreement", level: "drift", summary: "冪等性が SQL を通っていない", body: "- [must] model.ts:10" },
          { lens: "premise", level: "clean", summary: "" },
        ],
      }),
    );
    writeFileSync(join(p, ".graphhopper", "plans", "g-1.md"), "## 決めたこと\n- テスト\n");
    const g = readRepo(p).goals[0]!;
    expect(g.verify?.angles.map((a) => `${a.lens}=${a.level}`)).toEqual(["agreement=drift", "premise=clean"]);
    expect(g.verify?.angles[0]!.body).toContain("must");
    // 計画にあって結果が無い観点を「判定できなかった」として出す
    expect(g.verify?.missing).toEqual([{ lens: "wiring", reason: "この diff では判定が無い（未実行か判定不能）" }]);
    expect(readDesign(p, "g-1")).toContain("決めたこと");
    expect(readDesign(p, "nope")).toBeNull();
    expect(readGoalEvents(p, "g-1").length).toBe(1);
    // state.json が無いので今の差分とは比べられない
    expect(g.verify?.currentDiff).toBeNull();
  });

  test("今の差分と違う判定には印を付ける", () => {
    const root = mkdtempSync(join(tmpdir(), "board-stale-verify-"));
    const p = repo(root, "r");
    setup(p, [{ id: "g-1", title: "t", status: "paused" }], { goal_id: "g-1", stash_diff_hash: "h2" }, []);
    writeFileSync(
      join(p, ".graphhopper", "tmp", "verify-g-1.json"),
      JSON.stringify({ v: 2, diff_hash: "h1", plan: { entries: [{ id: "a" }] }, results: [{ lens: "a", level: "clean", summary: "" }] }),
    );
    expect(readRepo(p).goals[0]!.verify?.currentDiff).toBe(false);
    writeFileSync(join(p, ".graphhopper", "state.json"), JSON.stringify({ goal_id: "g-1", stash_diff_hash: "h1" }));
    expect(readRepo(p).goals[0]!.verify?.currentDiff).toBe(true);
  });

  test("詳しい指摘から先頭の判定 json を落として本文だけ表示する", () => {
    const root = mkdtempSync(join(tmpdir(), "board-body-"));
    const p = repo(root, "r");
    setup(p, [{ id: "g-1", title: "t", status: "paused" }], null, []);
    writeFileSync(
      join(p, ".graphhopper", "tmp", "verify-g-1.json"),
      JSON.stringify({
        v: 2,
        plan: { entries: [{ id: "behavior" }] },
        results: [
          {
            lens: "behavior",
            level: "drift",
            summary: "要修正",
            body: '```json\n{"level":"drift","target":"implementing","summary":"要修正"}\n```\n\n- [must] model.ts:10 直す\n',
          },
        ],
      }),
    );
    const g = readRepo(p).goals[0]!;
    expect(g.verify?.angles[0]!.body).toBe("- [must] model.ts:10 直す");
  });

  test("検証結果が壊れていても落ちず、読めないと記録する", () => {    const root = mkdtempSync(join(tmpdir(), "board-verify-bad-"));
    const p = repo(root, "r");
    setup(p, [{ id: "g-1", title: "t", status: "paused" }], null, []);
    writeFileSync(join(p, ".graphhopper", "tmp", "verify-g-1.json"), "{壊れ");
    const r = readRepo(p);
    expect(r.goals[0]!.verify).toBeNull();
    expect(r.errors[0]).toContain("検証結果が読めない");
  });

  test("読むだけで記録は変えない", () => {
    const root = mkdtempSync(join(tmpdir(), "board-ro-"));
    const p = repo(root, "r");
    setup(p, [{ id: "g-1", title: "t", status: "paused" }], { goal_id: "g-1", phase: "polish" }, []);
    const before = ["goals.json", "state.json", "history.jsonl"].map((f) =>
      readFileSync(join(p, ".graphhopper", f), "utf8"),
    );
    readRepo(p);
    readGoalEvents(p, "g-1");
    const after = ["goals.json", "state.json", "history.jsonl"].map((f) =>
      readFileSync(join(p, ".graphhopper", f), "utf8"),
    );
    expect(after).toEqual(before);
  });

  test("再開済み（active）の goal には古い停止理由を付けない", () => {
    const root = mkdtempSync(join(tmpdir(), "board-resumed-"));
    const p = repo(root, "r");
    setup(p, [{ id: "g-1", title: "t", status: "active" }], { goal_id: "g-1", phase: "implementing" }, [
      { ts: "2026-11-25T10:00:00.000Z", type: "guard_pause", goal: "g-1", reason: "stalls" },
      { ts: "2026-11-26T05:00:00.000Z", type: "goal_resume", goal: "g-1" },
    ]);
    expect(readRepo(p).goals[0]!.stop).toBeNull();
  });
});

describe("board/model: 並びと古さ", () => {
  const base = {
    repo: "/r",
    repoName: "r",
    title: "t",
    phase: null,
    createdAt: null,
    doneAt: null,
    lastEventType: null,
    stop: null,
    verify: null,
    error: null,
  };
  test("進行中 → 停止 → 完了、各中は新しい順", () => {
    const goals = sortGoals([
      { ...base, id: "d", status: "done", lastEventAt: "2026-11-26T05:00:00Z" },
      { ...base, id: "p-old", status: "paused", lastEventAt: "2026-11-20T05:00:00Z" },
      { ...base, id: "p-new", status: "paused", lastEventAt: "2026-11-26T05:00:00Z" },
      { ...base, id: "a", status: "active", lastEventAt: "2026-11-21T05:00:00Z" },
    ]);
    expect(goals.map((g) => g.id)).toEqual(["a", "p-new", "p-old", "d"]);
    expect(visibleGoals(goals, false).map((g) => g.id)).toEqual(["a", "p-new", "p-old"]);
  });

  test("paused で 3 日以上動いていないものだけ古い（境界を含む）", () => {
    const p3 = { ...base, id: "x", status: "paused" as const };
    const now = Date.parse("2026-11-26T06:00:00Z");
    const days = (n: number): string => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale({ ...p3, lastEventAt: days(3.1) }, now)).toBe(true);
    expect(isStale({ ...p3, lastEventAt: days(3) }, now)).toBe(true);
    expect(isStale({ ...p3, lastEventAt: days(2.9) }, now)).toBe(false);
    expect(isStale({ ...p3, status: "active", lastEventAt: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isStale({ ...p3, lastEventAt: null }, now)).toBe(true);
    // done を表示する側では done も並ぶ
    const goals = [
      { ...base, id: "a", status: "active" as const, lastEventAt: "2026-11-26T05:00:00Z" },
      { ...base, id: "d", status: "done" as const, lastEventAt: "2026-11-25T05:00:00Z" },
    ];
    expect(visibleGoals(goals, true).map((g) => g.id)).toEqual(["a", "d"]);
  });
});
