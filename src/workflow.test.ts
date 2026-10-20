import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUGFIX_WORKFLOW,
  allowRecovery,
  canReuse,
  expandTemplate,
  extractJsonBlock,
  nodeKey,
  readRun,
  resolveNodeModel,
  validateOutput,
} from "./workflow";
import { runWorkflow, type WorkflowHost } from "./workflow-runner";
import type { CascadeConfig } from "./state";

const cascade = (over: Partial<CascadeConfig> = {}): CascadeConfig => ({
  enabled: true,
  baseline: "p/base",
  escalate: "p/esc",
  escalate_on: ["hard"],
  fail_threshold: 2,
  agents: { apply: "always", quality: { "graphhopper-verifier": "p/ver" } },
  ...over,
});

describe("純粋層", () => {
  test("resolveNodeModel", () => {
    const [repro, , verify] = BUGFIX_WORKFLOW.nodes;
    expect(resolveNodeModel(repro!, cascade())).toBe("p/base");
    expect(resolveNodeModel(verify!, cascade())).toBe("p/ver");
    expect(resolveNodeModel(repro!, cascade(), true)).toBe("p/esc");
    expect(resolveNodeModel(repro!, cascade({ enabled: false }))).toBeNull();
  });
  test("expandTemplate", () => {
    expect(expandTemplate("{{a.b}}-{{x}}", { a: { b: 1 }, x: "y" })).toBe("1-y");
    expect(expandTemplate("[{{nope.z}}]", {})).toBe("[]");
  });
  test("extractJsonBlock は最後のブロック", () => {
    const t = "```json\n{\"a\":1}\n```\n本文\n```json\n{\"a\":2}\n```";
    expect(extractJsonBlock(t)).toEqual({ a: 2 });
    expect(extractJsonBlock("なし")).toBeNull();
    expect(extractJsonBlock("```json\n{bad\n```")).toBeNull();
  });
  test("validateOutput", () => {
    const spec = { required: ["a", "b"], types: { a: "string" as const, b: "array" as const } };
    expect(validateOutput({ a: "x", b: [] }, spec)).toEqual([]);
    expect(validateOutput({ a: 1 }, spec).length).toBe(2);
  });
  test("nodeKey は入力で決まり、canReuse は実行後 repo の一致も要求", () => {
    const p = { defHash: "d", nodeId: "n", prompt: "p", model: "m" };
    expect(nodeKey(p)).toBe(nodeKey({ ...p }));
    expect(nodeKey(p)).not.toBe(nodeKey({ ...p, prompt: "q" }));
    const rec = { id: "n", key: nodeKey(p), status: "done" as const, output: { a: 1 }, models: [], sessions: [], at: "", repoAfter: "r1" };
    expect(canReuse(rec, rec.key, "r1")).toBe(true);
    expect(canReuse(rec, rec.key, "r2")).toBe(false);
    expect(canReuse({ ...rec, status: "failed" }, rec.key, "r1")).toBe(false);
    expect(canReuse(undefined, rec.key, "r1")).toBe(false);
  });
  test("allowRecovery: 許可リスト外・使用済みは abort", () => {
    expect(allowRecovery("oracle", [])).toBe("oracle");
    expect(allowRecovery("oracle", ["oracle"])).toBe("abort");
    expect(allowRecovery("rm -rf", [])).toBe("abort");
    expect(allowRecovery(undefined, [])).toBe("abort");
    expect(allowRecovery("abort", ["oracle"])).toBe("abort");
  });
});

/* fake host: ノード id（title から）ごとに出力の列を返す */
function fake(script: Record<string, string[]>) {
  const calls: { title: string; model: string | null; agent: string | null; meta: Record<string, string> }[] = [];
  const counters: Record<string, number> = {};
  const sessions = new Map<string, string>();
  const interrupted: string[] = [];
  let repo = "r1";
  let n = 0;
  const host: WorkflowHost = {
    async createChild(i) {
      const id = `s${n++}`;
      calls.push({ title: i.title, model: i.model, agent: i.agent, meta: i.metadata });
      sessions.set(id, i.title.replace(/^graphhopper (bugfix\/)?/, ""));
      return id;
    },
    async prompt() {},
    async wait() {},
    async lastText(id) {
      const key = sessions.get(id)!;
      const arr = script[key] ?? [];
      const idx = counters[key] ?? 0;
      counters[key] = idx + 1;
      return arr[Math.min(idx, arr.length - 1)] ?? "";
    },
    async interrupt(id) {
      interrupted.push(id);
    },
    async repoHash() {
      return repo;
    },
  };
  return { host, calls, interrupted, setRepo: (v: string) => (repo = v) };
}

