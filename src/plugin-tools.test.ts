/**
 * plugin 側 tool（.opencode/plugins/graphhopper/tools-core.ts）の往復テスト。
 *
 * ファイルは src/ に置いている。`.opencode/` は dot-dir で `bun test` の既定走査対象外のため。
 *
 * なぜ必要か: 本番の経路は opencode に組み込まれた plugin であり、純関数テスト
 * だけでは plugin の配線（引数の組み立て・拒否理由の返却・遷移の伝播）を
 * 固定できない。実運用経路への回帰を防ぐ。
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { compliantDesignDoc, fillCompliantDesign } from "./design-fixture";
import { join } from "node:path";
import { registerCoreTools } from "../.opencode/plugins/graphhopper/tools-core";
import { registerOpsTools } from "../.opencode/plugins/graphhopper/tools-ops";
import { readHandoff, handoffPath } from "./handoff";
import { resumeGoal } from "./state";
import { formatScoreboard } from "./scoreboard-format";
import {
  buildLineage,
  computeDiffHash,
  pauseGoal,
  recordEvent,
  planPath,
  readTodos,
  getActive,
  readState,
  setVerifierVerdict,
  startGoal,
  todosPath,
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

/** verifier_set の前提（今の diff の計画）を直接置く。stash 指紋と計画の指紋を合わせる */
async function seedPlan(root: string, ids: string[] = ["agreement"]): Promise<void> {
  const st = await import("./state");
  const { $ } = await import("bun");
  const gid = st.getActive(root)!.goal.id;
  const base = await st.resolveBaseline($, root, st.getActive(root)!.state);
  const H = (await st.computeDiffHash($, root, base)) ?? "H";
  st.setStashDiffHash(root, H);
  st.writeSavedVerify(root, gid, {
    v: 2,
    diff_hash: H,
    plan: {
      diff_hash: H,
      entries: ids.map((id) => ({ id, title: id, doubt: "d", scope: "s", source: "list" as const, carried: false })),
    },
    results: [],
  });
}

/** ops 系（verifier_set / usability_set / invoke など）を fake editor で登録する */
function opsTools(root: string, ctx: unknown = {}): Map<string, ToolDef> {
  const map = new Map<string, ToolDef>();
  registerOpsTools({ add: (t: Record<string, unknown>) => void map.set(t.name as string, t as unknown as ToolDef) } as never, {
    ctx: ctx as never,
    root,
  });
  return map;
}

function textOf(out: unknown): string {
  return (out as { content?: string })?.content ?? "";
}

const DESIGN_WITH_TASKS = compliantDesignDoc({
  title: "plugin test",
  tasks: ["- [ ] T1（判断1）: 実装する", "- [ ] T2（判断1）: テストを書く"],
});

describe("plugin tool: strong モード（design g-mwfnlpr9）", () => {
  test("start(strong) で strong_mode が入り status に出る", async () => {
    const root = tmpRoot();
    const goal = tools(root).get("graphhopper_goal");
    const out = await goal!.execute(
      { action: "start", title: "t", strong: true },
      { sessionID: "s1" },
    );
    expect(textOf(out)).toContain("strong: on");
    const status = await tools(root)
      .get("graphhopper_status")!
      .execute({}, { sessionID: "s1" });
    expect(textOf(status)).toContain("strong: on");
  });

  test("complete で strong_mode が false に戻る", async () => {
    const root = tmpRoot();
    await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "start", title: "t", strong: true }, { sessionID: "s1" });
    await seedPlan(root);
    await opsTools(root)
      .get("graphhopper_verifier_set")!
      .execute(
        { results: [{ lens: "agreement", level: "clean" }], reason: "ok" },
        { sessionID: "s1" },
      );
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("completed");
    expect(readState(root).strong_mode).toBe(false);
  });
});

describe("plugin tool: usability ゲート（design g-mwfltxyt）", () => {
  test("skipped は reason 必須、clean は status に出る", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "s1");
    const t = opsTools(root).get("graphhopper_usability_set");
    const empty = await t!.execute({ level: "skipped", reason: "  " }, { sessionID: "s1" });
    expect(textOf(empty)).toContain("reason は必須");

    const ok = await t!.execute(
      { level: "skipped", reason: "typo のみ" },
      { sessionID: "s1" },
    );
    expect(textOf(ok)).toContain("usability: skipped");
    const status = await tools(root)
      .get("graphhopper_status")!
      .execute({}, { sessionID: "s1" });
    expect(textOf(status)).toContain("usability: skipped");
  });

  test("ルール文書を変えた goal は記録なしで complete できず、記録後は通る", async () => {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    // 実 repo と同じく .graphhopper/ は ignore する（state 書き込みを diff に含めない）
    await Bun.write(`${root}/.gitignore`, ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();

    startGoal(root, "t", "s1");
    mkdirSync(`${root}/skills/x`, { recursive: true });
    await Bun.write(`${root}/skills/x/SKILL.md`, "# rule\n");
    // git の diff は untracked を拾わないため index に載せる（実運用は jj なので不要）
    await $`git -C ${root} add -A`.quiet();
    await seedPlan(root);
    await opsTools(root)
      .get("graphhopper_verifier_set")!
      .execute(
        { results: [{ lens: "agreement", level: "clean" }], reason: "ok" },
        { sessionID: "s1" },
      );

    const goal = tools(root).get("graphhopper_goal");
    expect(textOf(await goal!.execute({ action: "complete" }, { sessionID: "s1" }))).toContain(
      "ルール文書が変更されています",
    );

    await opsTools(root)
      .get("graphhopper_usability_set")!
      .execute({ level: "clean", reason: "問題なし" }, { sessionID: "s1" });
    expect(textOf(await goal!.execute({ action: "complete" }, { sessionID: "s1" }))).toContain(
      "completed",
    );
  });
});

