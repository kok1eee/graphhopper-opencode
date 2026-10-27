/**
 * handoff メモの unit test（design g-mvq907g4）。
 * state は tmp root に隔離し、実 repo の .graphhopper/ を触らない。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHandoff,
  handoffPath,
  parseMemo,
  readHandoff,
  renderHandoff,
  setPending,
  staleness,
  todoSignature,
  writeHandoff,
} from "./handoff";
import { startGoal, todoAction, writeTodos } from "./state";

function root(): string {
  return mkdtempSync(join(tmpdir(), "gh-handoff-"));
}

function withGoal(r: string, title = "テスト goal"): string {
  const g = startGoal(r, title, "ses_test");
  if (!g) throw new Error("goal start failed");
  return g.goal.id;
}

describe("renderHandoff", () => {
  test("goal が無ければ null", () => {
    expect(renderHandoff(root())).toBeNull();
    expect(writeHandoff(root())).toBeNull();
  });

  test("goal id・phase・次アクション・未完了タスクを含む", () => {
    const r = root();
    const id = withGoal(r, "handoff を作る");
    const out = renderHandoff(r, { sessionID: "ses_w", now: new Date("2026-10-27T00:00:00Z") });
    expect(out).not.toBeNull();
    const memo = parseMemo(out!);
    expect(memo?.meta.goal_id).toBe(id);
    expect(memo?.meta.phase).toBe("designing");
    expect(memo?.meta.pending).toBe(true);
    expect(memo?.meta.written_by).toBe("ses_w");
    expect(memo?.meta.written_at).toBe("2026-10-27T00:00:00.000Z");
    expect(out!).toContain("## 次のアクション");
    expect(out!).toContain(".graphhopper/plans/");
  });

  test("未完了タスクが本文に並ぶ", () => {
    const r = root();
    const id = withGoal(r);
    todoAction(r, id, "add", { text: "T1 設計を書く" });
    todoAction(r, id, "add", { text: "T2 実装する" });
    const out = renderHandoff(r)!;
    expect(out).toContain("T1 設計を書く");
    expect(out).toContain("T2 実装する");
    expect(out).toContain("未完了");
  });

  test("pause 後に render しても再開文脈が空にならない（opts.resumeContext）", () => {
    const r = root();
    const id = withGoal(r);
    const ctx = "- goal: dummy（pause 前に取得した文脈）";
    const out = renderHandoff(r, { resumeContext: ctx })!;
    expect(out).toContain(ctx);
    expect(out).toContain(id);
  });

  test("VCS 未取得は「不明」と明記する", () => {
    const r = root();
    withGoal(r);
    const out = renderHandoff(r)!;
    expect(out).toContain("HEAD: (不明)");
    expect(out).toContain("未コミット: (不明)");
  });
});

describe("write / read / clear", () => {
  test("往復して同じ内容が読める", () => {
    const r = root();
    const id = withGoal(r);
    const path = writeHandoff(r, { sessionID: "ses_a" })!;
    expect(path).toBe(handoffPath(r));
    const memo = readHandoff(r);
    expect(memo?.meta.goal_id).toBe(id);
    expect(memo?.meta.pending).toBe(true);
  });

  test("setPending(false) は本文を保ったまま pending だけ落とす", () => {
    const r = root();
    withGoal(r);
    writeHandoff(r, { sessionID: "ses_a" });
    const before = readHandoff(r)!;
    expect(setPending(r, false)).toBe(true);
    const after = readHandoff(r)!;
    expect(after.meta.pending).toBe(false);
    expect(after.body).toBe(before.body);
  });

  test("clear で消える（二重 clear は false）", () => {
    const r = root();
    withGoal(r);
    writeHandoff(r);
    expect(clearHandoff(r)).toBe(true);
    expect(readHandoff(r)).toBeNull();
    expect(clearHandoff(r)).toBe(false);
  });

  test("壊れた front matter は null", () => {
    const r = root();
    mkdirSync(join(r, ".graphhopper"), { recursive: true });
    writeFileSync(handoffPath(r), "not a memo\n", { mode: 0o644 });
    expect(readHandoff(r)).toBeNull();
    writeFileSync(handoffPath(r), "---\nphase: x\n---\nbody\n");
    expect(readHandoff(r)).toBeNull();
  });
});

describe("staleness", () => {
  test("直後は全項目一致", () => {
    const r = root();
    withGoal(r);
    writeHandoff(r, { vcsHead: "abc" });
    const memo = readHandoff(r)!;
    const items = staleness(r, memo);
    expect(items.every((i) => i.same)).toBe(true);
  });

  test("タスクが増えると todo_sig と history がずれる", () => {
    const r = root();
    const id = withGoal(r);
    writeHandoff(r);
    const memo = readHandoff(r)!;
    todoAction(r, id, "add", { text: "新しいタスク" });
    const items = staleness(r, memo);
    const todo = items.find((i) => i.key === "todo_sig")!;
    expect(todo.same).toBe(false);
    expect(todo.live).not.toBe(todo.memo);
  });

  test("vcsHead を渡すと HEAD のズレを検出する", () => {
    const r = root();
    withGoal(r);
    writeHandoff(r, { vcsHead: "aaa" });
    const memo = readHandoff(r)!;
    const same = staleness(r, memo, { vcsHead: "aaa" });
    expect(same.find((i) => i.key === "vcs_head")?.same).toBe(true);
    const moved = staleness(r, memo, { vcsHead: "bbb" });
    expect(moved.find((i) => i.key === "vcs_head")?.same).toBe(false);
  });

  test("goal が消えると不一致を返す", () => {
    const r = root();
    withGoal(r);
    writeHandoff(r);
    const memo = readHandoff(r)!;
    const r2 = root();
    const items = staleness(r2, memo);
    expect(items[0]?.key).toBe("goal");
    expect(items[0]?.same).toBe(false);
  });
});

describe("todoSignature", () => {
  test("進捗が変わると指紋が変わる", () => {
    const r = root();
    const id = withGoal(r);
    const a = todoSignature(r, id);
    todoAction(r, id, "add", { text: "x" });
    const b = todoSignature(r, id);
    expect(a).not.toBe(b);
    writeTodos(r, { goal_id: id, items: [], updated_at: "" });
    expect(todoSignature(r, id)).toBe("0/0|empty");
  });
});
