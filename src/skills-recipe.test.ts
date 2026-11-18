/**
 * skills/graphhopper/refs/verifier.md の Code Mode レシピ（js コードブロック）を
 * 取り出して実行するテスト（design g-mwiocibp 判断6・T7）。
 *
 * なぜ必要か: 文書に貼ったコードは誰も実行しないので腐る。fake の tools で
 * 「advisor は1バッチで完了まで」「drift・判定不能・診断失敗・昇格では止まる」
 * 「polish は start で simplify 提案、tail で完了」を機械的に固定する。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MD_PATH = join(import.meta.dir, "..", "skills", "graphhopper", "refs", "verifier.md");
const md = readFileSync(MD_PATH, "utf8");

function recipe(name: "start" | "tail"): string {
  const re = new RegExp("```js\\n// recipe: " + name + "\\n([\\s\\S]*?)```");
  const m = re.exec(md);
  if (!m) throw new Error(`レシピが無い: ${name}`);
  return m[1]!;
}

/** レシピを execute の本体と同形で実行する（戻り値は execute の return） */
async function runRecipe(
  source: string,
  tools: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<unknown> {
  const fn = new Function("tools", `return (async () => {\n${source}\n})();`) as (
    t: typeof tools,
  ) => Promise<unknown>;
  return await fn(tools);
}

type Call = { name: string; args: Record<string, unknown>; order: number };

function recorder(impl: Record<string, (args: Record<string, unknown>) => unknown>): {
  tools: Record<string, (args: Record<string, unknown>) => unknown>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    tools[name] = (args: Record<string, unknown>) => {
      calls.push({ name, args, order: calls.length });
      return fn(args);
    };
  }
  return { tools, calls };
}

const CLEAN_VERIFY = {
  results: [{ lens: "general", level: "clean", model: "p/m" }],
  summaries: [{ lens: "general", summary: "driftなし" }],
  bodies: [],
  missing: [],
  lenses: ["general"],
  diff_hash: "h1",
};

function baseImpl(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  return {
    graphhopper_router_check: () => ({ escalated: false, simplify: false, route: "advisor", lenses: ["general"] }),
    graphhopper_diag: () => ({ status: "passed", path: "diag.txt", tail: "" }),
    graphhopper_diff_stash: () => ({ path: "diff.txt", lines: 10, baseline: "rev" }),
    graphhopper_verify: () => CLEAN_VERIFY,
    graphhopper_verifier_set: () => ({ level: "clean", lens: ["general"], next: "done へ" }),
    graphhopper_phase: () => ({ content: "phase -> done" }),
    graphhopper_goal: () => ({ content: "completed" }),
    graphhopper_invoke: () => "proposal: 3 findings",
    ...overrides,
  };
}

