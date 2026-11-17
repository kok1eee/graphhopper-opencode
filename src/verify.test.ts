/**
 * verify の採点基準の凍結と severity の読み取り（design g-mwmnvx3x 判断1・4）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildLensPrompt,
  loadRubric,
  parseLensVerdict,
  parseSeverity,
  rubricPath,
  rubricStatus,
  snapshotRubric,
} from "./verify";
import { startGoal, readTodos, writeTodos } from "./state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gh-rubric-"));
  roots.push(root);
  return root;
}
function goal(root: string): string {
  return startGoal(root, "rubric test", "s1").goal.id;
}
const paths = (root: string, id: string) => ({
  designPath: join(root, ".graphhopper", "plans", `${id}.md`),
  diffPath: join(root, ".graphhopper", "tmp", "d.txt"),
  diagPath: join(root, ".graphhopper", "tmp", "diag.txt"),
  intentPath: null,
});

describe("採点基準の凍結（design g-mwmnvx3x 判断1）", () => {
  test("snapshot の固定部分が現行より優先される", () => {
    const root = tmpRoot();
    const id = goal(root);
    const snap = snapshotRubric(root, id);
    expect(snap).not.toBeNull();
    /* 凍結後に固定部分を書き換える（goal が基準を変えた状況） */
    const file = rubricPath(root, id);
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      static: Record<string, string[]>;
      hash: string;
    };
    raw.static["graphhopper-verifier-requirement"] = ["凍結された指示文"];
    writeFileSync(file, JSON.stringify(raw), "utf8");

    const prompt = buildLensPrompt(root, id, "requirement", paths(root, id));
    /* 固定部分は凍結側。ただし内容を書き換えたので hash 不一致＝tampered */
    expect(prompt).toContain("凍結された指示文");
    expect(rubricStatus(root, id).tampered).toBe(true);
  });

  test("凍結したままなら現行と同じで、tampered にならない", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    const st = rubricStatus(root, id);
    expect(st.frozen).toBe(true);
    expect(st.tampered).toBe(false);
    const prompt = buildLensPrompt(root, id, "behavior", paths(root, id));
    expect(prompt).toContain("behavior lens");
  });

  test("動的部分（進捗タスク）は凍結されず、verify 時の現行が入る", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    /* 凍結後にタスクを追加しても prompt に出る */
    writeTodos(root, {
      goal_id: id,
      updated_at: new Date().toISOString(),
      items: [
        { id: "t1", text: "凍結後に足したタスク", status: "pending", updated_at: new Date().toISOString() },
      ],
    });
    expect(readTodos(root, id).items).toHaveLength(1);
    const prompt = buildLensPrompt(root, id, "progress", paths(root, id));
    expect(prompt).toContain("凍結後に足したタスク");
  });

  test("snapshot が無ければ legacy（現行を使う。tampered にしない）", () => {
    const root = tmpRoot();
    const id = goal(root);
    expect(loadRubric(root, id)).toBeNull();
    const st = rubricStatus(root, id);
    expect(st.frozen).toBe(false);
    expect(st.tampered).toBe(false);
    expect(buildLensPrompt(root, id, "general", paths(root, id))).toContain("general lens");
  });

  test("snapshot を消すと frozen=false になり、呼び出し側が改ざんとして扱える", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    rmSync(rubricPath(root, id));
    expect(rubricStatus(root, id)).toMatchObject({ frozen: false, tampered: false });
  });

  test("goal が違う snapshot は読まない", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    const other = "g-other000";
    expect(loadRubric(root, other)).toBeNull();
  });
});

describe("severity の読み取り（design g-mwmnvx3x 判断4）", () => {
  const verdict = (extra: Record<string, unknown>) =>
    `本文\n\`\`\`json\n${JSON.stringify({ level: "clean", summary: "ok", ...extra })}\n\`\`\``;

  test("正常な件数を読む", () => {
    const r = parseLensVerdict(
      verdict({ severity: { must_fix: 0, should_fix: 2, nit: 1, pre_existing: 0 } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.severity).toEqual({
      must_fix: 0,
      should_fix: 2,
      nit: 1,
      pre_existing: 0,
    });
  });

  test("不正値は無視し、判定は止めない", () => {
    const r = parseLensVerdict(
      verdict({ severity: { must_fix: -1, should_fix: "2", nit: 3.5, pre_existing: 1 } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.severity).toEqual({
      must_fix: 0,
      should_fix: 0,
      nit: 0,
      pre_existing: 1,
    });
  });

  test("欠落・空オブジェクトは未申告（undefined）で、0 件と区別する", () => {
    const none = parseLensVerdict(verdict({}));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.verdict.severity).toBeUndefined();
    expect(parseSeverity({})).toBeUndefined();
    expect(parseSeverity(null)).toBeUndefined();
    expect(parseSeverity({ must_fix: 0 })).toEqual({
      must_fix: 0,
      should_fix: 0,
      nit: 0,
      pre_existing: 0,
    });
  });

  test("drift でも severity を読める", () => {
    const r = parseLensVerdict(
      verdict({ level: "drift", target: "implementing", severity: { must_fix: 1 } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.severity?.must_fix).toBe(1);
  });
});