describe("plugin tool: usability ゲートの force 迂回（design g-mwfltxyt）", () => {
  test("記録なしでも force: true で完了できる", async () => {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    await Bun.write(`${root}/.gitignore`, ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();

    startGoal(root, "t", "s1");
    mkdirSync(`${root}/skills/x`, { recursive: true });
    await Bun.write(`${root}/skills/x/SKILL.md`, "# rule\n");
    await $`git -C ${root} add -A`.quiet();
    await seedPlan(root);
    await opsTools(root)
      .get("graphhopper_verifier_set")!
      .execute(
        { results: [{ lens: "agreement", level: "clean" }], reason: "ok" },
        { sessionID: "s1" },
      );

    const goal = tools(root).get("graphhopper_goal");
    expect(
      textOf(await goal!.execute({ action: "complete", force: true }, { sessionID: "s1" })),
    ).toContain("completed");
  });
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

describe("plugin tool: implementing へ進むとき意図ログに designing 中の会話を足す", () => {
  test("開始後の質問と答えが後ろに足され、開始時の部分は残る", async () => {
    const root = tmpRoot();
    const msgs: Record<string, unknown>[] = [
      { type: "user", text: "こうしたい", time: { created: 1 } },
      { type: "assistant", content: [{ type: "text", text: "調べます" }], time: { created: 2 } },
    ];
    const ctx = { session: { context: async () => msgs } };
    await tools(root, ctx)
      .get("graphhopper_goal")!
      .execute({ action: "start", title: "t" }, { sessionID: "s1" });
    const dir = join(root, ".graphhopper", "plans");
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".intent.md"))!);
    const before = readFileSync(file, "utf8");
    expect(before).not.toContain("designing 中の会話");

    const later = Date.now() + 60_000;
    msgs.push(
      { type: "assistant", content: [{ type: "text", text: "A と B のどちらにしますか" }], time: { created: later } },
      { type: "user", text: "A で", time: { created: later + 1 } },
    );
    fillCompliantDesign(root);
    const out = await tools(root, ctx)
      .get("graphhopper_phase")!
      .execute({ phase: "implementing" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("phase -> implementing");

    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before.trimEnd())).toBe(true);
    const tail = after.slice(before.trimEnd().length);
    expect(tail).toContain("## designing 中の会話");
    expect(tail).toContain("assistant: A と B のどちらにしますか");
    expect(tail).toContain("me: A で");
    expect(tail).not.toContain("こうしたい");
  });

  test("会話の取得に失敗しても遷移は通り、意図ログは変わらない", async () => {
    const root = tmpRoot();
    let fail = false;
    const ctx = {
      session: {
        context: async () => {
          if (fail) throw new Error("boom");
          return [{ type: "user", text: "こうしたい", time: { created: 1 } }];
        },
      },
    };
    await tools(root, ctx)
      .get("graphhopper_goal")!
      .execute({ action: "start", title: "t" }, { sessionID: "s1" });
    const dir = join(root, ".graphhopper", "plans");
    const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".intent.md"))!);
    const before = readFileSync(file, "utf8");
    fail = true;
    fillCompliantDesign(root);
    const out = await tools(root, ctx)
      .get("graphhopper_phase")!
      .execute({ phase: "implementing" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("phase -> implementing");
    expect(readFileSync(file, "utf8")).toBe(before);
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

describe("diff ゲート: .graphhopper/ を追跡した repo でも complete できる（design g-mwiu6lcj）", () => {
  type Out = { output: Record<string, unknown>; content: string };
  const outOf = (r: unknown): Out => r as Out;

  /** .graphhopper/ を gitignore せず commit した repo（不具合の再現条件） */
  async function trackedGhRoot(): Promise<string> {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".graphhopper", "plans"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x\n");
    writeFileSync(join(root, ".graphhopper", "history.jsonl"), "");
    writeFileSync(join(root, ".graphhopper", "state.json"), "{}\n");
    writeFileSync(join(root, ".graphhopper", "config.example.json"), "{}\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    return root;
  }

  test("diff_stash → verifier_set → complete が force なしで通る", async () => {
    const root = await trackedGhRoot();
    startGoal(root, "tracked", "s1");
    writeFileSync(join(root, "src", "a.ts"), "x\ny\n");
    const m = opsTools(root);
    await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
    {
      const st = await import("./state");
      const h = st.getStashDiffHash(root)!;
      st.writeSavedVerify(root, st.getActive(root)!.goal.id, {
        v: 2,
        diff_hash: h,
        plan: { diff_hash: h, entries: [{ id: "agreement", title: "t", doubt: "d", scope: "s", source: "list", carried: false }] },
        results: [],
      });
    }
    await m.get("graphhopper_verifier_set")!.execute(
      { results: [{ lens: "agreement", level: "clean" }], reason: "ok" },
      { sessionID: "s1" },
    );
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
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
        join(agentsDir, "graphhopper-librarian.md"),
        '---\nmodel: "opencode-go/gpt-6-luna"\n---\nbody\n',
        "utf8",
      );
      const t = tools(root).get("graphhopper_goal");
      const out = await t!.execute({ action: "resume" }, { sessionID: "s1" });
      const text = textOf(out);
      expect(text).toContain("resumed:");
      expect(text).toContain("gen-agents");
      /* resume の応答にも次のアクションを出す（design g-mwj6481n 判断7。
       * entry の同期に失敗しても phase 案内が消えないようにする） */
      expect(text).toContain("次: ");
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

    // 決定記録にチェックボックスがあっても、遷移ではタスクは作られない
    const phase = tools(root).get("graphhopper_phase");
    await phase!.execute({ phase: "implementing" }, ctx);
    expect(readTodos(root, g.id).items.length).toBe(0);
    await t!.execute({ action: "add", text: "T1（判断1）: 実装する" }, ctx);
    await t!.execute({ action: "add", text: "T2（判断1）: テストを書く" }, ctx);
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
    await tools(root).get("graphhopper_todo")!.execute({ action: "add", text: "T1: 実装する" }, ctx);
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
    await todo!.execute({ action: "add", text: "T1: 実装する" }, ctx);
    await todo!.execute({ action: "add", text: "T2: テストを書く" }, ctx);
    expect(textOf(await todo!.execute({ action: "done", id: "t1" }, ctx))).toContain("t1 -> completed");
    expect(
      textOf(await todo!.execute({ action: "cancel", id: "t2", reason: "不要" }, ctx)),
    ).toContain("t2 -> cancelled");
    const out = textOf(await phase!.execute({ phase: "polish" }, ctx));
    expect(out).toContain("phase -> polish");
  });

  test("非法遷移は拒否（designing→done直指定）", async () => {
    const root = tmpRoot();
    startGoal(root, "illegal", "s1");
    const out = textOf(await tools(root).get("graphhopper_phase")!.execute({ phase: "done" }));
    expect(out).toContain("非法遷移");
    expect(readState(root).phase).toBe("designing");
  });

  test("ストアが空なら、決定記録にチェックボックスがあっても polish へ進める", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s1").goal;
    writeFileSync(planPath(root, g.id), DESIGN_WITH_TASKS, "utf8");
    const phase = tools(root).get("graphhopper_phase");
    const ctx = { sessionID: "s1" };
    await phase!.execute({ phase: "implementing" }, ctx);
    const out = textOf(await phase!.execute({ phase: "polish" }, ctx));
    expect(out).toContain("phase -> polish");
    expect(readTodos(root, g.id).items.length).toBe(0);
  });
});

describe("plugin: invoke / scoreboard", () => {
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
        { agent: "graphhopper-librarian", prompt: "x" },
        {},
      )) as { content: string };
      expect(r.content).toContain("critic says OK");
      expect(r.content).not.toContain("[invoke:");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("invoke は依頼文の先頭に持ち時間を足して起動する", async () => {
    const dir = tmpRoot();
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s' \"$*\"\n", { mode: 0o755 });
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const r = (await opsTools(dir).get("graphhopper_invoke")!.execute(
        { agent: "graphhopper-librarian", prompt: "本文です", timeoutMs: 60_000 },
        {},
      )) as { content: string };
      expect(r.content).toContain("持ち時間: 最大 60 秒");
      expect(r.content).toContain("本文です");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("invoke は active goal があれば履歴に invoke を残す", async () => {
    const dir = tmpRoot();
    startGoal(dir, "t", "s1");
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      await opsTools(dir).get("graphhopper_invoke")!.execute(
        { agent: "graphhopper-advisor", prompt: "x" },
        {},
      );
      const { readHistory } = await import("./state");
      const ev = readHistory(dir).find((h) => (h as { type: string }).type === "invoke") as
        | { agent: string; timed_out: boolean; elapsed_ms?: number }
        | undefined;
      expect(ev?.agent).toBe("graphhopper-advisor");
      expect(ev?.timed_out).toBe(false);
      expect(typeof ev?.elapsed_ms).toBe("number");
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
        { agent: "graphhopper-librarian", prompt: "x" },
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
    expect(
      formatScoreboard({
        models: [],
        goals: [
          { id: "g-1", title: "t", status: "done", rewinds: 1, evalPass: 2, evalFail: 1, score: 7 },
        ],
        hints: [],
      }),
    ).toContain('- g-1 "t" [done] rewinds=1 eval=2/1 score=7');
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

describe("plugin: 構造化 return（design g-mwiocibp 判断1・5）", () => {
  type Out = { output: Record<string, unknown>; content: string };
  const outOf = (r: unknown): Out => r as Out;

  /** git repo を作り、start 後に tracked ファイルを汚す（実効diffを作る） */
  async function gitRootWithDiff(lines: number): Promise<string> {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    writeFileSync(join(root, "a.txt"), "x\n");
    writeFileSync(join(root, ".gitignore"), ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    startGoal(root, "structured", "s1");
    writeFileSync(join(root, "a.txt"), Array(lines).fill("y").join("\n") + "\n");
    return root;
  }

  test("hash は output で sha1 を返し、読めないファイルは throw する", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const m = opsTools(root);
    const r = await m.get("graphhopper_hash")!.execute({ filePath: "a.txt" }, { sessionID: "s1" });
    const o = outOf(r).output as { sha1: string; size: number; path: string; mtime: string };
    expect(o.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(o.path).toBe("a.txt");
    expect(o.size).toBe(6);
    expect(typeof o.mtime).toBe("string");
    await expect(
      m.get("graphhopper_hash")!.execute({ filePath: "nope.txt" }, { sessionID: "s1" }),
    ).rejects.toThrow(/hash取得失敗/);
  });

  test("verifier_set は空 results を throw し、clean は output.level=clean", async () => {
    const root = tmpRoot();
    startGoal(root, "vs", "s1");
    const m = opsTools(root);
    const t = m.get("graphhopper_verifier_set")!;
    await seedPlan(root);
    await expect(t.execute({ results: [], reason: "x" }, { sessionID: "s1" })).rejects.toThrow(
      /results が空です/,
    );
    const r = outOf(
      await t.execute({ results: [{ lens: "agreement", level: "clean" }], reason: "ok" }, { sessionID: "s1" }),
    );
    expect(r.output["level"]).toBe("clean");
    expect(r.output["target"]).toBeUndefined();
    expect(r.output["lens"]).toEqual(["agreement"]);
    expect(r.content).toContain("clean");
  });

  test("router_check は route/angle_slots/simplify を output で返す（polish）", async () => {
    const root = await gitRootWithDiff(450);
    const r = outOf(
      await opsTools(root).get("graphhopper_router_check")!.execute({}, { sessionID: "s1" }),
    );
    expect(r.output["route"]).toBe("polish");
    expect(r.output["angle_slots"]).toBe(4);
    expect(r.output["simplify"]).toBe(true);
    expect(typeof r.output["diff_lines"]).toBe("number");
    expect(r.content).toContain("route: polish");
  });

  test("router_check は small diff で advisor（枠 2）", async () => {
    const root = await gitRootWithDiff(3);
    const r = outOf(
      await opsTools(root).get("graphhopper_router_check")!.execute({}, { sessionID: "s1" }),
    );
    expect(r.output["route"]).toBe("advisor");
    expect(r.output["angle_slots"]).toBe(2);
    expect(r.output["simplify"]).toBe(false);
  });

  test("diff_stash は path/lines/baseline を output で返す", async () => {
    const root = await gitRootWithDiff(5);
    const r = outOf(
      await opsTools(root).get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" }),
    );
    expect(String(r.output["path"])).toContain(".graphhopper/tmp/gh-verify-");
    expect(Number(r.output["lines"])).toBeGreaterThan(0);
    expect(typeof r.output["baseline"]).toBe("string");
    expect(readFileSync(String(r.output["path"]), "utf8")).toContain("+");
  });
});

describe("plugin: graphhopper_diag（design g-mwiocibp 判断2）", () => {
  type Out = { output: Record<string, unknown>; content: string };
  const outOf = (r: unknown): Out => r as Out;

  async function gitRoot(): Promise<string> {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    writeFileSync(join(root, "a.txt"), "x\n");
    writeFileSync(join(root, ".gitignore"), ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    return root;
  }

  test("eval_cmd 未設定なら unset のファイルを作り、eval のカウンタを動かさない", async () => {
    const root = await gitRoot();
    startGoal(root, "diag unset", "s1");
    const before = readState(root);
    const historyLines = () => {
      const p = join(root, ".graphhopper", "history.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
    };
    const h0 = historyLines();
    const r = outOf(await opsTools(root).get("graphhopper_diag")!.execute({}, { sessionID: "s1" }));
    expect(r.output["status"]).toBe("unset");
    const path = String(r.output["path"]);
    expect(path).toContain(".graphhopper/tmp/diag-");
    expect(readFileSync(path, "utf8")).toContain("診断未実行");
    // eval の記録（fail_streak・指紋・eval_run イベント）に触れない
    const after = readState(root);
    expect(after.fail_streak).toBe(before.fail_streak);
    expect(after.last_eval_fingerprint).toBe(before.last_eval_fingerprint);
    expect(historyLines()).toBe(h0);
  });

  test("passed は exit_code=0 と diff_hash を返し、ファイルに出力を残す", async () => {
    const root = await gitRoot();
    startGoal(root, "diag pass", "s1");
    // set_eval は core tool 側にあるため、state を直接使って確実に設定する
    const { setEvalCmd } = await import("./state");
    setEvalCmd(root, "echo diag-ok");
    const r = outOf(await opsTools(root).get("graphhopper_diag")!.execute({}, { sessionID: "s1" }));
    expect(r.output["status"]).toBe("passed");
    expect(r.output["exit_code"]).toBe(0);
    expect(String(r.output["diff_hash"])).toMatch(/^[0-9a-f]{40}$/);
    const body = readFileSync(String(r.output["path"]), "utf8");
    expect(body).toContain("diag-ok");
    expect(body).toContain("command: echo diag-ok");
  });

  test("failed は exit_code を返し、tail に出力が入る", async () => {
    const root = await gitRoot();
    startGoal(root, "diag fail", "s1");
    const { setEvalCmd } = await import("./state");
    setEvalCmd(root, "echo boom >&2; exit 3");
    const r = outOf(await opsTools(root).get("graphhopper_diag")!.execute({}, { sessionID: "s1" }));
    expect(r.output["status"]).toBe("failed");
    expect(r.output["exit_code"]).toBe(3);
    expect(String(r.output["tail"])).toContain("boom");
    expect(r.content).toContain("診断失敗");
  });

  test("timeout は status=timeout で理由を残す", async () => {
    const root = await gitRoot();
    startGoal(root, "diag timeout", "s1");
    const st = await import("./state");
    const run = await st.runDiagCommand(root, "sleep 5", 100);
    expect(run.status).toBe("timeout");
    expect(run.exitCode).toBeNull();
    const w = st.writeDiagFile(root, st.getActive(root)!.goal.id, run, null);
    expect(readFileSync(w.path, "utf8")).toContain("status: timeout");
  });

  test("complete で diag と verify の sidecar が消える", async () => {
    const root = await gitRoot();
    const started = startGoal(root, "diag cleanup", "s1");
    const gid = started.goal.id;
    const st = await import("./state");
    st.writeDiagFile(root, gid, { status: "passed", command: "true", exitCode: 0, output: "" }, null);
    st.writeSavedVerify(root, gid, { diff_hash: "x", results: [] });
    expect(existsSync(st.diagPath(root, gid))).toBe(true);
    expect(existsSync(st.verifyResultsPath(root, gid))).toBe(true);
    st.clearActiveGoal(root);
    expect(existsSync(st.diagPath(root, gid))).toBe(false);
    expect(existsSync(st.verifyResultsPath(root, gid))).toBe(false);
  });
});

describe("plugin: graphhopper_verify（design g-mwiocibp 判断3・4）", () => {
  type Out = { output: Record<string, unknown>; content: string };
  const outOf = (r: unknown): Out => r as Out;

  /** fake verifier バイナリ。lens ごとに stdout を返す（prompt から lens を判別） */
  function fakeVerifier(dir: string, body: string): string {
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  }

  async function readyGoal(cmd = "true"): Promise<{ root: string; gid: string }> {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    writeFileSync(join(root, "a.txt"), "x\n");
    writeFileSync(join(root, ".gitignore"), ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const started = startGoal(root, "verify", "s1");
    const gid = started.goal.id;
    const st = await import("./state");
    writeFileSync(planPath(root, gid), compliantDesignDoc({ title: "verify", tasks: ["- [ ] T1（判断1）: x"] }), "utf8");
    writeFileSync(join(root, "a.txt"), "x\n" + Array(5).fill("y").join("\n") + "\n");
    st.setEvalCmd(root, cmd);
    const m = opsTools(root);
    await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
    await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
    return { root, gid };
  }

  test("clean 判定を読んで results を返し、missing は空", async () => {
    const dir = tmpRoot();
    const bin = fakeVerifier(dir, `echo "findings: []"; echo '\`\`\`json'; echo '{"level":"clean","summary":"driftなし"}'; echo '\`\`\`'`);
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const { root } = await readyGoal();
      const r = outOf(await opsTools(root).get("graphhopper_verify")!.execute({ delayMs: 0 }, { sessionID: "s1" }));
      const results = r.output["results"] as { lens: string; level: string }[];
      /* 選ぶ役は json を返さないので既定の角度（advisor 枠 2）に切り替わる */
      expect(results.map((x) => x.lens)).toEqual(["agreement", "wiring", "test-efficacy"]);
      expect(results[0]).toMatchObject({ lens: "agreement", level: "clean" });
      expect(r.output["missing"]).toEqual([]);
      expect(r.content).toContain("既定の角度");
      expect(String(r.output["diff_hash"])).toMatch(/^[0-9a-f]{40}$/);
      expect(r.content).toContain("agreement=clean");
      // 返した results は verifier_set にそのまま通る
      const vs = outOf(
        await opsTools(root).get("graphhopper_verifier_set")!.execute(
          { results, reason: "driftなし" },
          { sessionID: "s1" },
        ),
      );
      expect(vs.output["level"]).toBe("clean");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("severity が verify の results → verifier_set → history まで届く（g-mwmqmg6b 判断5）", async () => {
    const dir = tmpRoot();
    const bin = fakeVerifier(
      dir,
      `echo '\`\`\`json'; echo '{"level":"clean","summary":"ok","severity":{"must_fix":0,"should_fix":2,"nit":1,"pre_existing":0}}'; echo '\`\`\`'`,
    );
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const { root } = await readyGoal();
      const r = outOf(await opsTools(root).get("graphhopper_verify")!.execute({ delayMs: 0 }, { sessionID: "s1" }));
      const results = r.output["results"] as { severity?: { should_fix: number } }[];
      expect(results[0]?.severity?.should_fix).toBe(2);
      await opsTools(root).get("graphhopper_verifier_set")!.execute(
        { results, reason: "ok" },
        { sessionID: "s1" },
      );
      const st = await import("./state");
      const sev = st.getActive(root)?.state.last_verifier?.severity;
      expect(sev?.[0]?.counts?.should_fix).toBe(2);
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("drift は target を取り、bodies に本文が入る（clean の本文は含めない）", async () => {
    const dir = tmpRoot();
    const bin = fakeVerifier(dir, `echo "finding: a.txt:1 ズレ"; echo '\`\`\`json'; echo '{"level":"drift","target":"implementing","summary":"1件"}'; echo '\`\`\`'`);
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const { root } = await readyGoal();
      const r = outOf(await opsTools(root).get("graphhopper_verify")!.execute({ delayMs: 0 }, { sessionID: "s1" }));
      expect((r.output["results"] as { target?: string }[])[0]?.target).toBe("implementing");
      const bodies = r.output["bodies"] as { lens: string; body: string }[];
      expect(bodies[0]?.lens).toBe("agreement");
      expect(bodies[0]?.body).toContain("ズレ");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  test("フェンス無し・target 無しの drift は missing に入り、記録に進めない", async () => {
    const dir = tmpRoot();
    const bin = fakeVerifier(dir, `echo "drift maybe"`);
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const { root } = await readyGoal();
      const r = outOf(await opsTools(root).get("graphhopper_verify")!.execute({ delayMs: 0 }, { sessionID: "s1" }));
      expect(r.output["results"]).toEqual([]);
      const missing = r.output["missing"] as { lens: string; reason: string }[];
      expect(missing[0]?.lens).toBe("agreement");
      expect(missing[0]?.reason).toContain("json");
      expect(r.content).toContain("判定不能");
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });

  /** 選ぶ役には角度の json、検証役には body の判定を返す偽 verifier。呼ばれた角度を calls に残す */
  function angleBin(dir: string, opts: { pick?: string; drift?: string[]; badPick?: boolean; broken?: string[] }): { bin: string; calls: string } {
    const calls = join(dir, "calls.log");
    const pick = opts.pick ?? "wiring,cleanup";
    const angles = pick.split(",").map((id) => `{"id":"${id}"}`).join(",");
    const drifts = (opts.drift ?? []).map((id) => `*"角度: "*"（${id}）"*`);
    const driftCase = drifts.length
      ? `case "$*" in ${drifts.join("|")}) LEVEL='{"level":"drift","target":"implementing","summary":"指摘"}';; *) LEVEL='{"level":"clean","summary":"ok"}';; esac`
      : `LEVEL='{"level":"clean","summary":"ok"}'`;
    const bin = fakeVerifier(
      dir,
      [
        `ARGS="$*"`,
        `case "$ARGS" in *"角度を選ぶ役"*) echo "SELECT" >> "${calls}"; echo "$ARGS" > "${calls}.select"; ${
          opts.badPick ? `echo "no json"` : `echo '\`\`\`json'; echo '{"angles":[${angles}]}'; echo '\`\`\`'`
        }; exit 0;; esac`,
        `ID=$(echo "$ARGS" | sed -n 's/.*角度: [^（]*（\\([a-z0-9-]*\\)）.*/\\1/p' | head -1)`,
        `echo "$ID" >> "${calls}"`,
        `case "$ARGS" in *"今回の指摘ファイル"*) echo "$ID:findings" >> "${calls}";; esac`,
        ...(opts.broken?.length ? [`case "$ID" in ${opts.broken.join("|")}) echo "壊れた"; exit 0;; esac`] : []),
        `case "$ARGS" in *"指摘ファイル"*) PRIOR=',"prior":{"valid":1,"invalid":0,"unresolved":0}';; *) PRIOR='';; esac`,
        driftCase,
        `echo "本文 $ID"; echo '\`\`\`json'; echo "\${LEVEL%\\}}$PRIOR}"; echo '\`\`\`'`,
      ].join("\n"),
    );
    return { bin, calls };
  }
  const withBin = async (bin: string, f: () => Promise<void>) => {
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      await f();
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  };
  const callsOf = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const verify = async (root: string, args: Record<string, unknown> = {}) =>
    outOf(await opsTools(root).get("graphhopper_verify")!.execute({ delayMs: 0, ...args }, { sessionID: "s1" }));

  test("選ばれた角度で走る（agreement＋選ぶ役の角度）。2 回目は再実行しない", async () => {
    const dir = tmpRoot();
    const { bin, calls } = angleBin(dir, { pick: "wiring,cleanup" });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      expect(r.output["lenses"]).toEqual(["agreement", "wiring", "cleanup"]);
      expect(r.output["missing"]).toEqual([]);
      const first = callsOf(calls);
      expect(first.filter((c) => c === "SELECT")).toHaveLength(1);
      await verify(root);
      expect(callsOf(calls)).toEqual(first);
    });
  });

  test("選ぶ役の失敗で既定の角度に切り替わり、本文に出る", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, { badPick: true });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      expect(r.output["lenses"]).toEqual(["agreement", "wiring", "test-efficacy"]);
      expect(r.content).toContain("既定の角度");
      const h = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8");
      expect(h).toContain("angle_select_failed");
      expect(h).toContain("angles_selected");
    });
  });

  test("add の角度が走り、あとからの add は足した角度だけ走る。3 個目はエラー", async () => {
    const dir = tmpRoot();
    const { bin, calls } = angleBin(dir, { pick: "wiring" });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root, { add: [{ id: "a1", title: "t", doubt: "d" }] });
      expect(r.output["lenses"]).toContain("a1");
      const before = callsOf(calls).length;
      await verify(root, { add: [{ id: "a2", title: "t", doubt: "d" }] });
      expect(callsOf(calls).slice(before)).toEqual(["a2"]);
      await expect(verify(root, { add: [{ id: "a3", title: "t", doubt: "d" }] })).rejects.toThrow(/2 個まで/);
    });
  });

  test("lens に計画に無い id はエラー", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, {});
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      await verify(root);
      await expect(verify(root, { lens: ["nope"] })).rejects.toThrow(/計画に無い/);
    });
  });

  test("drift があれば siblings が 1 回だけ走り、clean なら走らない", async () => {
    const dir = tmpRoot();
    const { bin, calls } = angleBin(dir, { pick: "wiring", drift: ["wiring"] });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      expect(callsOf(calls).filter((c) => c === "siblings")).toHaveLength(1);
      expect((r.output["results"] as { lens: string }[]).map((x) => x.lens)).toContain("siblings");
      await verify(root);
      expect(callsOf(calls).filter((c) => c === "siblings")).toHaveLength(1);
      expect(existsSync(join(root, ".graphhopper", "tmp", `verify-${(await import("./state")).getActive(root)!.goal.id}-findings.md`))).toBe(true);
    });
    const dir2 = tmpRoot();
    const clean = angleBin(dir2, { pick: "wiring" });
    await withBin(clean.bin, async () => {
      const { root } = await readyGoal();
      await verify(root);
      expect(callsOf(clean.calls)).not.toContain("siblings");
    });
  });

  test("計画した角度が判定不能なら止まり、呼び直すとその角度だけ走る", async () => {
    const dir = tmpRoot();
    const calls = join(dir, "calls.log");
    const flag = join(dir, "flag");
    const bin = fakeVerifier(
      dir,
      [
        `ARGS="$*"`,
        `case "$ARGS" in *"角度を選ぶ役"*) echo '\`\`\`json'; echo '{"angles":[{"id":"wiring"}]}'; echo '\`\`\`'; exit 0;; esac`,
        `ID=$(echo "$ARGS" | sed -n 's/.*角度: [^（]*（\\([a-z0-9-]*\\)）.*/\\1/p' | head -1)`,
        `echo "$ID" >> "${calls}"`,
        `if [ "$ID" = "wiring" ] && [ ! -f "${flag}" ]; then touch "${flag}"; echo "壊れた"; exit 0; fi`,
        `echo '\`\`\`json'; echo '{"level":"clean","summary":"ok"}'; echo '\`\`\`'`,
      ].join("\n"),
    );
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      expect((r.output["missing"] as { lens: string }[]).map((m) => m.lens)).toEqual(["wiring"]);
      const before = callsOf(calls).length;
      const r2 = await verify(root);
      expect(r2.output["missing"]).toEqual([]);
      expect(callsOf(calls).slice(before)).toEqual(["wiring"]);
    });
  });

  test("diff が変わると drift の角度が持ち越され、prior が記録される。持ち越した siblings は 1 巡目が clean でも走る", async () => {
    const dir = tmpRoot();
    const { bin, calls } = angleBin(dir, { pick: "wiring", drift: ["wiring", "siblings"] });
    await withBin(bin, async () => {
      const { root, gid } = await readyGoal();
      await verify(root);
      expect(callsOf(calls)).toContain("siblings");
      // 直した（diff が変わる）。今度は drift しない偽 verifier に切り替える
      const clean = angleBin(tmpRoot(), { pick: "cleanup" });
      await withBin(clean.bin, async () => {
        writeFileSync(join(root, "a.txt"), "x\nchanged\n");
        const m = opsTools(root);
        await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
        await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
        const r = await verify(root);
        const ids = r.output["lenses"] as string[];
        expect(ids).toContain("wiring");
        expect(ids).toContain("siblings");
        expect(r.output["missing"]).toEqual([]);
        const results = r.output["results"] as { lens: string; prior?: { valid: number } }[];
        expect(results.find((x) => x.lens === "wiring")?.prior?.valid).toBe(1);
        // 返す results のキーは output スキーマが宣言している（additionalProperties:false で落とされない）
        const tool = opsTools(root).get("graphhopper_verify") as unknown as {
          output: { properties: { results: { items: { properties: Record<string, unknown> } } } };
        };
        const declared = Object.keys(tool.output.properties.results.items.properties);
        for (const x of results) for (const k of Object.keys(x)) expect(declared).toContain(k);
        expect(callsOf(clean.calls).filter((c) => c === "siblings")).toHaveLength(1);
        // lens に持ち越した siblings を指定すると、その角度だけ走らせ直す
        await verify(root, { lens: ["siblings"] });
        expect(callsOf(clean.calls).filter((c) => c === "siblings")).toHaveLength(2);
        expect(callsOf(clean.calls).filter((c) => c === "wiring")).toHaveLength(1);
        const st = await import("./state");
        const prior = readFileSync(st.priorFindingsPath(root, gid), "utf8");
        expect(prior).toContain("## wiring");
        expect(prior).toContain("本文 wiring");
        expect(prior).toContain("## siblings");
        await m.get("graphhopper_verifier_set")!.execute({ results, reason: "ok" }, { sessionID: "s1" });
      });
    });
  });

  test("選ぶ役には残りの枠（remainingSlots）と取られた id（taken）が渡る。判定不能のまま diff が変わっても前回の指摘（kept）を prior.md に残す", async () => {
    const first = angleBin(tmpRoot(), { pick: "wiring", drift: ["wiring"] });
    await withBin(first.bin, async () => {
      const { root, gid } = await readyGoal();
      const st = await import("./state");
      const rediff = async (text: string) => {
        writeFileSync(join(root, "a.txt"), text);
        const m = opsTools(root);
        await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
        await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
      };
      await verify(root);
      const second = angleBin(tmpRoot(), { pick: "cleanup,behavior", broken: ["wiring"] });
      await withBin(second.bin, async () => {
        await rediff("x\nchanged\n");
        const r = await verify(root);
        // advisor の枠 2 のうち 1 つは持ち越した wiring が使う。選ぶ役には残り 1 と、取られた id が渡る
        expect(r.output["lenses"]).toEqual(["agreement", "wiring", "cleanup"]);
        const sel = readFileSync(`${second.calls}.select`, "utf8");
        expect(sel).toContain("1 個まで選ぶ");
        expect(sel).toMatch(/次の id は選ばない[^\n]*wiring/);
        expect((r.output["missing"] as { lens: string }[]).map((x) => x.lens)).toEqual(["wiring"]);
      });
      const third = angleBin(tmpRoot(), { pick: "cleanup" });
      await withBin(third.bin, async () => {
        await rediff("x\nchanged again\n");
        const r = await verify(root);
        expect(r.output["lenses"]).toContain("wiring");
        expect(readFileSync(st.priorFindingsPath(root, gid), "utf8")).toContain("本文 wiring");
      });
    });
  });

  test("add した角度を lens で外すと、verifier_set は計画の未充足として拒否する", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, { pick: "wiring" });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      const results = (r.output["results"] as { lens: string }[]).filter((x) => x.lens !== "wiring");
      await expect(
        opsTools(root).get("graphhopper_verifier_set")!.execute({ results, reason: "x" }, { sessionID: "s1" }),
      ).rejects.toThrow(/計画した角度の結果がありません/);
    });
  });

  test("旧形式（計画なし）の sidecar は捨てて計画し直す", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, { pick: "wiring" });
    await withBin(bin, async () => {
      const { root, gid } = await readyGoal();
      const st = await import("./state");
      writeFileSync(st.verifyResultsPath(root, gid), JSON.stringify({ diff_hash: "old", results: [{ lens: "general", level: "clean", summary: "s" }] }));
      const r = await verify(root);
      expect(r.output["lenses"]).toEqual(["agreement", "wiring"]);
      expect((r.output["results"] as { lens: string }[]).map((x) => x.lens)).not.toContain("general");
    });
  });

  test("2 巡目の siblings が判定不能でも止まらず、呼び直すと再実行する", async () => {
    const dir = tmpRoot();
    const { bin, calls } = angleBin(dir, { pick: "wiring", drift: ["wiring"], broken: ["siblings"] });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root);
      expect(r.output["missing"]).toEqual([]);
      expect((r.output["results"] as { lens: string }[]).map((x) => x.lens)).not.toContain("siblings");
      await verify(root);
      expect(callsOf(calls).filter((c) => c === "siblings")).toHaveLength(2);
    });
  });

  test("持ち越した siblings が判定不能なら missing に残る。今回の drift の指摘ファイルも受け取る", async () => {
    const dir = tmpRoot();
    const first = angleBin(dir, { pick: "wiring", drift: ["wiring", "siblings"] });
    await withBin(first.bin, async () => {
      const { root } = await readyGoal();
      await verify(root);
      // 持ち越した wiring がまた drift する → 持ち越した siblings にも今回の指摘ファイルが渡る
      const next = angleBin(tmpRoot(), { drift: ["wiring"], broken: ["siblings"] });
      await withBin(next.bin, async () => {
        writeFileSync(join(root, "a.txt"), "x\nchanged\n");
        const m = opsTools(root);
        await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
        await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
        const r = await verify(root);
        expect((r.output["missing"] as { lens: string }[]).map((x) => x.lens)).toEqual(["siblings"]);
        expect(callsOf(next.calls)).toContain("siblings:findings");
      });
    });
  });

  test("add を 2 個同時に渡しても、選ぶ役の枠（advisor は 2）は減らない", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, { pick: "wiring,cleanup" });
    await withBin(bin, async () => {
      const { root } = await readyGoal();
      const r = await verify(root, {
        add: [
          { id: "a1", title: "t", doubt: "d" },
          { id: "a2", title: "t", doubt: "d" },
        ],
      });
      expect(r.output["lenses"]).toEqual(["agreement", "wiring", "cleanup", "a1", "a2"]);
    });
  });

  test("goal の終了で sidecar と指摘ファイルが消える", async () => {
    const dir = tmpRoot();
    const { bin } = angleBin(dir, { pick: "wiring", drift: ["wiring"] });
    await withBin(bin, async () => {
      const { root, gid } = await readyGoal();
      await verify(root);
      const st = await import("./state");
      expect(existsSync(st.verifyResultsPath(root, gid))).toBe(true);
      st.removeVerifyResults(root, gid);
      expect(existsSync(st.verifyResultsPath(root, gid))).toBe(false);
      expect(existsSync(st.findingsPath(root, gid))).toBe(false);
      st.writePriorFindings(root, gid, "x");
      expect(existsSync(st.priorFindingsPath(root, gid))).toBe(true);
      st.removeVerifyResults(root, gid);
      expect(existsSync(st.priorFindingsPath(root, gid))).toBe(false);
    });
  });

  test("前提: diag か diff_stash が無ければ throw、退避後に編集しても throw", async () => {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    writeFileSync(join(root, "a.txt"), "x\n");
    writeFileSync(join(root, ".gitignore"), ".graphhopper/\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const gid = startGoal(root, "verify pre", "s1").goal.id;
    writeFileSync(planPath(root, gid), compliantDesignDoc({ title: "v", tasks: ["- [ ] T1（判断1）: x"] }), "utf8");
    writeFileSync(join(root, "a.txt"), "x\ny\n");
    const m = opsTools(root);
    await expect(m.get("graphhopper_verify")!.execute({}, { sessionID: "s1" })).rejects.toThrow(
      /diff_stash/,
    );
    await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
    await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
    // 退避後に編集したら止まる（古い diff を検証しない）
    writeFileSync(join(root, "a.txt"), "x\ny\nz\n");
    await expect(m.get("graphhopper_verify")!.execute({}, { sessionID: "s1" })).rejects.toThrow(
      /編集された/,
    );
    // diag → diff_stash をやり直せば通る（前提の順序が固定されている）
    await m.get("graphhopper_diag")!.execute({}, { sessionID: "s1" });
    await m.get("graphhopper_diff_stash")!.execute({}, { sessionID: "s1" });
    const dir = tmpRoot();
    const bin = fakeVerifier(dir, `echo '\`\`\`json'; echo '{"level":"clean","summary":"ok"}'; echo '\`\`\`'`);
    const prev = process.env["GH_OPENCODE_BIN"];
    process.env["GH_OPENCODE_BIN"] = bin;
    try {
      const r = outOf(await m.get("graphhopper_verify")!.execute({ delayMs: 0 }, { sessionID: "s1" }));
      expect(r.output["missing"]).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env["GH_OPENCODE_BIN"];
      else process.env["GH_OPENCODE_BIN"] = prev;
    }
  });
});

