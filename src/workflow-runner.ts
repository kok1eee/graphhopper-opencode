/**
 * dynamic workflow runner — 実行層。ctx 依存は WorkflowHost に閉じる（fake で差し替えてテスト）。
 * 子は常に runner 起動の直接の子。孫は permissions の task deny で防ぐ（host 側で付与）。
 */
import type { CascadeConfig } from "./state";
import {
  ORACLE_NODE,
  allowRecovery,
  canReuse,
  defHash,
  expandTemplate,
  extractJsonBlock,
  nodeKey,
  resolveNodeModel,
  type Tier,
  validateOutput,
  writeRun,
  type NodeRecord,
  type RecoveryKind,
  type RunState,
  type WorkflowDef,
  type WorkflowNode,
} from "./workflow";

export interface WorkflowHost {
  createChild(input: {
    agent: string | null;
    model: string | null;
    title: string;
    metadata: Record<string, string>;
  }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  wait(sessionID: string): Promise<void>;
  /** 最終アシスタントのテキスト */
  lastText(sessionID: string): Promise<string>;
  interrupt(sessionID: string): Promise<void>;
  repoHash(): Promise<string>;
}

export interface RunOptions {
  root: string;
  goal: string;
  task: string;
  def: WorkflowDef;
  cascade: CascadeConfig;
  nodeTimeoutMs: number;
  /** d1 に失敗時の回復手を選ばせる。失敗・不明は "abort" を返す */
  decideRecovery(failed: { id: string; reason: string }): Promise<string>;
  isAborted(): boolean;
  /** abort 要求を待つ Promise（wait 中でも即座に打ち切るため）。省略時は isAborted のポーリング */
  abortSignal?: Promise<void>;
  /** 再開時の既存 run */
  resume?: RunState | null;
}

interface NodeResult {
  ok: boolean;
  output: Record<string, unknown> | null;
  reason: string;
  sessions: string[];
}

const RETRY_PROMPT = (errs: string) =>
  `出力形式が不正です（${errs}）。指定のスキーマに従い、末尾に \`\`\`json フェンスのブロック1つだけで出し直してください。`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    if (typeof t === "object" && "unref" in t) t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 1つの子で prompt→wait→抽出→検証。不正は同じ子に再プロンプト */
async function runOne(
  host: WorkflowHost,
  node: WorkflowNode,
  prompt: string,
  model: string | null,
  title: string,
  meta: Record<string, string>,
  opts: RunOptions,
  active: Set<string>,
): Promise<NodeResult> {
  let sessionID = "";
  try {
    sessionID = await host.createChild({ agent: node.agent, model, title, metadata: meta });
    active.add(sessionID);
    let text = prompt;
    let reason = "";
    for (let attempt = 0; attempt <= node.maxRetry; attempt++) {
      if (opts.isAborted()) return { ok: false, output: null, reason: "aborted", sessions: [sessionID] };
      await host.prompt(sessionID, text);
      const w = await withTimeout(
        opts.abortSignal ? Promise.race([host.wait(sessionID), opts.abortSignal.then(() => "aborted" as const)]) : host.wait(sessionID),
        opts.nodeTimeoutMs,
      );
      if (w === "aborted" || opts.isAborted()) {
        await host.interrupt(sessionID).catch(() => {});
        return { ok: false, output: null, reason: "aborted", sessions: [sessionID] };
      }
      if (w === "timeout") {
        await host.interrupt(sessionID).catch(() => {});
        return { ok: false, output: null, reason: "timeout", sessions: [sessionID] };
      }
      const out = extractJsonBlock(await host.lastText(sessionID));
      if (!out) {
        reason = "JSON ブロックが無い/不正";
      } else {
        const errs = validateOutput(out, node.output);
        if (errs.length === 0) return { ok: true, output: out, reason: "", sessions: [sessionID] };
        reason = errs.join("・");
      }
      text = RETRY_PROMPT(reason);
    }
    return { ok: false, output: null, reason: `スキーマ不正: ${reason}`, sessions: [sessionID] };
  } catch (e) {
    return {
      ok: false,
      output: null,
      reason: `実行失敗: ${e instanceof Error ? e.message : String(e)}`,
      sessions: sessionID ? [sessionID] : [],
    };
  } finally {
    if (sessionID) active.delete(sessionID);
  }
}

export async function runWorkflow(host: WorkflowHost, opts: RunOptions): Promise<RunState> {
  const { def, root } = opts;
  const dh = defHash(def);
  const now = () => new Date().toISOString();
  const run: RunState = opts.resume
    ? { ...opts.resume, status: "running", error: undefined }
    : {
        goal: opts.goal,
        workflow: def.name,
        task: opts.task,
        status: "running",
        current: null,
        nodes: [],
        inserted: [],
        feedbackUsed: false,
        started: now(),
        updated: now(),
      };
  class Tracked extends Set<string> {
    override add(v: string) {
      super.add(v);
      sync();
      return this;
    }
    override delete(v: string) {
      const r = super.delete(v);
      sync();
      return r;
    }
    override clear() {
      super.clear();
      sync();
    }
  }
  const active = new Tracked();
  const sync = () => {
    run.running = [...active];
    save();
  };
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const n of run.nodes) if (n.status === "done" && n.output) outputs[n.id] = n.output;
  let feedback = run.feedback ?? "";
  let advice = run.advice ?? "";
  const save = () => writeRun(root, run);

