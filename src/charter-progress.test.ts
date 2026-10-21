/**
 * progress lens charter の埋め込みと lineage resource の進捗表示のテスト。
 *
 * goal の中心的な主張「progress lens と TUI が同じ進捗を見る」を固定する。
 * ここは MCP prompt 経路（charter にタスク一覧を直接埋め込む）と
 * lineage resource（goals.json の tasks / planTasks）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROMPT_DEFS } from "./prompts";
import { lineageEnriched } from "./mcp";
import { planPath, startGoal, todoAction, todosPath } from "./state";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-charter-test-"));
}

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

function render(name: string, root: string, goalId: string): string {
  const def = PROMPT_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`prompt not found: ${name}`);
  return def.render({ goalId }, root);
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

describe("lineage resource の進捗表示", () => {
  test("tasks はストア基準・planTasks は design.md 由来", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    todoAction(root, g.id, "done", { id: "t1" });
    const lin = await lineageEnriched(root);
    const goal = lin.goals.find((x) => x.id === g.id);
    expect(goal).toBeDefined();
    // ストア基準: design.md の2件 + 手動1件 = 3件、うち1件完了
    expect(goal!.tasks.total).toBe(3);
    expect(goal!.tasks.done).toBe(1);
    expect(goal!.tasks.open).toBe(2);
    // design.md 由来の planTasks は done=0（design.md は immutable なので check されない）
    expect(goal!.planTasks.total).toBe(2);
    expect(goal!.planTasks.done).toBe(0);
  });

  test("ストア不読なら tasks.unreadable が立つ（0件に潰さない）", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    const lin = await lineageEnriched(root);
    const goal = lin.goals.find((x) => x.id === g.id);
    expect(goal!.tasks.unreadable).toBe(true);
  });
});
