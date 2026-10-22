/**
 * graphhopper v2 plugin: dynamic workflow runner の接続層。
 * ctx.session で子を起動し（permissions で task を deny＝孫を作らせない）、
 * 純粋層 src/workflow-runner.ts を駆動する。plugin プロセス内でのみ動く。
 */
import { randomUUID } from "node:crypto";
import { $ } from "bun";
import { chooseRecovery, chooseWorkflow } from "../../../src/decision";
import { INTERNAL_PROMPT_METADATA_KEY } from "../../../src/entry-decide";
import * as state from "../../../src/state";
import { parseCascadeModel } from "../../../src/cascade";
import {
  getWorkflow,
  readRun,
  writeRun,
  sha1,
  summarizeRun,
  type RunState,
} from "../../../src/workflow";
import { runWorkflow, type WorkflowHost } from "../../../src/workflow-runner";
import { S, text, type Gh } from "./shared";

/** runner が起動した子（hook の cascade 二重切替を避ける）。create 前に登録する */
export const runnerChildren = new Set<string>();
const NO_GRANDCHILD = [
  { action: "task", resource: "*", effect: "deny" as const },
  { action: "graphhopper_workflow", resource: "*", effect: "deny" as const },
];

const aborts = new Map<string, { aborted: boolean; trigger: () => void }>();

function makeHost(gh: Gh, parentID: string): WorkflowHost {
  const { ctx, root } = gh;
  return {
    async createChild(i) {
      const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
      runnerChildren.add(id);
      const model = parseCascadeModel(i.model);
      await ctx.session.create({
        id,
        parentID,
        title: i.title,
        ...(i.agent ? { agent: i.agent } : {}),
        ...(model ? { model } : {}),
        metadata: i.metadata,
        permissions: NO_GRANDCHILD,
      } as never);
      return id;
    },
    async prompt(sessionID, t) {
      await ctx.session.prompt({
        sessionID,
        text: t,
        metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
      });
    },
    async wait(sessionID) {
      await ctx.session.wait({ sessionID });
    },
    async lastText(sessionID) {
      const all = (await ctx.session.context({ sessionID })) as unknown as {
        type?: string;
        content?: { type?: string; text?: string }[];
      }[];
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i]!;
        if (m.type !== "assistant") continue;
        const t = (m.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (t.trim()) return t;
      }
      return "";
    },
    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID });
    },
    async repoHash() {
      const g = await $`git diff HEAD`.cwd(root).quiet().nothrow().text();
      const u = await $`git ls-files --others --exclude-standard`.cwd(root).quiet().nothrow().text();
      const files = u.split("\n").filter((f) => f && !f.startsWith(".graphhopper/"));
      const parts: string[] = [];
      for (const f of files) parts.push(f + ":" + sha1(await Bun.file(`${root}/${f}`).text().catch(() => "")));
      return sha1(g + "\u0000" + parts.join("\n"));
    },
  };
}

/** session.created で孫（runner 子の子）を検知したら run を abort する */
export function handleGrandchild(gh: Gh, data: Record<string, unknown> | undefined): boolean {
  const parentID = typeof data?.parentID === "string" ? data.parentID : null;
  const sessionID = typeof data?.sessionID === "string" ? data.sessionID : "";
  if (!parentID || !runnerChildren.has(parentID)) return false;
  if (runnerChildren.has(sessionID)) return true;
  const active = state.getActive(gh.root);
  const flag = active ? aborts.get(active.goal.id) : undefined;
  if (flag) {
    flag.aborted = true;
    flag.trigger();
  }
  runnerChildren.add(sessionID);
  void gh.ctx.session.interrupt({ sessionID }).catch(() => {});
  console.warn("graphhopper: workflow の子セッションが孫を作成したため abort します");
  return true;
}

