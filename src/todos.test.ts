import { describe, expect, test } from "bun:test";
import {
  addTodo,
  applyMark,
  formatTodoChip,
  formatTodoList,
  isAllowedTransition,
  isTodoComplete,
  nextTodoId,
  todoGateError,
  todoProgress,
  type TodoStore,
} from "./todos";

const NOW = "2026-10-21T00:00:00.000Z";

function store(items: TodoStore["items"] = []): TodoStore {
  return { goal_id: "g-1", items, updated_at: NOW };
}

describe("todo 純粋層", () => {
  describe("nextTodoId", () => {
    test("連番の最大+1", () => {
      expect(nextTodoId([])).toBe("t1");
      expect(
        nextTodoId([
          { id: "t1", text: "a", status: "pending", updated_at: NOW },
          { id: "t7", text: "b", status: "pending", updated_at: NOW },
        ]),
      ).toBe("t8");
    });
  });

  describe("状態遷移", () => {
    test("許可される遷移", () => {
      expect(isAllowedTransition("pending", "in_progress")).toBe(true);
      expect(isAllowedTransition("pending", "completed")).toBe(true);
      expect(isAllowedTransition("pending", "cancelled")).toBe(true);
      expect(isAllowedTransition("in_progress", "pending")).toBe(true);
      expect(isAllowedTransition("completed", "in_progress")).toBe(true);
      expect(isAllowedTransition("cancelled", "pending")).toBe(true);
    });
    test("禁止される遷移", () => {
      expect(isAllowedTransition("completed", "pending")).toBe(false);
      expect(isAllowedTransition("cancelled", "completed")).toBe(false);
    });
  });

  describe("applyMark", () => {
    const s = store([{ id: "t1", text: "A", status: "pending", updated_at: NOW }]);
    test("状態変更できる", () => {
      const r = applyMark(s, "t1", "in_progress", { now: NOW });
      expect(r.ok).toBe(true);
      expect(r.store.items[0]?.status).toBe("in_progress");
    });
    test("存在しない id は error、ストアは不変", () => {
      const r = applyMark(s, "tX", "completed", { now: NOW });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("tX");
      expect(r.store).toBe(s);
    });
    test("cancel には reason が要る", () => {
      const r = applyMark(s, "t1", "cancelled", { now: NOW });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("reason");
      const ok = applyMark(s, "t1", "cancelled", { now: NOW, reason: "不要になった" });
      expect(ok.ok).toBe(true);
      expect(ok.store.items[0]?.reason).toBe("不要になった");
    });
    test("cancel 以外の遷移で reason は消える", () => {
      const c = applyMark(s, "t1", "cancelled", { now: NOW, reason: "x" });
      const back = applyMark(c.store, "t1", "pending", { now: NOW });
      expect(back.store.items[0]?.reason).toBeUndefined();
    });
  });

  describe("addTodo", () => {
    test("追加できる", () => {
      const r = addTodo(store(), "  新しいタスク  ", NOW);
      expect(r.ok).toBe(true);
      expect(r.id).toBe("t1");
      expect(r.store.items[0]?.text).toBe("新しいタスク");
    });
    test("空文字は拒否", () => {
      expect(addTodo(store(), "   ", NOW).ok).toBe(false);
    });
  });

  describe("todoProgress / isTodoComplete", () => {
    test("集計", () => {
      const s = store([
        { id: "t1", text: "A", status: "completed", updated_at: NOW },
        { id: "t2", text: "B", status: "cancelled", updated_at: NOW },
        { id: "t3", text: "C", status: "pending", updated_at: NOW },
        { id: "t4", text: "D", status: "in_progress", updated_at: NOW },
      ]);
      expect(todoProgress(s)).toMatchObject({
        total: 4,
        done: 1,
        cancelled: 1,
        open: 2,
      });
      expect(isTodoComplete(s)).toBe(false);
      expect(isTodoComplete(store())).toBe(true);
    });
  });

  describe("todoGateError", () => {
    test("未完了があれば拒否メッセージ", () => {
      const s = store([
        { id: "t1", text: "A", status: "completed", updated_at: NOW },
        { id: "t2", text: "B", status: "pending", updated_at: NOW },
      ]);
      const err = todoGateError(s);
      expect(err).toContain("未完了");
      expect(err).toContain("t2");
    });
    test("全件完了・cancel なら null", () => {
      const s = store([
        { id: "t1", text: "A", status: "completed", updated_at: NOW },
        { id: "t2", text: "B", status: "cancelled", updated_at: NOW },
      ]);
      expect(todoGateError(s)).toBeNull();
    });
    test("タスク 0 件なら null（ゲートしない）", () => {
      expect(todoGateError(store())).toBeNull();
    });
  });

  describe("表示", () => {
    test("formatTodoList", () => {
      const s = store([
        { id: "t1", text: "A", status: "completed", updated_at: NOW },
        { id: "t2", text: "B", status: "pending", updated_at: NOW },
      ]);
      const out = formatTodoList(s);
      expect(out).toContain("[x] t1: A");
      expect(out).toContain("[ ] t2: B");
      expect(out).toContain("完了 1/2");
    });
    test("formatTodoChip はタスク 0 件で null", () => {
      expect(formatTodoChip({ total: 0, done: 0 })).toBeNull();
      expect(formatTodoChip({ total: 1, done: 1 })).toBe("✓1/1");
      expect(formatTodoChip({ total: 3, done: 2 })).toBe("✓2/3");
    });
  });
});
