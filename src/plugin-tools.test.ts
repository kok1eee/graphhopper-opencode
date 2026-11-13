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
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { compliantDesignDoc } from "./design-fixture";
import { join } from "node:path";
import { registerCoreTools } from "../.opencode/plugins/graphhopper/tools-core";
import { registerOpsTools } from "../.opencode/plugins/graphhopper/tools-ops";
import { readHandoff, handoffPath } from "./handoff";
import { resumeGoal } from "./state";
import { formatScoreboard } from "./scoreboard-format";
import {
  computeDiffHash,
  pauseGoal,
  planPath,
  readTodos,
  setVerifierVerdict,
  startGoal,
} from "./state";

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
function tools(root: string, ctx: unknown = {}): Map<string, ToolDef> {
  const map = new Map<string, ToolDef>();
  const editor = {
    add: (t: Record<string, unknown>) => {
      map.set(t.name as string, t as unknown as ToolDef);
    },
  };
  // ctx は status/intent capture で session API を触る場合だけ差し替える
  registerCoreTools(editor as never, { ctx: ctx as never, root });
  return map;
}

function textOf(out: unknown): string {
  return (out as { content?: string })?.content ?? "";
}

const DESIGN_WITH_TASKS = compliantDesignDoc({
  title: "plugin test",
  tasks: ["- [ ] T1（判断1）: 実装する", "- [ ] T2（判断1）: テストを書く"],
});