describe("refs/verifier.md のレシピ（Code Mode）", () => {
  test("レシピの呼び出し順が固定されている（文書の腐り検知）", () => {
    const start = recipe("start");
    expect(start).toContain("tools.graphhopper_router_check");
    expect(start).toContain("tools.graphhopper_diff_stash");
    expect(start).toContain("tools.graphhopper_invoke");
    const tail = recipe("tail");
    for (const t of [
      "graphhopper_phase",
      "graphhopper_diag",
      "graphhopper_diff_stash",
      "graphhopper_verify",
      "graphhopper_verifier_set",
      "graphhopper_phase",
      "graphhopper_goal",
    ]) {
      expect(tail).toContain(`tools.${t}`);
    }
    // task() 前提の手順が polish 経路に残っていない
    expect(start + tail).not.toContain("task(");
    expect(start + tail).not.toContain("subagent_type");
  });

  test("advisor clean: 1バッチで記録→complete まで進む", async () => {
    const { tools, calls } = recorder(baseImpl());
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as {
      stop: string;
      summaries: unknown[];
    };
    expect(out.stop).toBe("clean");
    expect(calls.map((c) => c.name)).toEqual([
      "graphhopper_router_check",
      "graphhopper_phase",
      "graphhopper_diag",
      "graphhopper_diff_stash",
      "graphhopper_verify",
      "graphhopper_verifier_set",
      "graphhopper_goal",
    ]);
    // verify の results をそのまま渡し、要約から reason を組み立てる
    const setArgs = calls.find((c) => c.name === "graphhopper_verifier_set")!.args;
    expect(setArgs["results"]).toEqual(CLEAN_VERIFY.results);
    expect(String(setArgs["reason"])).toContain("general: driftなし");
    expect(
      calls.filter((c) => c.name === "graphhopper_phase").map((c) => c.args["phase"]),
    ).toEqual(["polish"]);
    expect(calls.find((c) => c.name === "graphhopper_goal")!.args).toEqual({ action: "complete" });
  });

  test("complete の拒否（error 文字列）は stop: complete で返し、phase を done にしない", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_goal: () =>
          "error: 検証後に差分が変わっています（verifier clean の時点と不一致）。graphhopper_verifier_set で再検証してから complete してください。",
      }),
    );
    const out = (await runRecipe(recipe("tail"), tools)) as { stop: string; reason: string };
    expect(out.stop).toBe("complete");
    expect(out.reason).toContain("検証後に差分が変わっています");
    // done への遷移は completeGoal の仕事。自分で phase(done) を呼ぶと拒否時に戻れなくなる
    expect(
      calls.filter((c) => c.name === "graphhopper_phase").map((c) => c.args["phase"]),
    ).toEqual(["polish"]);
  });

  test("drift: 記録して止まる（phase/goal を呼ばない）", async () => {
    const driftVerify = {
      ...CLEAN_VERIFY,
      results: [{ lens: "general", level: "drift", target: "implementing", model: "p/m" }],
      summaries: [{ lens: "general", summary: "1件" }],
      bodies: [{ lens: "general", body: "finding: a.txt:1" }],
    };
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_verify: () => driftVerify,
        graphhopper_verifier_set: () => ({ level: "drift", target: "implementing", lens: ["general"], next: "implementing へ" }),
      }),
    );
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as {
      stop: string;
      target: string;
      bodies: unknown[];
    };
    expect(out.stop).toBe("drift");
    expect(out.target).toBe("implementing");
    expect(out.bodies).toHaveLength(1);
    // phase は tail 冒頭の polish だけ（done へは進まない）
    expect(
      calls.filter((c) => c.name === "graphhopper_phase").map((c) => c.args["phase"]),
    ).toEqual(["polish"]);
    expect(calls.some((c) => c.name === "graphhopper_goal")).toBe(false);
  });

  test("判定不能: verifier_set を呼ばずに止まる", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_verify: () => ({
          ...CLEAN_VERIFY,
          results: [],
          summaries: [],
          missing: [{ lens: "general", reason: "末尾に json フェンスが無い" }],
        }),
      }),
    );
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as {
      stop: string;
      missing: { lens: string; reason: string }[];
    };
    expect(out.stop).toBe("verify");
    expect(out.missing[0]?.lens).toBe("general");
    expect(calls.some((c) => c.name === "graphhopper_verifier_set")).toBe(false);
  });

  test("診断失敗: verify を呼ばずに止まる", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_diag: () => ({ status: "failed", path: "diag.txt", tail: "tsc error", exit_code: 2 }),
      }),
    );
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as string;
    expect(String(out)).toContain("診断で止まった");
    expect(calls.some((c) => c.name === "graphhopper_verify")).toBe(false);
  });

  test("診断 unset（eval_cmd 未設定）: verifier は走り、clean で完了する", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_diag: () => ({ status: "unset", path: "diag.txt", tail: "eval_cmd 未設定" }),
      }),
    );
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as {
      stop: string;
    };
    expect(out.stop).toBe("clean");
    expect(calls.some((c) => c.name === "graphhopper_verify")).toBe(true);
    expect(calls.find((c) => c.name === "graphhopper_goal")!.args).toEqual({ action: "complete" });
  });

  test("昇格: レシピは打ち切られ、diag も呼ばない", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_router_check: () => ({
          escalated: true,
          simplify: true,
          route: "polish",
          lenses: ["requirement", "behavior", "progress"],
          next: "design.md を肉付け",
        }),
      }),
    );
    const out = (await runRecipe(recipe("start") + "\n" + recipe("tail"), tools)) as string;
    expect(String(out)).toContain("昇格して designing に戻った");
    expect(calls.map((c) => c.name)).toEqual(["graphhopper_router_check"]);
  });

  test("polish 1バッチ目: simplify の提案を返して止まる", async () => {
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_router_check: () => ({
          escalated: false,
          simplify: true,
          route: "polish",
          lenses: ["requirement", "behavior", "progress"],
          next: "polish レシピ",
        }),
      }),
    );
    const out = (await runRecipe(recipe("start"), tools)) as {
      stop: string;
      diff: string;
      proposal: string;
    };
    expect(out.stop).toBe("simplify");
    expect(out.diff).toBe("diff.txt");
    expect(out.proposal).toContain("proposal");
    expect(calls.map((c) => c.name)).toEqual([
      "graphhopper_router_check",
      "graphhopper_diff_stash",
      "graphhopper_invoke",
    ]);
    // simplify へ渡す prompt は diff の path を使う（inline 展開しない）
    expect(String(calls[2]!.args["prompt"])).toContain("diff.txt");
    expect(calls.some((c) => c.name === "graphhopper_phase")).toBe(false);
  });

  test("polish 2バッチ目: 複数角度の結果で完了まで進む", async () => {
    const three = {
      results: [
        { lens: "requirement", level: "clean", model: "p/m" },
        { lens: "behavior", level: "clean", model: "p/m" },
        { lens: "progress", level: "clean", model: "p/m" },
      ],
      summaries: [
        { lens: "requirement", summary: "a" },
        { lens: "behavior", summary: "b" },
        { lens: "progress", summary: "c" },
      ],
      bodies: [],
      missing: [],
      lenses: ["requirement", "behavior", "progress"],
      diff_hash: "h2",
    };
    const { tools, calls } = recorder(baseImpl({ graphhopper_verify: () => three }));
    const out = (await runRecipe(recipe("tail"), tools)) as { stop: string };
    expect(out.stop).toBe("clean");
    const setArgs = calls.find((c) => c.name === "graphhopper_verifier_set")!.args;
    expect((setArgs["results"] as unknown[]).length).toBe(3);
    expect(calls.some((c) => c.name === "graphhopper_goal")).toBe(true);
  });

  test("判定不能の lens を投げ直せば記録できる（tail の再実行）", async () => {
    let attempt = 0;
    const { tools, calls } = recorder(
      baseImpl({
        graphhopper_verify: () => {
          attempt += 1;
          if (attempt === 1) {
            return { ...CLEAN_VERIFY, results: [], summaries: [], missing: [{ lens: "general", reason: "timeout" }] };
          }
          return CLEAN_VERIFY;
        },
      }),
    );
    const first = (await runRecipe(recipe("tail"), tools)) as { stop: string };
    expect(first.stop).toBe("verify");
    const second = (await runRecipe(recipe("tail"), tools)) as { stop: string };
    expect(second.stop).toBe("clean");
    expect(calls.filter((c) => c.name === "graphhopper_verifier_set")).toHaveLength(1);
  });
});