describe("verify: prompt 組み立てと判定の読み取り（純粋層）", () => {
  test("角度の prompt に path・出力契約・共通ルールが入り、fan-out を指示しない", async () => {
    const v = await import("./verify");
    const p = await import("./prompts");
    const root = tmpRoot();
    const paths = { designPath: "/r/design.md", diffPath: "/r/diff.txt", diagPath: "/r/diag.txt", intentPath: null };
    const e = { id: "wiring", title: "t", doubt: "d", scope: "s", source: "list" as const, carried: false };
    const text = v.buildAnglePrompt(root, "g-1", e, paths);
    for (const x of ["/r/design.md", "/r/diff.txt", "/r/diag.txt", "出力形式（必須）", p.VERIFIER_EFFICIENCY_RULE, p.VERIFIER_EVIDENCE_RULE, p.PARALLEL_NOTE]) {
      expect(text).toContain(x);
    }
    expect(text).not.toContain("投げてよい");
    expect(text).not.toContain("intent（意図ログ）");
  });

  test("parseLensVerdict: clean/drift/不正を切り分ける", async () => {
    const v = await import("./verify");
    expect(v.parseLensVerdict('foo\n```json\n{"level":"clean","summary":"ok"}\n```')).toEqual({
      ok: true,
      verdict: { level: "clean", summary: "ok" },
    });
    expect(
      v.parseLensVerdict('```json\n{"level":"drift","target":"design","summary":"s"}\n```'),
    ).toEqual({ ok: true, verdict: { level: "drift", target: "design", summary: "s" } });
    expect(v.parseLensVerdict("no fence")).toMatchObject({ ok: false });
    expect(v.parseLensVerdict('```json\n{"level":"drift","summary":"s"}\n```')).toMatchObject({
      ok: false,
    });
    expect(v.parseLensVerdict('```json\n{"level":"clean"}\n```')).toMatchObject({ ok: false });
    expect(v.parseLensVerdict('```json\n{"level":"maybe","summary":"s"}\n```')).toMatchObject({
      ok: false,
    });
  });

  test("invokeFailure: invoke 自身の失敗印だけを拾う（本文の error: 行は無視）", async () => {
    const v = await import("./verify");
    expect(v.invokeFailure("error: prompt too long (13000 > 12000)")).toBeTruthy();
    expect(v.invokeFailure("本文\nerror: opencode run exited with code 143\nstderr")).toBeTruthy();
    // verifier が findings の中で "error:" 行を引用しても判定不能にしない
    expect(v.invokeFailure("finding: src/a.ts:1 で error: を握り潰す\n```json\n{}")).toBeNull();
  });

  test("extractJsonBlock: 最後のフェンスを採る・フェンス無しと壊れた JSON は null", async () => {
    const v = await import("./verify");
    const t = '```json\n{"a":1}\n```\n本文\n```json\n{"a":2}\n```';
    expect(v.extractJsonBlock(t)).toEqual({ a: 2 });
    expect(v.extractJsonBlock("なし")).toBeNull();
    expect(v.extractJsonBlock("```json\n{bad\n```")).toBeNull();
  });
});

