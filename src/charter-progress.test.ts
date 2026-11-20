/**
 * progress lens charter の埋め込みと進捗ビューのテスト。
 *
 * charter は lens 指示文にタスク一覧を直接埋め込む。応答文の進捗行（todoSummaryLine）と同じ数え方をする。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { todoSection } from "./prompts";
import {
  readTodosStatus,
  startGoal,
  todoAction,
  todoSummaryLine,
  todosPath,
} from "./state";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-charter-test-"));
}

/** 進捗タスクを 2 件足す（タスクは決定記録から作られない。自分で add する） */
function addTasks(root: string, goalId: string): void {
  todoAction(root, goalId, "add", { text: "T1 実装する" });
  todoAction(root, goalId, "add", { text: "T2 テストを書く" });
}

function render(_name: string, root: string, goalId: string): string {
  return todoSection(root, goalId);
}

describe("progress lens charter への進捗埋め込み", () => {
  test("graphhopper-verifier-progress にタスク一覧が載る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    const out = render("graphhopper-verifier-progress", root, g.id);
    expect(out).toContain("進捗タスク");
    expect(out).toContain("T1 実装する");
    expect(out).toContain("手動追加タスク");
  });

  test("graphhopper-verifier-general にもタスク一覧が載る（progress と非対称にしない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
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

describe("進捗の 1 行サマリ（progress lens と同じ数え方をする）", () => {
  test("足したタスクと完了がストア基準の進捗に出る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    todoAction(root, g.id, "add", { text: "手動追加タスク" });
    todoAction(root, g.id, "done", { id: "t1" });
    // 3 件足して 1 件完了
    expect(todoSummaryLine(root, g.id)).toContain("1/3");
  });

  test("ストア不読なら「進捗不明」と出す（0件に潰さない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    expect(readTodosStatus(root, g.id).valid).toBe(false);
    expect(todoSummaryLine(root, g.id)).toContain("進捗不明");
  });
});
