import { goalResumeContext } from "./gate";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import {
  completeGoal,
  evalToPolish,
  evalTransitionInput,
  planPath,
  readState,
  readTodos,
  readTodosStatus,
  runEval,
  setPhase,
  setPhaseChecked,
  startGoal,
  todoAction,
  todoSummaryLine,
  todosPath,
  writeTodos,
} from "./state";
import { checkPhaseMove } from "./gate";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-todo-test-"));
}

/** テスト用の shell スタブ（evalToPolish は実 shell を使わない） */
function shell() {
  return $ as never;
}

/** 進捗タスクを 2 件足す（タスクは決定記録から作られない。自分で add する） */
function addTasks(root: string, goalId: string): void {
  todoAction(root, goalId, "add", { text: "T1 実装する" });
  todoAction(root, goalId, "add", { text: "T2 テストを書く" });
}

describe("進捗 todo ストア", () => {
  test("決定記録にチェックボックスがあっても、タスクは自動では作られない", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(
      planPath(root, g.id),
      ["# 決定記録", "", "## 実装タスク列", "", "- [ ] T1 実装する", ""].join("\n"),
      "utf8",
    );
    setPhase(root, "implementing");
    expect(readTodos(root, g.id).items.length).toBe(0);
    expect(todoAction(root, g.id, "list").store.items.length).toBe(0);
    expect(setPhaseChecked(root, "polish").ok).toBe(true);
  });

  test("todoAction: list/start/done/cancel/add と監査記録", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);

    const list = todoAction(root, g.id, "list");
    expect(list.ok).toBe(true);
    expect(list.text).toContain("T1 実装する");

    const add = todoAction(root, g.id, "add", { text: "追加タスク" });
    expect(add.ok).toBe(true);
    expect(add.store.items.length).toBe(3);

    expect(todoAction(root, g.id, "start", { id: "t1" }).store.items[0]?.status).toBe(
      "in_progress",
    );
    expect(todoAction(root, g.id, "done", { id: "t1" }).store.items[0]?.status).toBe(
      "completed",
    );

    // cancel は reason 必須
    const noReason = todoAction(root, g.id, "cancel", { id: "t2" });
    expect(noReason.ok).toBe(false);
    const withReason = todoAction(root, g.id, "cancel", { id: "t2", reason: "不要" });
    expect(withReason.ok).toBe(true);

    const store = readTodos(root, g.id);
    expect(store.items.find((i) => i.id === "t2")?.reason).toBe("不要");
  });

  test("todo_update が history に残る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    todoAction(root, g.id, "done", { id: "t1" });
    const hist = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8");
    expect(hist).toContain('"todo_update"');
    expect(hist).toContain('"t1"');
  });
});

