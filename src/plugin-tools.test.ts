/**
 * plugin 側 tool（.opencode/plugins/graphhopper/tools-core.ts）の往復テスト。
 *
 * ファイルは src/ に置いている。`.opencode/` は dot-dir で `bun test` の既定走査対象外のため。
 *
 * なぜ必要か: 本番の主経路は opencode に組み込まれた plugin 側であり、
 * MCP 側の往復テストだけでは plugin の配線（引数の組み立て・拒否理由の返却・
 * 遷移の伝播）を固定できない。実運用経路への回帰を防ぐ。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCoreTools } from "../.opencode/plugins/graphhopper/tools-core";
import { registerOpsTools } from "../.opencode/plugins/graphhopper/tools-ops";
import { formatScoreboard } from "./scoreboard-format";
import { planPath, readTodos, startGoal } from "./state";

interface ToolDef {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-plugin-test-"));
}

/** plugin の tool を fake editor で登録し、名前で取り出す */
function tools(root: string): Map<string, ToolDef> {
  const map = new Map<string, ToolDef>();
  const editor = {
    add: (t: Record<string, unknown>) => {
      map.set(t.name as string, t as unknown as ToolDef);
    },
  };
  // ctx は core tool では root 以外に使わない（session 取得は optional）
  registerCoreTools(editor as never, { ctx: {} as never, root });
  return map;
}

function textOf(out: unknown): string {
  return (out as { content?: string })?.content ?? "";
}

const DESIGN_WITH_TASKS = [
  "# design: plugin test",
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

describe("plugin tool: graphhopper_todo", () => {
  test("goal 不在時は error を返す", async () => {
    const root = tmpRoot();
    const t = tools(root).get("graphhopper_todo");
    const out = await t!.execute({ action: "list" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("no active goal");
  });

  test("list/add/done/cancel がストアに反映される", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    const t = tools(root).get("graphhopper_todo");
    const ctx = { sessionID: "s1" };

    // designing→implementing で seed（plugin 経路）
    const phase = tools(root).get("graphhopper_phase");
    await phase!.execute({ phase: "implementing" }, ctx);
    expect(readTodos(root, g.id).items.length).toBe(2);

    const listed = textOf(await t!.execute({ action: "list" }, ctx));
    expect(listed).toContain("T1 実装する");

    expect(textOf(await t!.execute({ action: "done", id: "t1" }, ctx))).toContain(
      "t1 -> completed",
    );
    expect(textOf(await t!.execute({ action: "cancel", id: "t2" }, ctx))).toContain(
      "reason",
    );
    expect(
      textOf(await t!.execute({ action: "cancel", id: "t2", reason: "不要" }, ctx)),
    ).toContain("t2 -> cancelled");
  });
});

describe("plugin tool: graphhopper_phase の進捗ゲート", () => {
  test("未完了タスクがあれば polish へ進まず、理由が返る", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    const phase = tools(root).get("graphhopper_phase");
    const ctx = { sessionID: "s1" };
    await phase!.execute({ phase: "implementing" }, ctx);
    const out = textOf(await phase!.execute({ phase: "polish" }, ctx));
    expect(out).toContain("未完了");
    expect(out).not.toContain("phase -> polish");
  });

  test("全タスク完了なら polish へ進める", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    const phase = tools(root).get("graphhopper_phase");
    const todo = tools(root).get("graphhopper_todo");
    const ctx = { sessionID: "s1" };
    await phase!.execute({ phase: "implementing" }, ctx);
    await todo!.execute({ action: "done", id: "t1" }, ctx);
    await todo!.execute({ action: "cancel", id: "t2", reason: "不要" }, ctx);
    const out = textOf(await phase!.execute({ phase: "polish" }, ctx));
    expect(out).toContain("phase -> polish");
  });
});

describe("plugin: invoke / scoreboard（MCP一本化）", () => {
  function opsTools(root: string): Map<string, ToolDef> {
    const map = new Map<string, ToolDef>();
    registerOpsTools({ add: (t: Record<string, unknown>) => void map.set(t.name as string, t as unknown as ToolDef) } as never, {
      ctx: {} as never,
      root,
    });
    return map;
  }

  test("invoke と scoreboard が登録される", () => {
    const m = opsTools(tmpRoot());
    expect(m.has("graphhopper_invoke")).toBe(true);
    expect(m.has("graphhopper_scoreboard")).toBe(true);
  });

  test("invoke は fake binary の本文を返す", async () => {
    const dir = tmpRoot();
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, "#!/bin/sh\necho 'critic says OK'\n", { mode: 0o755 });
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const r = (await opsTools(dir).get("graphhopper_invoke")!.execute(
        { agent: "graphhopper-critic", prompt: "x" },
        {},
      )) as { content: string };
      expect(r.content).toContain("critic says OK");
      expect(r.content).not.toContain("[invoke:");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("invoke は signal を伝播し cancelled を末尾に付記する", async () => {
    const dir = tmpRoot();
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, "#!/bin/sh\necho never\n", { mode: 0o755 });
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const ac = new AbortController();
      ac.abort();
      const r = (await opsTools(dir).get("graphhopper_invoke")!.execute(
        { agent: "graphhopper-critic", prompt: "x" },
        { signal: ac.signal },
      )) as { content: string };
      expect(r.content).toContain("[invoke:");
      expect(r.content).toContain("cancelled");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("scoreboard は見出し3つを返す / formatScoreboard", async () => {
    const r = (await opsTools(tmpRoot()).get("graphhopper_scoreboard")!.execute({})) as { content: string };
    expect(r.content).toBe("## models\n## goals\n## hints");
    expect(
      formatScoreboard({
        models: [{ model: "m", role: "verifier", verdicts: 2, clean: 1, drift: 1, mixed: 0 }],
        goals: [],
        hints: ["h"],
      }),
    ).toContain("- verifier m: 2件 (clean 1 / drift 1)");
  });
});
