import { describe, expect, test } from "bun:test";
import {
  addTodo,
  applyMark,
  extractTaskSection,
  formatTodoChip,
  formatTodoList,
  isAllowedTransition,
  isTodoComplete,
  nextTodoId,
  parseSeedTasks,
  parseTaskLines,
  seedMerge,
  todoGateError,
  todoProgress,
  type TodoStore,
} from "./todos";

const NOW = "2026-10-21T00:00:00.000Z";

function store(items: TodoStore["items"] = []): TodoStore {
  return { goal_id: "g-1", items, updated_at: NOW };
}

describe("todo 純粋層", () => {
  describe("parseTaskLines", () => {
    test("チェックボックス行だけ抽出する", () => {
      const r = parseTaskLines(
        "# d\n\n- [x] done1\n- [ ] todo1\n- plain bullet\n-  [ ] indented\n",
      );
      expect(r).toEqual([
        { text: "done1", done: true },
        { text: "todo1", done: false },
        { text: "indented", done: false },
      ]);
    });
    test("テキストは200文字で打ち切る", () => {
      const long = "x".repeat(300);
      expect(parseTaskLines(`- [ ] ${long}`)[0]?.text.length).toBe(200);
    });
  });

  describe("extractTaskSection / parseSeedTasks", () => {
    const doc = [
      "# design",
      "",
      "## 1. goal理解",
      "",
      "- [ ] 目標侧的チェック（タスク列外）",
      "",
      "## 4. 実装タスク列",
      "",
      "- [ ] T1 実装する",
      "- [x] T2 済んだ",
      "",
      "## 受け入れ基準",
      "",
      "- [ ] A1 受け入れ条件（タスク列外）",
    ].join("\n");

    test("タスク列セクションだけを取り出す", () => {
      const sec = extractTaskSection(doc);
      expect(sec).toContain("T1 実装する");
      expect(sec).not.toContain("目標侧的チェック");
      expect(sec).not.toContain("A1 受け入れ条件");
    });
    test("seed はタスク列のチェックボックスだけ", () => {
      expect(parseSeedTasks(doc)).toEqual([
        { text: "T1 実装する", done: false },
        { text: "T2 済んだ", done: true },
      ]);
    });
    test("タスク列セクションが無ければ空", () => {
      expect(parseSeedTasks("# d\n\n- [ ] x\n")).toEqual([]);
      expect(extractTaskSection("# d\n\n- [ ] x\n")).toBe("");
    });
    test("見出しが「タスク列」でなくても「タスク」を含めば拾う（フォールバック）", () => {
      const doc = [
        "# design",
        "",
        "## 2. 現状",
        "",
        "- [ ] 目標側のチェック（別セクション）",
        "",
        "## 4. 実装タスク",
        "",
        "- [ ] T1 実装する",
      ].join("\n");
      expect(parseSeedTasks(doc)).toEqual([{ text: "T1 実装する", done: false }]);
    });
    test("scaffold のプレースホルダは seed 対象外", () => {
      const scaffold = [
        "## 4. 実装タスク列",
        "",
        "- [ ] T1 （タスク）",
      ].join("\n");
      expect(parseSeedTasks(scaffold)).toEqual([]);
    });
  });

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

  describe("seedMerge", () => {
    test("design.md のタスクが seed される", () => {
      const r = seedMerge(
        store(),
        [
          { text: "T1", done: false },
          { text: "T2", done: false },
        ],
        NOW,
      );
      expect(r.added).toBe(2);
      expect(r.store.items.map((i) => i.id)).toEqual(["t1", "t2"]);
      expect(r.store.items.every((i) => i.status === "pending")).toBe(true);
    });
    test("design.md で [x] のタスクは completed で seed される", () => {
      const r = seedMerge(store(), [{ text: "T1", done: true }], NOW);
      expect(r.store.items[0]?.status).toBe("completed");
    });
    test("再 seed は既存タスクを消さず差分だけ足す（idempotent merge）", () => {
      const first = seedMerge(
        store(),
        [
          { text: "A", done: false },
          { text: "B", done: false },
        ],
        NOW,
      );
      // A を完了させた状態で design.md に A/B/C が並ぶ
      const marked = applyMark(first.store, "t1", "completed", { now: NOW });
      const second = seedMerge(
        marked.store,
        [
          { text: "A", done: false },
          { text: "B", done: false },
          { text: "C", done: false },
        ],
        NOW,
      );
      expect(second.added).toBe(1);
      expect(second.store.items.map((i) => i.text)).toEqual(["A", "B", "C"]);
      // 既存の id と status は保つ
      expect(second.store.items[0]?.id).toBe("t1");
      expect(second.store.items[0]?.status).toBe("completed");
      expect(second.store.items[2]?.id).toBe("t3");
    });
    test("design.md 内で同文が複数あれば別 id を振る", () => {
      const r = seedMerge(
        store(),
        [
          { text: "同じ", done: false },
          { text: "同じ", done: false },
        ],
        NOW,
      );
      expect(r.added).toBe(2);
      expect(r.store.items.map((i) => i.id)).toEqual(["t1", "t2"]);
      expect(r.duplicateTexts).toBe(1);
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
