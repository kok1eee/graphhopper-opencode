/**
 * progress lens charter の埋め込みと進捗ビューのテスト。
 *
 * goal の中心的な主張「progress lens と TUI が同じ進捗を見る」を固定する。
 * charter は lens 指示文にタスク一覧を直接埋め込み、TUI は todoProgressView を読む。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { todoSection } from "./prompts";
import {
  ensureTodos,
  planPath,
  readTodosStatus,
  startGoal,
  todoAction,
  todoProgressView,
  todoSummaryLine,
  todosPath,
} from "./state";
import { parseTaskLines } from "./todos";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-charter-test-"));
}

/** 注意: 旧形式の fixture（§5 が空・§3 が空）。checkPhaseMove の内容規約は通らない。
 * phase 遷移を伴うテストを足すときは src/design-fixture.ts の compliantDesignDoc を使う。 */
const DESIGN_WITH_TASKS = [
  "# design: charter test",
  "",
  "## 1. goal理解",
  "",
  "## 2. 現状",
  "",
  "## 3. 設計判断",
  "",
  "## 4. 実装タスク列",
  "",
  "- [ ] T1 実装する",
  "- [ ] T2 テストを書く",
  "",
  "## 5. 棄却した代替案",
  "",
].join("\n");

function render(_name: string, root: string, goalId: string): string {
  return todoSection(root, goalId);
}

describe("progress lens charter への進捗埋め込み", () => {
  test("graphhopper-verifier-progress にタスク一覧が載る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    const out = render("graphhopper-verifier-progress", root, g.id);
    expect(out).toContain("進捗タスク");
    expect(out).toContain("T1 実装する");
    expect(out).toContain("手動追加タスク");
  });

  test("graphhopper-verifier-general にもタスク一覧が載る（progress と非対称にしない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    const out = render("graphhopper-verifier-general", root, g.id);
    expect(out).toContain("進捗タスク");
    expect(out).toContain("手動追加タスク");
  });

  test("ストア不読なら『進捗は確認できなかった』と明示する（0件に潰さない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    const out = render("graphhopper-verifier-progress", root, g.id);
    expect(out).toContain("読み込めなかった");
    expect(out).toContain("進捗は確認できなかった");
  });

  test("要素レベルの不正があれば lens に明示する", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        items: [
          { id: "t1", text: "A", status: "pending" },
          { id: 999, text: "壊れた要素" },
        ],
      }),
      "utf8",
    );
    const out = render("graphhopper-verifier-progress", root, g.id);
    expect(out).toContain("不正要素が 1 件");
  });
});

describe("進捗ビュー（progress lens と TUI が同じ数え方をする）", () => {
  test("ストア基準の進捗と design.md 由来のタスクが一致する", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    ensureTodos(root, g.id);
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    todoAction(root, g.id, "done", { id: "t1" });
    // ストア基準: design.md の2件 + 手動1件 = 3件、うち1件完了
    const loaded = readTodosStatus(root, g.id);
    const view = todoProgressView(loaded);
    expect(view.total).toBe(3);
    expect(view.done).toBe(1);
    expect(view.open).toBe(2);
    expect(view.unreadable).toBeUndefined();
    // design.md 由来は done=0（design.md は immutable なので check されない）
    const planTasks = parseTaskLines(DESIGN_WITH_TASKS);
    expect(planTasks.length).toBe(2);
    expect(planTasks.filter((t) => t.done).length).toBe(0);
    expect(todoSummaryLine(root, g.id)).toContain("1/3");
  });

  test("ストア不読なら unreadable が立つ（0件に潰さない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    const loaded = readTodosStatus(root, g.id);
    expect(loaded.valid).toBe(false);
    expect(todoProgressView(loaded).unreadable).toBe(true);
  });
});