export function registerWorkflowTool(
  editor: { add(tool: Record<string, unknown>): void },
  gh: Gh,
): void {
  const { root } = gh;
  editor.add({
    name: "graphhopper_workflow",
    description:
      "dynamic workflow runner（bugfix: 再現テスト→修正→verify）。start=goal が implementing 以降のとき起動 / status / resume=中断した run を再開 / abort。子は明示tierのモデルで起動し孫は作らせない。verify結果はdone判定には使わない（doneは従来どおりverifier fan-outで記録）",
    input: S.obj(
      {
        action: S.enumOf(["start", "status", "resume", "abort", "suggest"]),
        task: S.optStr("action=start のときバグ報告（再現手順・症状）"),
      },
      ["action"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { action: string; task?: string };
      const sessionID = String((context as { sessionID?: string }).sessionID ?? "");
      const active = state.getActive(root);
      if (!active) return text("error: active goal が無い。graphhopper_goal(start) してから使え");
      const goal = active.goal.id;

      const stale = readRun(root, goal);
      if (stale?.status === "running" && !aborts.has(goal)) {
        stale.status = "aborted";
        stale.error = "プロセス再読込で中断（resume で再開可）";
        stale.current = null;
        for (const id of stale.running ?? []) await gh.ctx.session.interrupt({ sessionID: id }).catch(() => {});
        stale.running = [];
        writeRun(root, stale);
      }
      if (args.action === "suggest") {
        if (!args.task?.trim()) return text("error: task が必要");
        const w = await chooseWorkflow(args.task, fetch, { root });
        return text(w === "none" ? "d1判定: 適用するworkflowなし（通常のgoalループで進める）" : `d1判定: workflow=${w}（graphhopper_workflow(start) で起動できる）`);
      }
      if (args.action === "status") {
        return text(summarizeRun(readRun(root, goal)) ?? "workflow: run なし");
      }
      if (args.action === "abort") {
        const f = aborts.get(goal);
        if (!f) return text("実行中の run は無い");
        f.aborted = true;
        f.trigger();
        return text("abort を要求した（実行中の子を interrupt して停止する）");
      }

      if (args.action !== "start" && args.action !== "resume") return text("error: 不明な action");
      if (active.state.phase === "designing") return text("error: designing 中は起動できない。implementing に遷移してから");
      if (aborts.has(goal)) return text("error: この goal の run は既に実行中");

      const prev = args.action === "resume" ? readRun(root, goal) : null;
      if (args.action === "resume" && (!prev || prev.status === "done")) {
        return text("error: 再開できる run が無い（無い or 完了済み）");
      }
      const task = args.task ?? prev?.task ?? "";
      if (!task.trim()) return text("error: task（バグ報告）が必要");
      const def = getWorkflow(prev?.workflow ?? "bugfix");
      if (!def) return text("error: 未知のworkflow");

      let trigger: () => void = () => {};
      const abortSignal = new Promise<void>((r) => (trigger = r));
      const flag = { aborted: false, trigger: () => trigger() };
      aborts.set(goal, flag);
      const config = state.readConfig(root);
      const host = makeHost(gh, sessionID);

      void (async () => {
        let result: RunState | null = null;
        try {
          result = await runWorkflow(host, {
            root,
            goal,
            task,
            def,
            cascade: config.cascade,
            nodeTimeoutMs: config.workflow?.node_timeout_ms || 10 * 60_000,
            isAborted: () => flag.aborted,
            abortSignal,
            resume: prev,
            decideRecovery: (f) => chooseRecovery({ ...f, task }, fetch, { root }),
          });
        } catch (e) {
          console.warn(`graphhopper: workflow 異常終了 ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (aborts.get(goal) === flag) aborts.delete(goal);
          for (const n of (result ?? readRun(root, goal))?.nodes ?? []) for (const id of n.sessions) runnerChildren.delete(id);
          try {
            await gh.ctx.session.synthetic({
              sessionID,
              text: `[graphhopper] ${summarizeRun(result ?? readRun(root, goal)) ?? "workflow 終了"}`,
            } as never);
          } catch {
            // 通知失敗は run 結果に影響しない
          }
        }
      })();

      return text(
        `workflow ${def.name} を${args.action === "resume" ? "再開" : "開始"}した（バックグラウンド実行）。` +
          "進捗は graphhopper_workflow(status)、停止は abort。完了時にこのセッションへ通知される。",
      );
    },
  });
}