describe("plugin tool: goal start の意図ログ（design g-mwebh9vl）", () => {
  test("start で intent.md を作り、start 応答と status に path を出す", async () => {
    const root = tmpRoot();
    const ctx = {
      session: {
        context: async () => [
          { type: "user", text: "こうしたい" },
          {
            type: "assistant",
            content: [
              { type: "text", text: "こうしましょう" },
              { type: "tool", text: "ignored" },
            ],
          },
          { type: "user", text: "[graphhopper] 内部注入" },
        ],
      },
    };
    const t = tools(root, ctx).get("graphhopper_goal");
    const out = await t!.execute({ action: "start", title: "t" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("intent:");

    const dir = join(root, ".graphhopper", "plans");
    const file = readdirSync(dir).find((f) => f.endsWith(".intent.md"));
    expect(file).toBeDefined();
    const body = readFileSync(join(dir, file!), "utf8");
    expect(body).toContain("me: こうしたい");
    expect(body).toContain("assistant: こうしましょう");
    expect(body).not.toContain("ignored");
    expect(body).not.toContain("内部注入");

    const status = await tools(root, ctx)
      .get("graphhopper_status")!
      .execute({}, { sessionID: "s1" });
    expect(textOf(status)).toContain("intent:");
  });

  test("session.context が失敗しても start は成功し、intent は作られない", async () => {
    const root = tmpRoot();
    const ctx = {
      session: {
        context: async () => {
          throw new Error("boom");
        },
      },
    };
    const t = tools(root, ctx).get("graphhopper_goal");
    const out = await t!.execute({ action: "start", title: "t" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("goal started");
    expect(textOf(out)).not.toContain("intent:");
    const dir = join(root, ".graphhopper", "plans");
    expect(readdirSync(dir).some((f) => f.endsWith(".intent.md"))).toBe(false);
  });
});

describe("plugin tool: complete の diff hash ゲート（design g-mwd3n5bo）", () => {
  test("検証後に差分が変わると拒否し、force で通り goal_complete に残る", async () => {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const rev = (await $`git -C ${root} rev-parse HEAD`.text()).trim();

    startGoal(root, "t", "s1");
    setVerifierVerdict(root, {
      level: "clean",
      reason: "ok",
      target: null,
      lens: ["general"],
      diff_hash: await computeDiffHash($, root, rev),
    });
    await Bun.write(`${root}/a.txt`, "one\ntwo\n");

    const t = tools(root).get("graphhopper_goal");
    const refused = await t!.execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(refused)).toContain("検証後に差分が変わっています");

    const forced = await t!.execute(
      { action: "complete", force: true },
      { sessionID: "s1" },
    );
    expect(textOf(forced)).toContain("completed");

    const events = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = events.find((e) => e.type === "goal_complete");
    expect(done?.forced).toBe(true);
    expect(done?.diff_gate).toBe("forced");
  });

  test("VCS が無い環境ではゲートは素通りする（fail-open）", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "s1");
    setVerifierVerdict(root, {
      level: "clean",
      reason: "ok",
      target: null,
      lens: ["general"],
      diff_hash: null,
    });
    const t = tools(root).get("graphhopper_goal");
    const out = await t!.execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("completed");
  });
});

describe("plugin tool: resume の catalog 警告（design g-mw8xvsg8）", () => {
  test("catalog に deny モデルが焼かれていると resume 応答に警告が付く", async () => {
    const prevCfg = process.env.GRAPHHOPPER_CONFIG;
    const cfgPath = join(tmpRoot(), "global.json");
    writeFileSync(cfgPath, JSON.stringify({ model_deny: ["opencode-go/gpt-*"] }), "utf8");
    process.env.GRAPHHOPPER_CONFIG = cfgPath;
    try {
      const root = tmpRoot();
      startGoal(root, "t", "s1");
      pauseGoal(root);
      const agentsDir = join(root, ".opencode", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "graphhopper-critic.md"),
        '---\nmodel: "opencode-go/gpt-6-luna"\n---\nbody\n',
        "utf8",
      );
      const t = tools(root).get("graphhopper_goal");
      const out = await t!.execute({ action: "resume" }, { sessionID: "s1" });
      const text = textOf(out);
      expect(text).toContain("resumed:");
      expect(text).toContain("gen-agents");
    } finally {
      if (prevCfg === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prevCfg;
    }
  });
});

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
    expect(listed).toContain("T1（判断1）: 実装する");

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

describe("plugin: handoff（ファイル書き出し型）", () => {
  function ops(root: string): Map<string, ToolDef> {
    const map = new Map<string, ToolDef>();
    registerOpsTools({ add: (t: Record<string, unknown>) => void map.set(t.name as string, t as unknown as ToolDef) } as never, {
      ctx: {} as never,
      root,
    });
    return map;
  }
  const run = async (m: Map<string, ToolDef>, input: Record<string, unknown>, sid: string) =>
    (await m.get("graphhopper_handoff")!.execute(input, { sessionID: sid })) as { content: string };

  test("write → load の往復で phase と goal が引き継がれ、ズレ報告が出ない", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "handoff 往復", "ses_old");
    const m = ops(root);
    const w = await run(m, {}, "ses_old");
    expect(w.content).toContain("handoff メモを書いた");
    const memo = readHandoff(root);
    expect(memo?.meta.pending).toBe(true);
    // pause してから書くので status は paused（load 時の偽のズレを作らない）
    expect(memo?.meta.status).toBe("paused");
    const l = await run(m, { action: "load" }, "ses_new");
    expect(l.content).toContain("resumed:");
    expect(l.content).toContain("ズレなし");
    expect(l.content).toContain(g.goal.id);
    expect(readHandoff(root)?.meta.pending).toBe(false);
  });

  test("メモが無いときの load は error", async () => {
    const root = tmpRoot();
    startGoal(root, "handoff なし", "ses_a");
    const r = await run(ops(root), { action: "load" }, "ses_b");
    expect(r.content).toContain("error:");
    expect(handoffPath(root)).toContain("HANDOFF.md");
  });

  test("goal が無く中身も無い write は error（空メモを作らない）", async () => {
    const r = await run(ops(tmpRoot()), {}, "ses_a");
    expect(r.content).toContain("error: 書き出す内容が無い");
  });

  test("goal が無くても note があれば session メモを書き、load で読める", async () => {
    const root = tmpRoot();
    const m = ops(root);
    const w = await run(m, { note: "旧版の削除は 2.1.3 だけ残っている" }, "ses_a");
    expect(w.content).toContain("handoff メモ（goal なし）を書いた");
    const memo = readHandoff(root);
    expect(memo?.meta.kind).toBe("session");
    expect(memo?.meta.goal_id).toBe("");
    const l = await run(m, { action: "load" }, "ses_b");
    expect(l.content).toContain("旧版の削除は 2.1.3 だけ残っている");
    expect(readHandoff(root)?.meta.pending).toBe(false);
  });

  test("active な goal があるセッションでは session メモを load できない", async () => {
    const root = tmpRoot();
    startGoal(root, "別作業", "ses_a");
    const m = ops(root);
    // goal メモを書いてから上書きで session メモを作る
    await run(m, { note: "作業メモ" }, "ses_a");
    const goalMemo = readHandoff(root)!;
    expect(goalMemo.meta.kind).toBe("goal");
    // session メモは goal 完了後にしか書けないので、state を直接いじらず
    // goal メモを session 扱いに変えて load の拒否だけを確認する
    const raw = require("node:fs").readFileSync(handoffPath(root), "utf8") as string;
    require("node:fs").writeFileSync(
      handoffPath(root),
      raw.replace("kind: goal", "kind: session").replace(/goal_id: .*/u, "goal_id: "),
    );
    const r = await run(ops(root), { action: "load" }, "ses_b");
    expect(r.content).toContain("active な goal があるセッションでは読めない");
  });

  test("別セッションが実行中の goal は write できない", async () => {
    const root = tmpRoot();
    startGoal(root, "bind 済み", "ses_a");
    const r = await run(ops(root), {}, "ses_b");
    expect(r.content).toContain("別セッション (ses_a)");
    expect(readHandoff(root)).toBeNull();
  });

  test("別セッションが実行中の goal は load で横取りできず pending も据え置く", async () => {
    const root = tmpRoot();
    startGoal(root, "bind 済み load", "ses_a");
    const m = ops(root);
    await run(m, {}, "ses_a");
    resumeGoal(root, "ses_a");
    const r = await run(m, { action: "load" }, "ses_b");
    expect(r.content).toContain("別セッション (ses_a)");
    expect(readHandoff(root)?.meta.pending).toBe(true);
  });

  test("goal が無くても、pending な別 goal のメモは上書きしない", async () => {
    const src = tmpRoot();
    startGoal(src, "未読のまま", "ses_a");
    await run(ops(src), {}, "ses_a");
    const memoText = readFileSync(handoffPath(src), "utf8");

    // goal が無い別 root に、その未読メモを置く
    const dst = tmpRoot();
    mkdirSync(join(dst, ".graphhopper"), { recursive: true });
    writeFileSync(handoffPath(dst), memoText);
    const blocked = await run(ops(dst), { note: "上書きしたい" }, "ses_b");
    expect(blocked.content).toContain("未読の handoff メモ");
    expect(readHandoff(dst)?.meta.kind).toBe("goal");

    const forced = await run(ops(dst), { note: "上書きしたい", overwrite: true }, "ses_b");
    expect(forced.content).toContain("handoff メモ（goal なし）を書いた");
    expect(readHandoff(dst)?.meta.kind).toBe("session");
  });

  test("pending な別 goal のメモは overwrite なしで上書きできない", async () => {
    const root = tmpRoot();
    startGoal(root, "一度目の goal", "ses_a");
    const m = ops(root);
    await run(m, {}, "ses_a");
    // メモの goal_id を別の goal に書き換えて「別 goal の未読メモ」を作る
    const raw = readFileSync(handoffPath(root), "utf8");
    writeFileSync(handoffPath(root), raw.replace(/^goal_id: .*$/mu, "goal_id: g-other"));
    const blocked = await run(m, {}, "ses_a");
    expect(blocked.content).toContain("未読の handoff メモ（別 goal: g-other）");
    const forced = await run(m, { overwrite: true }, "ses_a");
    expect(forced.content).toMatch(/handoff メモを書いた/);
  });

  test("compaction 要約があればメモに添付される（GH_HANDOFF_DB で DB を差し替え）", async () => {
    const root = tmpRoot();
    const db = join(root, "opencode.db");
    const d = new Database(db);
    d.exec(`CREATE TABLE session_message (id text primary key, session_id text not null, type text not null,
      seq integer, time_created integer not null, time_updated integer, data text not null)`);
    d.prepare(
      "insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?,?,'compaction',1,?,?,?)",
    ).run(
      "m1",
      "ses_sum",
      1793080902544,
      1793080902544,
      JSON.stringify({
        status: "completed",
        reason: "auto",
        model: { providerID: "claude-oauth", id: "claude-opus-5-5" },
        summary: "## Objective\n- 旧版を消す",
        time: { created: 1793080902544 },
      }),
    );
    d.close();
    const prev = process.env["GH_HANDOFF_DB"];
    process.env["GH_HANDOFF_DB"] = db;
    try {
      const r = await run(ops(root), { note: "作業メモ", sessionID: "ses_sum" }, "ses_sum");
      expect(r.content).toContain("会話の要約を添付");
      const memo = readHandoff(root)!;
      expect(memo.meta.kind).toBe("session");
      expect(memo.body).toContain("## 参考: 会話の要約（compact 時点）");
      expect(memo.body).toContain("claude-opus-5-5");
      expect(memo.body).toContain("旧版を消す");
    } finally {
      if (prev === undefined) delete process.env["GH_HANDOFF_DB"];
      else process.env["GH_HANDOFF_DB"] = prev;
    }
  });

  test("clear でメモが消える", async () => {
    const root = tmpRoot();
    startGoal(root, "handoff clear", "ses_a");
    const m = ops(root);
    await run(m, {}, "ses_a");
    expect((await run(m, { action: "clear" }, "ses_a")).content).toContain("削除");
    expect(readHandoff(root)).toBeNull();
  });
});