describe("implementing→polish の進捗ゲート", () => {
  test("未完了タスクがあれば遷移を拒否する", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    const r = setPhaseChecked(root, "polish");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未完了");
    expect(r.error).toContain("T1 実装する");
  });

  test("checkPhaseMove も同じ判定を返す", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    expect(checkPhaseMove(root, "polish")).toContain("未完了");
  });

  test("全件 completed / cancelled なら遷移できる", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    todoAction(root, g.id, "done", { id: "t1" });
    todoAction(root, g.id, "cancel", { id: "t2", reason: "不要" });
    const r = setPhaseChecked(root, "polish");
    expect(r.ok).toBe(true);
    expect(r.active?.state.phase).toBe("polish");
  });

  test("タスク 0 件ならゲートは働かない（後方互換）", () => {
    const root = tmpRoot();
    startGoal(root, "t", "s");
    setPhase(root, "implementing");
    expect(setPhaseChecked(root, "polish").ok).toBe(true);
  });

  test("polish→implementing→polish でもタスクは残る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    todoAction(root, g.id, "done", { id: "t1" });
    todoAction(root, g.id, "cancel", { id: "t2", reason: "不要" });
    setPhase(root, "polish");
    setPhase(root, "implementing");
    // 巻き戻し後もストアは維持され、polish に入れる
    expect(setPhaseChecked(root, "polish").ok).toBe(true);
    expect(readTodos(root, g.id).items.length).toBe(2);
  });

  test("evalToPolish: 実効diff=0 では polish へ進まない（旧分岐の維持）", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    // baseline は取れるが差分 0 のケース
    const t = await evalToPolish(shell(), root, {
      cmd: "true",
      baseline: "deadbeef",
      diffLines: 0,
    });
    expect(t.transitioned).toBe(false);
    expect(t.note).toContain("effective diff_lines=0");
    // phase は implementing のまま
    expect(readState(root).phase).toBe("implementing");
  });

  test("evalToPolish: 未完了タスクがあれば遷移しない（ゲート）", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    const t = await evalToPolish(shell(), root, {
      cmd: "true",
      baseline: "deadbeef",
      diffLines: 100,
    });
    expect(t.transitioned).toBe(false);
    expect(t.note).toContain("polish へ進めない");
    expect(readState(root).phase).toBe("implementing");
  });

  test("evalTransitionInput: baseline と実効 diff を返す（plugin の配線）", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "s");
    // baseline を明示すればその値を使い、差分を測る
    const inp = await evalTransitionInput(shell(), root, "deadbeef");
    expect(inp.baseline).toBe("deadbeef");
    expect(typeof inp.diffLines).toBe("number");
  });

  test("evalToPolish: タスク完了後は diff>0 で polish へ進む", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    todoAction(root, g.id, "done", { id: "t1" });
    todoAction(root, g.id, "cancel", { id: "t2", reason: "不要" });
    const t = await evalToPolish(shell(), root, {
      cmd: "true",
      baseline: "deadbeef",
      diffLines: 100,
    });
    expect(t.transitioned).toBe(true);
    expect(readState(root).phase).toBe("polish");
  });

  test("evalToPolish: baseline 未取得なら baseline 分岐で polish へ進む（simplify スキップ）", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    // タスクを片付けて進捗ゲートを通す
    todoAction(root, g.id, "done", { id: "t1" });
    todoAction(root, g.id, "cancel", { id: "t2", reason: "不要" });
    const t = await evalToPolish(shell(), root, { cmd: "true", baseline: null, diffLines: 0 });
    expect(t.transitioned).toBe(true);
    expect(t.note).toContain("baseline not captured");
    expect(readState(root).phase).toBe("polish");
  });

  test("evalToPolish: baseline 未取得でも未完了タスクがあれば遷移しない", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    const t = await evalToPolish(shell(), root, { cmd: "true", baseline: null, diffLines: 0 });
    expect(t.transitioned).toBe(false);
    expect(t.note).toContain("polish へ進めない");
    expect(readState(root).phase).toBe("implementing");
  });

  test("runEval: exit code で合否が決まり、失敗時は出力を返す", async () => {
    const root = tmpRoot();
    const ok = await runEval(shell(), root, "true");
    expect(ok.ok).toBe(true);
    const bad = await runEval(shell(), root, "echo boom; exit 3");
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("boom");
    // cwd が消えている等で shell 自体が失敗しても throw せず ok:false に倒す
    const broken = await runEval(shell(), "/nonexistent-dir-gh-test", "true");
    expect(broken.ok).toBe(false);
  });

  test("reopen で cancelled タスクを pending に戻せる", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    todoAction(root, g.id, "cancel", { id: "t1", reason: "誤操作" });
    expect(readTodos(root, g.id).items[0]?.status).toBe("cancelled");
    const r = todoAction(root, g.id, "reopen", { id: "t1" });
    expect(r.ok).toBe(true);
    expect(readTodos(root, g.id).items[0]?.status).toBe("pending");
  });

  test("design.md が無い場合はタスク0件として通す（既存 goal の後方互換）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    setPhase(root, "implementing");
    // design.md を削除
    unlinkSync(planPath(root, g.id));
    const r = setPhaseChecked(root, "polish");
    expect(r.ok).toBe(true);
  });

  test("壊れたストアは polish への遷移を拒否する（fail-closed）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    // ゲートが fail-open しないこと（進捗の強制点なので）
    const r = setPhaseChecked(root, "polish");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("壊れて");
    expect(readState(root).phase).toBe("implementing");
    // 手動遷移も同じ判定
    expect(checkPhaseMove(root, "polish")).toContain("壊れて");
  });

  test("要素レベルの不正は捨てられるが可視化される", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        items: [
          { id: "t1", text: "A", status: "pending" },
          { id: 123, text: "壊れた要素" },
          { text: "id無し" },
        ],
      }),
      "utf8",
    );
    const loaded = readTodosStatus(root, g.id);
    expect(loaded.valid).toBe(true);
    expect(loaded.invalidCount).toBe(2);
    expect(loaded.store.items.length).toBe(1);
    // status 行にも不正要素の件数が出る
    expect(todoSummaryLine(root, g.id)).toContain("不正要素 2");
  });

  test("壊れたストアは上書きされず、todoAction はエラーを返す", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken", "utf8");
    // todoAction はエラー（完了記録を失わない）
    const r = todoAction(root, g.id, "list");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("壊れて");
    // ファイルは壊れたまま（上書きされない）
    expect(readFileSync(p, "utf8")).toBe("{ broken");
  });

  test("add は 200 文字を超える text を拒否する", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const r = todoAction(root, g.id, "add", { text: "x".repeat(201) });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("長すぎ");
  });

  test("壊れた JSON のストアは空として扱う（落ちない）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ broken json", "utf8");
    const store = readTodos(root, g.id);
    expect(store.items.length).toBe(0);
    expect(store.goal_id).toBe(g.id);
  });

  test("readTodosStatus は「読めない」と「タスク無し」を区別する", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    // ファイル無し = タスク無し（valid）
    expect(readTodosStatus(root, g.id).valid).toBe(true);
    // 壊れた JSON = 読めない（valid=false）
    writeFileSync(p, "{ broken", "utf8");
    expect(readTodosStatus(root, g.id).valid).toBe(false);
    // items が配列でない = 読めない
    writeFileSync(p, JSON.stringify({ items: "nope" }), "utf8");
    expect(readTodosStatus(root, g.id).valid).toBe(false);
  });

  test("items が配列でないストアも空として扱う", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const p = todosPath(root, g.id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ items: "nope" }), "utf8");
    expect(readTodos(root, g.id).items.length).toBe(0);
  });
});