describe("plugin: 廃止した経路の残骸が無い", () => {
  test("oracle 相談は invoke 表記・workflow runner の参照も残らない", () => {
    const dir = join(import.meta.dir, "..", ".opencode", "plugins", "graphhopper");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const hits = files.filter((f) => {
      const raw = readFileSync(join(dir, f), "utf8");
      return (
        raw.includes("task(subagent_type: 'graphhopper-oracle") ||
        raw.includes("graphhopper_workflow") ||
        raw.includes("src/workflow")
      );
    });
    expect(hits).toEqual([]);
  });
});

describe("lineage: history から goal の系譜を復元する", () => {
  test("eval / gate block / 編集が載る", () => {
    const root = tmpRoot();
    const { goal } = startGoal(root, "lineage", "");
    recordEvent(root, { type: "design_gate_block", goal: goal.id, tool: "edit", path: "a.ts" });
    recordEvent(root, { type: "hash_edit_applied", goal: goal.id, path: "src/a.ts" });
    recordEvent(root, { type: "eval_run", goal: goal.id, ok: true, fail_streak: 0 });
    recordEvent(root, { type: "eval_run", goal: goal.id, ok: false, fail_streak: 1 });
    const lin = buildLineage(root);
    const l = lin.goals.find((x) => x.id === goal.id);
    expect(l).toBeDefined();
    expect(l!.gateBlocks).toBe(1);
    expect(l!.editedFiles).toEqual(["src/a.ts"]);
    expect(l!.evalRuns).toEqual({ pass: 1, fail: 1 });
  });
});