describe("refs/implementing.md の編集レシピ（design g-mwiocibp 判断7）", () => {
  const implMd = readFileSync(
    join(import.meta.dir, "..", "skills", "graphhopper", "refs", "implementing.md"),
    "utf8",
  );
  function editRecipe(): string {
    const m = /\/\/ recipe: edit[^\n]*\n([\s\S]*?)```/.exec(implMd);
    if (!m) throw new Error("編集レシピが無い");
    return m[1]!;
  }

  test("hash → edit を1バッチで回し、適用済みを返す", async () => {
    const calls: string[] = [];
    const tools = {
      graphhopper_hash: (a: Record<string, unknown>) => {
        calls.push(`hash:${String(a["filePath"])}`);
        return { path: String(a["filePath"]), sha1: "s1", size: 1, mtime: "t" };
      },
      graphhopper_edit: (a: Record<string, unknown>) => {
        calls.push(`edit:${String(a["filePath"])}`);
        expect(a["expectedHash"]).toBe("s1");
        return '{"sha1":"s2"}';
      },
    };
    const out = (await runRecipe(editRecipe(), tools)) as { applied: string[] };
    expect(out.applied).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls).toEqual(["hash:src/a.ts", "edit:src/a.ts", "hash:src/b.ts", "edit:src/b.ts"]);
  });

  test("途中の拒否で止まり、適用済みと失敗理由を返す（残りは実行しない）", async () => {
    const calls: string[] = [];
    const tools = {
      graphhopper_hash: (a: Record<string, unknown>) => {
        calls.push(`hash:${String(a["filePath"])}`);
        return { path: String(a["filePath"]), sha1: "s1", size: 1, mtime: "t" };
      },
      graphhopper_edit: (a: Record<string, unknown>) => {
        calls.push(`edit:${String(a["filePath"])}`);
        if (a["filePath"] === "src/b.ts") throw new Error("hash mismatch");
        return '{"sha1":"s2"}';
      },
    };
    const out = (await runRecipe(editRecipe(), tools)) as {
      applied: string[];
      failed: { filePath: string; reason: string };
    };
    expect(out.applied).toEqual(["src/a.ts"]);
    expect(out.failed.filePath).toBe("src/b.ts");
    expect(out.failed.reason).toContain("hash mismatch");
    // 後続のファイルは実行しない（部分的に適用した事実を取り違えない）
    expect(calls.filter((c) => c.startsWith("edit:"))).toEqual(["edit:src/a.ts", "edit:src/b.ts"]);
  });

  test("oracle の呼び出しは graphhopper_invoke に揃っている（design g-mwiwxc5a 判断6）", () => {
    expect(implMd).not.toContain("task(subagent_type:");
    expect(implMd).not.toContain("task(task_id:");
    expect(implMd).toContain('graphhopper_invoke(agent: "graphhopper-oracle")');
  });

  test("no-goal の error 文字列も失敗として扱う", async () => {
    const tools = {
      graphhopper_hash: (a: Record<string, unknown>) => ({
        path: String(a["filePath"]),
        sha1: "s1",
        size: 1,
        mtime: "t",
      }),
      graphhopper_edit: () => "error: no active goal (use plain edit as fallback, no event recorded)",
    };
    const out = (await runRecipe(editRecipe(), tools)) as {
      applied: string[];
      failed: { reason: string };
    };
    expect(out.applied).toEqual([]);
    expect(out.failed.reason).toContain("no active goal");
  });
});
