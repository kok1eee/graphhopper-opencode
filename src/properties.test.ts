/**
 * 性質テスト（design g-mwmnvx3x 判断2）。
 *
 * 「壊れたら必ず落ちる」性質だけを置く。生成器は手書き（fast-check を足さない）。
 * 依存を増やさない代わりに、対象を往復・上限に絞る。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { formatModelRef, parseModelRef } from "./agents";
import { taskWindow } from "./tui-snapshot";
import { readTodos, startGoal, writeTodos } from "./state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gh-prop-"));
  roots.push(root);
  return root;
}

describe("性質: modelRef の往復（encode → decode → encode が一致）", () => {
  const providers = ["claude-oauth", "opencode-go", "amazon-bedrock", "x"];
  const models = ["claude-opus-5-5", "deepseek-v4.1-flash", "global.xai.grok-4.7"];
  const variants = [null, "xhigh", "max", "none"];

  test("全組合せで往復する", () => {
    for (const providerID of providers) {
      for (const model of models) {
        for (const variant of variants) {
          const ref = { providerID, model, ...(variant ? { variant } : {}) };
          const text = formatModelRef(ref);
          const back = parseModelRef(text);
          expect(back).toEqual(ref);
          expect(formatModelRef(back)).toBe(text);
        }
      }
    }
  });
});

describe("性質: taskWindow の上限と安定", () => {
  const item = (n: number, status: "pending" | "in_progress" | "completed" | "cancelled") => ({
    id: `t${n}`,
    text: `T${n}（判断1）: task ${n}`,
    status,
  });

  test("件数にかかわらず窓は最大 5 行・前後の件数が合計と一致する（0 件は null）", () => {
    expect(taskWindow([], 5)).toBeNull();
    const patterns: ("pending" | "in_progress" | "completed" | "cancelled")[][] = [
      ["pending"],
      ["completed", "completed", "pending"],
      ["completed", "completed", "completed", "pending", "pending", "pending"],
      Array.from({ length: 12 }, (_, i) => (i < 8 ? "completed" : "pending")),
      ["cancelled", "cancelled", "pending", "pending", "pending", "pending", "pending"],
    ];
    for (const st of patterns) {
      const items = st.map((s, i) => item(i + 1, s));
      const w = taskWindow(items, 5);
      if (!w) throw new Error("窓が無い（items は非空）");
      expect(w.rows.length).toBeLessThanOrEqual(5);
      expect(w.rows.length + w.before + w.after).toBe(items.length);
    }
  });

  test("in_progress があればそれを窓の先頭にする", () => {
    const items = [
      item(1, "completed"),
      item(2, "pending"),
      item(3, "in_progress"),
      item(4, "pending"),
    ];
    const w = taskWindow(items, 5);
    if (!w) throw new Error("窓が無い");
    expect(w.rows[0]?.mark).toBe("▸3");
    expect(w.before).toBe(2);
  });

  test("同じ入力なら何度計算しても同じ（純粋）", () => {
    const items = [
      item(1, "completed"),
      item(2, "cancelled"),
      item(3, "pending"),
      item(4, "pending"),
      item(5, "in_progress"),
      item(6, "pending"),
    ];
    expect(taskWindow(items, 5)).toEqual(taskWindow(items, 5));
  });

  test("停止した goal のタスクストアでも窓が壊れない（実ストア経由）", () => {
    const root = tmpRoot();
    const id = startGoal(root, "prop", "s1").goal.id;
    writeTodos(root, {
      goal_id: id,
      updated_at: new Date().toISOString(),
      items: Array.from({ length: 7 }, (_, i) => ({
        id: `t${i + 1}`,
        text: `T${i + 1}: x`,
        status: "pending" as const,
        updated_at: new Date().toISOString(),
      })),
    });
    /* 書き込み→読み出しの経路も通す（シリアライズの壊れを検出する） */
    const items = readTodos(root, id).items;
    expect(items).toHaveLength(7);
    const w = taskWindow(items, 5);
    if (!w) throw new Error("窓が無い");
    expect(w.rows).toHaveLength(5);
    expect(w.after).toBe(2);
  });
});