describe("plugin: graphhopper_discover_tick（loop-until-dry）", () => {
  test("2 ラウンド連続で新規 0 なら dry で止まる", async () => {
    const root = tmpRoot();
    const ops = opsTools(root);
    await ops.get("graphhopper_discover_start")!.execute({ target: "バグ", scope: "src" });
    const tick = ops.get("graphhopper_discover_tick")!;
    const findings = [
      { title: "f1", severity: "high", confidence: 90, quote: "q" },
    ];
    const first = textOf(await tick.execute({ findings }));
    expect(first).not.toContain("stopped:");
    // 新規 0 が 2 連続になるまで回す（既見は新規扱いしない）
    expect(textOf(await tick.execute({ findings }))).not.toContain("stopped:");
    const third = textOf(await tick.execute({ findings }));
    expect(third).toContain("stopped: dry");
    expect(third).toContain("confirmed: 1件");
  });
});

describe("plugin tool: 難易度の判定（design g-mwjsd3om 判断4・6）", () => {
  const d1Fetch = (choice: string, confidence: number) =>
    (async () => ({
      ok: true,
      json: async () => ({ answers: { difficulty: { choice, confidence } } }),
    })) as unknown as typeof fetch;

  const withD1 = async <T>(impl: typeof fetch | null, fn: () => Promise<T>): Promise<T> => {
    const savedKey = process.env.LIQUID_API_KEY;
    const savedFetch = globalThis.fetch;
    if (impl) {
      process.env.LIQUID_API_KEY = "liquid_test";
      globalThis.fetch = impl;
    } else {
      delete process.env.LIQUID_API_KEY;
    }
    try {
      return await fn();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = savedKey;
    }
  };

  test("start は題から難易度を判定して state に入れる", async () => {
    const root = tmpRoot();
    await withD1(d1Fetch("normal", 0.7), async () => {
      const out = await tools(root)
        .get("graphhopper_goal")!
        .execute({ action: "start", title: "普通の機能追加" }, { sessionID: "s1" });
      expect(textOf(out)).toContain("difficulty=normal");
      expect(readState(root).difficulty).toBe("normal");
    });
  });

  test("d1 が使えないときは呼ばずに difficulty: null で始める", async () => {
    const root = tmpRoot();
    let calls = 0;
    await withD1(null, async () => {
      /* 仕様は「d1 が使えないときは API を呼ばない」。時間ではなく回数で確かめる */
      globalThis.fetch = (async () => {
        calls += 1;
        return { ok: true, json: async () => ({ answers: {} }) } as unknown as Response;
      }) as unknown as typeof fetch;
      const out = await tools(root)
        .get("graphhopper_goal")!
        .execute({ action: "start", title: "題" }, { sessionID: "s1" });
      expect(textOf(out)).not.toContain("difficulty=");
      expect(readState(root).difficulty).toBeNull();
    });
    expect(calls).toBe(0);
  });

  test("implementing 遷移で決めたことから hard に上げる", async () => {
    const root = tmpRoot();
    await withD1(null, async () => {
      startGoal(root, "題", "s1");
      writeFileSync(
        planPath(root, getActive(root)!.goal.id),
        compliantDesignDoc({
          title: "題",
          tasks: [
            "- [ ] T1（判断1）: `src/a.ts` の hook を新しい仕組みに置き換える",
            "- [ ] T2（判断1）: 移行とテスト",
          ],
        }),
        "utf8",
      );
    });
    await withD1(d1Fetch("hard", 0.8), async () => {
      const out = await tools(root)
        .get("graphhopper_phase")!
        .execute({ phase: "implementing" }, { sessionID: "s1" });
      const body = textOf(out);
      expect(body).toContain("→ hard");
      expect(readState(root).difficulty).toBe("hard");
      const rows = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.some((r) => r.type === "difficulty_upgraded")).toBe(true);
    });
  });

  /** 題の判定を from にして goal を始め、決定記録を書く */
  const startWith = async (root: string, from: "easy" | "normal" | null, decided: string) => {
    await withD1(from ? d1Fetch(from, 0.95) : null, async () => {
      await tools(root)
        .get("graphhopper_goal")!
        .execute({ action: "start", title: "題" }, { sessionID: "s1" });
    });
    expect(readState(root).difficulty).toBe(from);
    writeFileSync(
      planPath(root, getActive(root)!.goal.id),
      [
        "# 決定記録",
        "",
        "## 決めたこと",
        "",
        `- ${decided}`,
        "",
        "## やらないこと",
        "",
        "- 本番の変更はしない",
        "",
        "## 完了の確かめ方",
        "",
        "- テストが通ること",
        "",
        "## 実装タスク列",
        "",
        "- [ ] タスク列にだけ書いた文言",
        "",
      ].join("\n"),
      "utf8",
    );
  };
  const moveWith = async (root: string, choice: string, confidence: number, bodies?: string[]) => {
    const impl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies?.push(String(init?.body ?? ""));
      return { ok: true, json: async () => ({ answers: { difficulty: { choice, confidence } } }) };
    }) as unknown as typeof fetch;
    return withD1(impl, async () =>
      textOf(
        await tools(root)
          .get("graphhopper_phase")!
          .execute({ phase: "implementing" }, { sessionID: "s1" }),
      ),
    );
  };

  test("判定し直しの入力は題と「決めたこと」の本文（タスク列は渡さない）", async () => {
    const root = tmpRoot();
    await startWith(root, null, "hook を新しい仕組みに置き換える合意");
    const bodies: string[] = [];
    await moveWith(root, "hard", 0.8, bodies);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("題");
    expect(bodies[0]).toContain("hook を新しい仕組みに置き換える合意");
    expect(bodies[0]).not.toContain("タスク列にだけ書いた文言");
    expect(bodies[0]).not.toContain("本番の変更はしない");
  });

  test("easy は normal の判定で normal に上がる（履歴に from/to が残る）", async () => {
    const root = tmpRoot();
    await startWith(root, "easy", "複数ファイルにまたがる変更にする");
    const body = await moveWith(root, "normal", 0.7);
    expect(body).toContain("easy → normal");
    expect(readState(root).difficulty).toBe("normal");
    const rows = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const up = rows.find((r) => r.type === "difficulty_upgraded");
    expect(up?.from).toBe("easy");
    expect(up?.to).toBe("normal");
  });

  test("下がる方向・同じ難易度・判定なしからの normal は反映しない", async () => {
    const down = tmpRoot();
    await startWith(down, "normal", "小さな修正");
    expect(await moveWith(down, "easy", 0.95)).not.toContain("difficulty:");
    expect(readState(down).difficulty).toBe("normal");

    const same = tmpRoot();
    await startWith(same, "easy", "小さな修正");
    expect(await moveWith(same, "easy", 0.95)).not.toContain("difficulty:");
    expect(readState(same).difficulty).toBe("easy");

    const none = tmpRoot();
    await startWith(none, null, "普通の変更");
    expect(await moveWith(none, "normal", 0.7)).not.toContain("difficulty:");
    expect(readState(none).difficulty).toBeNull();
  });

  test("confidence 0.7 未満の hard は昇格しない（降格もしない）", async () => {
    const root = tmpRoot();
    await withD1(null, async () => {
      startGoal(root, "題", "s1");
      writeFileSync(
        planPath(root, getActive(root)!.goal.id),
        compliantDesignDoc({ title: "題", tasks: ["- [ ] T1（判断1）: 直す"] }),
        "utf8",
      );
    });
    await withD1(d1Fetch("hard", 0.65), async () => {
      const out = await tools(root)
        .get("graphhopper_phase")!
        .execute({ phase: "implementing" }, { sessionID: "s1" });
      expect(textOf(out)).not.toContain("→ hard");
      expect(readState(root).difficulty).toBeNull();
    });
  });
});