describe("完了 goal のアーカイブ", () => {
  test("completeGoal で todos/plans が archive/ へ移り、内容は残る", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    todoAction(root, g.id, "add", { text: "x" });
    expect(existsSync(todosPath(root, g.id))).toBe(true);
    completeGoal(root);
    expect(existsSync(todosPath(root, g.id))).toBe(false);
    expect(existsSync(planPath(root, g.id))).toBe(false);
    const arch = join(dirname(todosPath(root, g.id)), "archive", `${g.id}.json`);
    expect(existsSync(arch)).toBe(true);
    expect(existsSync(join(dirname(planPath(root, g.id)), "archive", `${g.id}.md`))).toBe(true);
  });
});

describe("goalResumeContext（compact・handoff 共通）", () => {
  test("phase・次の手・残タスク・文書の場所を含み、active なしなら null", () => {
    const root = tmpRoot();
    expect(goalResumeContext(root)).toBeNull();
    const g = startGoal(root, "t", "s").goal;
    addTasks(root, g.id);
    setPhase(root, "implementing");
    const out = goalResumeContext(root, { includeLoop: true })!;
    expect(out).toContain(g.id);
    expect(out).toContain("phase: implementing");
    expect(out).toContain("次のアクション");
    expect(out).toContain("未完了タスク");
    expect(out).toContain("T1 実装する");
    expect(out).toContain(`plans/${g.id}.md`);
    expect(out).toContain("loop:");
  });
});
