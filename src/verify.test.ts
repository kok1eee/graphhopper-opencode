/**
 * verify の採点基準の凍結と severity の読み取り（design g-mwmnvx3x 判断1・4）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildAnglePrompt,
  loadRubric,
  parseLensVerdict,
  parseSeverity,
  RUBRIC_CODE_FILES,
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
const ent = (id: string) => ({ id, title: id, doubt: "d", scope: "s", source: "list" as const, carried: false });
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
    raw.static["common"] = ["凍結された指示文"];
    writeFileSync(file, JSON.stringify(raw), "utf8");

    const prompt = buildAnglePrompt(root, id, ent("wiring"), paths(root, id));
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
    const prompt = buildAnglePrompt(root, id, ent("wiring"), paths(root, id));
    expect(prompt).toContain("疑うこと");
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
    const prompt = buildAnglePrompt(root, id, ent("agreement"), paths(root, id));
    expect(prompt).toContain("凍結後に足したタスク");
  });

  test("snapshot が無ければ legacy（現行を使う。tampered にしない）", () => {
    const root = tmpRoot();
    const id = goal(root);
    expect(loadRubric(root, id)).toBeNull();
    const st = rubricStatus(root, id);
    expect(st.frozen).toBe(false);
    expect(st.tampered).toBe(false);
    expect(buildAnglePrompt(root, id, ent("wiring"), paths(root, id))).toContain("疑うこと");
  });

  test("snapshot を消すと frozen=false になり、呼び出し側が改ざんとして扱える", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    rmSync(rubricPath(root, id));
    expect(rubricStatus(root, id)).toMatchObject({ frozen: false, tampered: false });
  });

  test("repo 側の agent 定義の変化も検知する（g-mwmqmg6b 判断5）", () => {
    const repoAgent = join(import.meta.dir, "..", ".opencode", "agents", "graphhopper-verifier.md");
    const before = existsSync(repoAgent) ? readFileSync(repoAgent, "utf8") : null;
    if (before === null) return;
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    try {
      writeFileSync(repoAgent, `${before}\n<!-- changed -->\n`, "utf8");
      expect(rubricStatus(root, id).agentChanged).toBe(true);
    } finally {
      writeFileSync(repoAgent, before, "utf8");
    }
    expect(rubricStatus(root, id).agentChanged).toBe(false);
  });

  test("採点コードの監視対象に state.ts は無く verdict.ts がある（g-mwmqmg6b 判断5）", () => {
    expect(RUBRIC_CODE_FILES).toContain("verdict.ts");
    expect(RUBRIC_CODE_FILES).toContain("angles.ts");
    expect(RUBRIC_CODE_FILES).not.toContain("state.ts");
    for (const f of RUBRIC_CODE_FILES) expect(existsSync(join(import.meta.dir, f))).toBe(true);
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

describe("角度の prompt と prior（design g-mwmqmg6b 判断1・4）", () => {
  const entry = (id: string, carried = false) => ({
    id,
    title: `題-${id}`,
    doubt: `疑う-${id}`,
    scope: `範囲-${id}`,
    source: "list" as const,
    carried,
  });
  const p = { designPath: "/d.md", diffPath: "/diff", diagPath: "/diag", intentPath: "/intent.md", priorPath: "/prior.md", findingsPath: "/find.md" };

  test("題・疑うこと・範囲が入る。意図ログは agreement だけ", () => {
    const root = tmpRoot();
    const id = goal(root);
    const a = buildAnglePrompt(root, id, entry("wiring"), p);
    expect(a).toContain("題-wiring");
    expect(a).toContain("疑う-wiring");
    expect(a).toContain("範囲-wiring");
    expect(a).not.toContain("/intent.md");
    expect(buildAnglePrompt(root, id, entry("agreement"), p)).toContain("/intent.md");
  });

  test("siblings と持ち越しには指摘ファイルが入る。通常は入らない", () => {
    const root = tmpRoot();
    const id = goal(root);
    expect(buildAnglePrompt(root, id, entry("siblings"), p)).toContain("/find.md");
    expect(buildAnglePrompt(root, id, entry("siblings"), p)).not.toContain("/prior.md");
    expect(buildAnglePrompt(root, id, entry("siblings", true), p)).toContain("/prior.md");
    expect(buildAnglePrompt(root, id, entry("wiring", true), p)).toContain("/prior.md");
    expect(buildAnglePrompt(root, id, entry("wiring"), p)).not.toContain("/prior.md");
  });

  const fence = (o: object) => "x\n```json\n" + JSON.stringify(o) + "\n```";
  test("prior を読める。unresolved があれば clean は drift になる", () => {
    const ok = parseLensVerdict(fence({ level: "clean", summary: "s", prior: { valid: 1, invalid: 0, unresolved: 0 } }));
    expect(ok.ok && ok.verdict.prior).toEqual({ valid: 1, invalid: 0, unresolved: 0 });
    expect(ok.ok && ok.verdict.level).toBe("clean");
    const bad = parseLensVerdict(fence({ level: "clean", summary: "s", prior: { valid: 0, invalid: 0, unresolved: 2 } }));
    expect(bad.ok && bad.verdict.level).toBe("drift");
  });
});

describe("凍結の新しい形（design g-mwmqmg6b 判断6）", () => {
  const rewrite = (root: string, id: string, f: (r: Record<string, unknown>) => void) => {
    const file = rubricPath(root, id);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    f(raw);
    writeFileSync(file, JSON.stringify(raw), "utf8");
  };

  test("v2 は共通ルールだけを凍結する。共通ルールを書き換えると改ざん", () => {
    const root = tmpRoot();
    const id = goal(root);
    const snap = snapshotRubric(root, id);
    expect(snap?.v).toBe(2);
    expect(Object.keys(snap?.static ?? {})).toEqual(["common"]);
    rewrite(root, id, (r) => ((r["static"] as Record<string, string[]>)["common"] = ["改ざん"]));
    expect(rubricStatus(root, id).tampered).toBe(true);
  });

  test("前の形（v 無し）の凍結は読まれない（凍結なしと同じ）", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    rewrite(root, id, (r) => delete r["v"]);
    expect(loadRubric(root, id)).toBeNull();
    expect(rubricStatus(root, id).frozen).toBe(false);
  });

  test("角度の文面は凍結に入らず、prompt には現行の文面が出る", () => {
    const root = tmpRoot();
    const id = goal(root);
    snapshotRubric(root, id);
    const e = { id: "x", title: "新しい題", doubt: "新しい疑い", scope: "s", source: "created" as const, carried: false };
    const p = buildAnglePrompt(root, id, e, { designPath: "/d", diffPath: "/f", diagPath: "/g", intentPath: null });
    expect(p).toContain("新しい疑い");
    expect(rubricStatus(root, id).tampered).toBe(false);
  });
});