  const finish = async (status: RunState["status"], error?: string): Promise<RunState> => {
    for (const s of active) await host.interrupt(s).catch(() => {});
    active.clear();
    run.status = status;
    run.current = null;
    if (error) run.error = error;
    save();
    return run;
  };

  const record = (rec: NodeRecord) => {
    const i = run.nodes.findIndex((n) => n.id === rec.id);
    if (i >= 0) run.nodes[i] = rec;
    else run.nodes.push(rec);
    save();
  };

  let coherent: boolean | null = null;

  /** ノードを実行（キャッシュ→子起動）。fanout は lens ごとに並列で直接の子を起動 */
  const execNode = async (
    node: WorkflowNode,
    tierOverride?: Tier | null,
  ): Promise<{ ok: boolean; output: Record<string, unknown> | null; reason: string }> => {
    const model = resolveNodeModel(node, opts.cascade, tierOverride);
    const baseVars = { task: opts.task, outputs, feedback, advice: run.adviceNode === node.id ? advice : "" };
    const lenses = node.fanout ?? [null];
    const prompts = lenses.map((lens) => expandTemplate(node.prompt, { ...baseVars, lens: lens ?? "" }));
    const key = nodeKey({ defHash: dh, nodeId: node.id, prompt: prompts.join("\u0001"), model });

    const cached = run.nodes.find((n) => n.id === node.id);
    const repoNow = await host.repoHash();
    if (coherent === null) {
      const last = [...run.nodes].reverse().find((n) => n.status === "done" && n.repoAfter);
      coherent = !!last && last.repoAfter === repoNow;
    }
    if (cached && canReuse(cached, key, coherent ? cached.repoAfter! : repoNow)) {
      return { ok: true, output: cached.output!, reason: "" };
    }
    if (opts.isAborted()) return { ok: false, output: null, reason: "aborted" };

    const results = await Promise.all(
      lenses.map((lens, i) =>
        runOne(
          host,
          node,
          prompts[i]!,
          model,
          `graphhopper ${def.name}/${node.id}${lens ? `:${lens}` : ""}`,
          { graphhopper_runner: "1", goal: opts.goal, node: node.id, ...(lens ? { lens } : {}) },
          opts,
          active,
        ),
      ),
    );
    coherent = false;
    const sessions = results.flatMap((r) => r.sessions);
    const failed = results.find((r) => !r.ok && r.reason === "aborted") ?? results.find((r) => !r.ok);
    if (failed) {
      record({ id: node.id, key, status: "failed", output: null, models: model ? [model] : [], sessions, at: now(), reason: failed.reason });
      return { ok: false, output: null, reason: failed.reason };
    }
    const output: Record<string, unknown> = node.fanout
      ? {
          level: results.every((r) => r.output?.level === "clean") ? "clean" : "drift",
          findings: results.flatMap((r) => (Array.isArray(r.output?.findings) ? (r.output!.findings as unknown[]) : [])),
          lenses: Object.fromEntries(lenses.map((l, i) => [l as string, results[i]!.output])),
        }
      : results[0]!.output!;
    record({ id: node.id, key, status: "done", output, models: model ? [model] : [], sessions, at: now(), repoAfter: await host.repoHash() });
    return { ok: true, output, reason: "" };
  };

  let i = 0;
  while (i < def.nodes.length) {
    const node = def.nodes[i]!;
    if (opts.isAborted()) return finish("aborted", "abort 要求");
    run.current = node.id;
    save();

    let tierOverride: Tier | null = null;
    let r = await execNode(node, tierOverride);
    while (!r.ok) {
      if (r.reason === "aborted") return finish("aborted", "abort 要求");
      const choice: RecoveryKind = allowRecovery(
        await opts.decideRecovery({ id: node.id, reason: r.reason }).catch(() => "abort"),
        run.inserted,
      );
      if (choice === "abort") return finish("failed", `${node.id} 失敗: ${r.reason}`);
      run.inserted.push(choice);
      save();
      if (choice === "oracle") {
        const oraclePrompt = expandTemplate(ORACLE_NODE.prompt, { failed: { id: node.id, reason: r.reason } });
        const o = await runOne(host, ORACLE_NODE, oraclePrompt, resolveNodeModel(ORACLE_NODE, opts.cascade), "graphhopper oracle", { graphhopper_runner: "1", goal: opts.goal, node: "oracle" }, opts, active);
        if (!o.ok) return finish("failed", `oracle 失敗: ${o.reason}`);
        advice = `\n助言: ${String(o.output?.advice ?? "")}\n`;
        run.advice = advice;
        run.adviceNode = node.id;
        save();
      } else if (choice === "second_opinion") {
        tierOverride = "second";
      } else {
        tierOverride = "quality";
      }
      r = await execNode(node, tierOverride);
    }
    outputs[node.id] = r.output!;

    if (node.feedbackTo && r.output?.level !== "clean" && !run.feedbackUsed) {
      const target = def.nodes.findIndex((n) => n.id === node.feedbackTo);
      if (target >= 0) {
        run.feedbackUsed = true;
        const findings = Array.isArray(r.output?.findings) ? (r.output!.findings as unknown[]).map((f) => (typeof f === "string" ? f : JSON.stringify(f))).join("\n- ") : "";
        feedback = `\n検証の指摘（これを解消すること）:\n- ${findings}\n`;
        run.feedback = feedback;
        save();
        i = target;
        continue;
      }
    }
    i++;
  }
  return finish("done");
}