describe("plugin tool: complete ゲートの observe（design g-mwmnvx3x 判断3）", () => {
  const writeGates = (root: string, gates: Record<string, string>) => {
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ gates }, null, 2),
      "utf8",
    );
  };
  const historyTypes = (root: string): Record<string, unknown>[] => {
    try {
      return readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };

  test("observe なら拒否理由を記録して complete が通る", async () => {
    const root = tmpRoot();
    writeGates(root, { verifier: "observe", usability: "enforce", diff_hash: "enforce" });
    startGoal(root, "observe test", "s1");
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("completed");
    expect(textOf(out)).toContain("observe で通したゲート: verifier");
    const rows = historyTypes(root);
    const observed = rows.find((r) => r["type"] === "complete_gate_observe");
    expect(observed).toMatchObject({ gate: "verifier" });
    expect(String(observed?.["reason"])).toContain("verifier");
  });

  test("enforce なら従来どおり拒否する", async () => {
    const root = tmpRoot();
    startGoal(root, "enforce test", "s1");
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("error:");
    expect(textOf(out)).toContain("graphhopper_verifier_set");
  });

  test("goal 開始時に凍結したモードは、goal 中の config 変更で変わらない", async () => {
    const root = tmpRoot();
    startGoal(root, "frozen test", "s1");
    const state = await import("./state");
    state.freezeGoalGates(root, state.DEFAULT_GATES, null);
    /* goal の途中で config を緩める */
    writeGates(root, { verifier: "observe", usability: "observe", diff_hash: "observe" });
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("error:");
  });

  test("rubric の凍結ファイルが消えたら verifier_self_modified ゲート（既定 observe）で記録して通す", async () => {
    const root = tmpRoot();
    startGoal(root, "tamper test", "s1");
    const state = await import("./state");
    const verify = await import("./verify");
    state.freezeGoalGates(
      root,
      {
        usability: "observe",
        verifier: "observe",
        diff_hash: "observe",
        verifier_self_modified: "observe",
      },
      "deadbeef",
    );
    expect(verify.loadRubric(root, state.getActive(root)!.goal.id)).toBeNull();
    const out = await tools(root)
      .get("graphhopper_goal")!
      .execute({ action: "complete" }, { sessionID: "s1" });
    expect(textOf(out)).toContain("completed");
    expect(textOf(out)).toContain("verifier_self_modified");
    const rows = historyTypes(root);
    expect(rows.some((r) => r["type"] === "complete_gate_observe" && r["gate"] === "verifier_self_modified")).toBe(true);
  });

  test("status にゲートの実効モードと rubric の状態が出る", async () => {
    const root = tmpRoot();
    startGoal(root, "status test", "s1");
    const state = await import("./state");
    state.freezeGoalGates(root, state.DEFAULT_GATES, null);
    const out = await tools(root).get("graphhopper_status")!.execute({}, { sessionID: "s1" });
    const body = textOf(out);
    expect(body).toContain("gates:");
    expect(body).toContain("verifier_self_modified=observe");
    expect(body).toContain("（開始時に凍結）");
    expect(body).toContain("rubric: 未凍結（legacy goal）");
  });
});