const J = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
const OK = {
  repro: [J({ test_file: "t.test.ts", command: "bun test t", failing: true })],
  fix: [J({ summary: "s", files: ["a.ts"], passing: true })],
  "verify:requirement": [J({ level: "clean", findings: [] })],
  "verify:behavior": [J({ level: "clean", findings: [] })],
  "verify:progress": [J({ level: "clean", findings: [] })],
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = (extra: Partial<Parameters<typeof runWorkflow>[1]> = {}) => ({
  root,
  goal: "g1",
  task: "バグ",
  def: BUGFIX_WORKFLOW,
  cascade: cascade(),
  nodeTimeoutMs: 1000,
  decideRecovery: async () => "abort",
  isAborted: () => false,
  ...extra,
});

describe("runWorkflow", () => {
  test("通し: repro→fix→verify(3 lens 並列)、明示モデル・直接の子", async () => {
    const f = fake(OK);
    const r = await runWorkflow(f.host, base());
    expect(r.status).toBe("done");
    expect(r.nodes.map((n) => n.id)).toEqual(["repro", "fix", "verify"]);
    expect(f.calls.length).toBe(5);
    expect(f.calls.find((c) => c.title.endsWith("/repro"))!.model).toBe("p/base");
    expect(f.calls.filter((c) => c.title.includes("verify")).every((c) => c.model === "p/ver")).toBe(true);
    expect(f.calls.every((c) => c.meta.graphhopper_runner === "1")).toBe(true);
    expect(readRun(root, "g1")!.status).toBe("done");
  });

  test("スキーマ不正は同じ子に再プロンプトして回復", async () => {
    const f = fake({ ...OK, repro: ["壊れた", OK.repro[0]!] });
    const r = await runWorkflow(f.host, base());
    expect(r.status).toBe("done");
    expect(f.calls.filter((c) => c.title.endsWith("/repro")).length).toBe(1);
  });

  test("resume: キー一致のノードは再利用、repo が変わると再実行", async () => {
    const f1 = fake(OK);
    const r1 = await runWorkflow(f1.host, base());
    const f2 = fake(OK);
    await runWorkflow(f2.host, base({ resume: r1 }));
    expect(f2.calls.length).toBe(0);
    const f3 = fake(OK);
    f3.setRepo("r2");
    await runWorkflow(f3.host, base({ resume: r1 }));
    expect(f3.calls.length).toBe(5);
  });

  test("resume: 後続ノードが repo を変えていても、最後の完了ノードと現在が一致すれば先行ノードも再利用", async () => {
    const f1 = fake(OK);
    const r1 = await runWorkflow(f1.host, base());
    r1.nodes.find((n) => n.id === "repro")!.repoAfter = "r0";
    const f2 = fake(OK);
    await runWorkflow(f2.host, base({ resume: r1 }));
    expect(f2.calls.length).toBe(0);
  });

  test("失敗→oracle 挿入→advice を付けて再実行し成功、挿入は1回まで", async () => {
    const f = fake({
      ...OK,
      repro: ["x", "x", J({ test_file: "t", command: "c", failing: true })],
      oracle: [J({ advice: "こうしろ" })],
    });
    // 1回目: retry 含め repro 失敗（x,x）→ oracle → 再実行
    const r = await runWorkflow(f.host, base({ decideRecovery: async () => "oracle" }));
    expect(r.status).toBe("done");
    expect(r.inserted).toEqual(["oracle"]);
    const oracleCall = f.calls.find((c) => c.title.includes("oracle"))!;
    expect(oracleCall.model).toBe("p/esc");
  });

  test("許可リスト外の回復・d1 失敗は abort", async () => {
    const f = fake({ ...OK, repro: ["x"] });
    const r = await runWorkflow(f.host, base({ decideRecovery: async () => "rm -rf /" }));
    expect(r.status).toBe("failed");
    const f2 = fake({ ...OK, repro: ["x"] });
    const r2 = await runWorkflow(f2.host, base({ decideRecovery: async () => { throw new Error("d1 down"); } }));
    expect(r2.status).toBe("failed");
  });

  test("escalate_tier は quality モデルで再実行、2回目の失敗は abort", async () => {
    const f = fake({ ...OK, repro: ["x"] });
    const r = await runWorkflow(f.host, base({ decideRecovery: async () => "escalate_tier" }));
    expect(r.status).toBe("failed");
    expect(r.inserted).toEqual(["escalate_tier"]);
    const reproCalls = f.calls.filter((c) => c.title.endsWith("/repro"));
    expect(reproCalls.map((c) => c.model)).toEqual(["p/base", "p/esc"]);
  });

  test("verify が drift なら fix に1回だけ差し戻す", async () => {
    const f = fake({
      ...OK,
      "verify:behavior": [J({ level: "drift", findings: ["壊れてる"] }), J({ level: "clean", findings: [] })],
    });
    const r = await runWorkflow(f.host, base());
    expect(r.status).toBe("done");
    expect(r.feedbackUsed).toBe(true);
    expect(f.calls.filter((c) => c.title.endsWith("/fix")).length).toBe(2);
  });

  test("abort 要求で開始前に停止", async () => {
    const f = fake(OK);
    const r = await runWorkflow(f.host, base({ isAborted: () => true }));
    expect(r.status).toBe("aborted");
    expect(f.calls.length).toBe(0);
  });

  test("wait 中の abort も即座に打ち切り interrupt する", async () => {
    const f = fake(OK);
    f.host.wait = () => new Promise(() => {});
    let trigger!: () => void;
    const abortSignal = new Promise<void>((r) => (trigger = r));
    let aborted = false;
    const p = runWorkflow(f.host, base({ nodeTimeoutMs: 60_000, isAborted: () => aborted, abortSignal }));
    await new Promise((r) => setTimeout(r, 20));
    aborted = true;
    trigger();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(f.interrupted.length).toBeGreaterThan(0);
  });

  test("timeout は interrupt して失敗扱い", async () => {
    const f = fake(OK);
    f.host.wait = () => new Promise(() => {});
    const r = await runWorkflow(f.host, base({ nodeTimeoutMs: 20 }));
    expect(r.status).toBe("failed");
    expect(f.interrupted.length).toBeGreaterThan(0);
  });
});
