/**
 * graphhopper v2 plugin: hooks (tool.execute.before/after, session context/
 * compaction, event.subscribe 駆動)。
 * v1 src/index.ts の hooks＋event ハンドラ本体を v2 形に移植。
 * H3 対応: context() は全文のみ (limit 無し) のためローカルで tail slice する。
 */
import { $ } from "bun";
import { finishCascade, flushOrphanCascade, syncCascade } from "./cascade";
import {
  type ChildHost,
  escalateChildSession,
  resolveChildModel,
  shouldSwitchChild,
} from "../../../src/cascade";
import {
  autoEscalateOnStuck,
  continuationText,
  designDocLockedRefusal,
  designGateRefusal,
  effectivePhaseAction,
  ESCALATE_NEXT,
  isGateTargetTool,
  PHASE_ACTION_BRIEF,
  PONYTAIL_BRIEF,
} from "../../../src/gate";
import { PONYTAIL_RULES } from "../../../src/ponytail-rules";
import { pushGoalIntent, resolveCompactDb, runCompactGate } from "../../../src/compact";
import { isFailedEvent, isInterruptedEvent, isTurnEndEvent } from "../../../src/events";
import * as state from "../../../src/state";
import { isDesignDocLocked, isDesignGateBlocked } from "../../../src/state";
import { LSPServerManager } from "../../../src/lsp/client";
import { handleGrandchild } from "./workflow";
import type { Gh } from "./shared";

const SYSTEM_GUIDE = `## graphhopper（designing/implementing/polishループ）の存在

この環境には graphhopper プラグインが常駐している。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら、手を付ける前に graphhopper_goal(action: "start", title: ...) でループを開始せよ。

designing フェーズでは source ファイルの edit/write は物理的にブロックされる（許可されるのは .graphhopper/plans/ 配下の design ドキュメントのみ）。まず design ドキュメントを書き、graphhopper-critic で1回敵対レビューしてから implementing フェーズに遷移して実装せよ。

使わない場面: 単一ファイルの小修正・質問への回答・一回きりのコマンド実行程度の単純作業。その場合は直接やれ。

active な goal が既にあるなら graphhopper_status で状態を確認し、ループの継続として振る舞え。`;

const SYSTEM_GUIDE_IDLE = `## graphhopper（常駐・goal進行中はphase指示に従え。goal外の小用件は直接対応可）`;

/* idle 取得の窓と上限 (H3: v2 は全文取得のみ。窓切りはローカルで行う)。
 * TAIL_LIMIT: loop検知窓 + echo用履歴 + margin。SAMPLING 概念は廃止
 * (毎回全文のため sampling/full の区別が無い)。oversizeSticky は維持。 */
const TAIL_LIMIT = 50;
const MAX_FETCH_CHARS = 2_000_000;
let oversizeSticky = false;

/* system注入節約用の記憶 (v1 と同型。再起動・compact後は消失しfull再送) */
const seenPhaseGuides = new Set<string>();
const seenPonytails = new Set<string>();

function resolveFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const raw = a["filePath"] ?? a["path"] ?? a["file_path"];
  return typeof raw === "string" ? raw : undefined;
}

/* v2 SessionMessageInfo → state.SessionMessageLike への adapter。
 * v1 SDK 形 (info/parts) と v2 形 (type/time/content) をここで吸収する。 */
type V2Msg = {
  id?: string;
  type?: string;
  time?: { created?: number };
  text?: string;
  content?: { type?: string; text?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } }[];
};

function toLike(m: V2Msg): state.SessionMessageLike {
  const role = m.type === "assistant" ? "assistant" : "user";
  if (role === "user") {
    return {
      info: { id: String(m.id ?? ""), role },
      parts: [{ type: "text", text: String(m.text ?? "") }],
    };
  }
  const parts: state.SessionMessageLike["parts"] = [];
  for (const c of m.content ?? []) {
    if (c.type === "text") {
      parts.push({ type: "text", text: String(c.text ?? "") });
    } else if (c.type === "tool") {
      parts.push({
        type: "tool",
        callID: String(c.id ?? ""),
        tool: String(c.name ?? ""),
        state: { status: (c.state as { status?: string } | undefined)?.status, input: (c.state as { input?: unknown } | undefined)?.input },
      });
    }
  }
  return { info: { id: String(m.id ?? ""), role }, parts };
}

function tailLikes(all: V2Msg[]): state.SessionMessageLike[] | null {
  const size = JSON.stringify(all).length;
  if (size > MAX_FETCH_CHARS) {
    oversizeSticky = true;
    return null;
  }
  oversizeSticky = false;
  const ordered = [...all].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return ordered.slice(-TAIL_LIMIT).map(toLike);
}

interface BeforeEvent {
  tool?: string;
  sessionID?: string;
  input?: unknown;
}

interface AfterEvent {
  tool?: string;
  sessionID?: string;
  input?: unknown;
}

interface ContextEvent {
  sessionID?: string;
  system?: { type: string; text?: string }[];
}

interface CompactionEvent {
  sessionID?: string;
  messages?: unknown[];
}

export async function registerHooks(gh: Gh): Promise<() => void> {
  const { ctx, root } = gh;

  /* C-2不変条件: designing フェーズで source 編集を物理ブロックする */
  await ctx.tool.hook("execute.before", (event: unknown) => {
    const e = event as BeforeEvent;
    const toolName = String(e.tool ?? "").toLowerCase();
    if (!isGateTargetTool(e.tool)) return;
    const active = state.getActive(root);
    if (!active) return;
    const cfg = state.readConfig(root);
    const filePath = resolveFilePath((e as { input?: unknown }).input);
    if (!filePath) return;
    if (isDesignGateBlocked(root, cfg, active.state.phase, filePath)) {
      state.recordEvent(root, { type: "design_gate_block", goal: active.goal.id, tool: toolName, path: filePath });
      throw new Error(designGateRefusal(e.tool, filePath, cfg.design_gate_allow));
    }
    if (isDesignDocLocked(root, active.state.phase, active.goal.id, filePath)) {
      state.recordEvent(root, { type: "design_doc_locked_block", goal: active.goal.id, tool: toolName, path: filePath });
      throw new Error(designDocLockedRefusal(e.tool, filePath, active.goal.id));
    }
  });

  /* 信号A: 同一ファイル再編集の計数 (成功した edit/write のみ) */
  await ctx.tool.hook("execute.after", (event: unknown) => {
    try {
      const e = event as AfterEvent;
      if (!isGateTargetTool(e.tool)) return;
      const active = state.getActive(root);
      if (!active || active.goal.status !== "active") return;
      if (active.state.phase !== "implementing") return;
      if (!e.sessionID || e.sessionID !== active.state.session_id) return;
      const filePath = resolveFilePath(e.input);
      if (!filePath) return;
      state.noteEdit(root, filePath);
    } catch {
      // 計数失敗で編集自体を壊さない
    }
  });

  /* system 注入: guide＋phase指示＋ponytail (v1 と同型の節約つき) */
  await ctx.session.hook("context", (event: unknown) => {
    const e = event as ContextEvent;
    const push = (t: string) => e.system?.push({ type: "text", text: t });
    const active = state.getActive(root);
    push(active?.goal.status === "active" ? SYSTEM_GUIDE_IDLE : SYSTEM_GUIDE);
    if (
      active && active.goal.status === "active" && active.state.phase !== "done" &&
      e.sessionID && e.sessionID === active.state.session_id
    ) {
      const key = `${e.sessionID}:${active.goal.id}:${active.state.phase}`;
      if (seenPhaseGuides.has(key)) {
        push(`## graphhopper 次のアクション\n\n${PHASE_ACTION_BRIEF[active.state.phase]}`);
      } else {
        seenPhaseGuides.add(key);
        push(`## graphhopper 次のアクション（詳細）\n\n${effectivePhaseAction(active.state.phase, active.state.entry_route)}`);
      }
    }
    if (
      active && active.goal.status === "active" && active.state.phase === "implementing" &&
      e.sessionID && e.sessionID === active.state.session_id
    ) {
      const pkey = `${e.sessionID}:${active.goal.id}`;
      if (seenPonytails.has(pkey)) {
        push(PONYTAIL_BRIEF);
      } else {
        seenPonytails.add(pkey);
        push(PONYTAIL_RULES);
      }
    }
  });

  /* compact 連携 (M2: messages 付加方式。要約対象に goal intent を混ぜて落とさせない) */
  await ctx.session.hook("compaction", async (event: unknown) => {
    const e = event as CompactionEvent;
    const push = (t: string) => {
      e.messages?.push({ role: "user", content: [{ type: "text", text: t }] });
    };
    try {
      pushGoalIntent(() => state.getActive(root), push);
    } catch {
      // 要約を壊さないため例外は握りつぶす
    }
    try {
      const sessionID = typeof e.sessionID === "string" ? e.sessionID : "";
      await runCompactGate({ dbPath: resolveCompactDb(), sessionID, root, push });
    } catch {
      // keep-list側の例外も要約を壊さない
    }
  });

  /* event 駆動: deleted→unbind、idle→loop検知・dedupe・eval・continuation注入 */
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const event = raw as {
          type?: string;
          data?: { sessionID?: string; info?: { id?: string }; status?: { type?: string } };
        };
        /* turn 完了のシグナルは session.execution.succeeded（v2 の正）。
         * 判定は src/events.ts に集約している（src/events.ts:1 参照）。
         * interrupted（ユーザー中断）と failed（プロバイダ障害）は自動継続しない。
         *   両者は自動継続すると空回りするため、意図的に除外する。 */
        if (isInterruptedEvent(event.type) || isFailedEvent(event.type)) continue;
        const idle = isTurnEndEvent(event.type);
        try {
          if (event.type === "session.created") {
            const created = event.data as Record<string, unknown> | undefined;
            if (handleGrandchild(gh, created)) continue;
            handleChildSessionCreated(gh, created);
            continue;
          }
          if (event.type === "session.deleted") {
            const id = event.data?.info?.id;
            if (id) {
              const activeGoal = state.getActive(root);
              if (activeGoal?.state.session_id === id) await finishCascade(gh);
              state.unbindSession(root, id);
            }
            try {
              await LSPServerManager.stopAll();
            } catch {
              // 停止失敗は無視（idle timeout 60sが最終防御）
            }
            continue;
          }
          if (!idle) continue;
          await onIdle(gh, String(event.data?.sessionID ?? ""));
        } catch {
          // ループを止めないためイベントハンドラ内の例外は握りつぶす
        }
      }
    } catch (e) {
      console.warn(`graphhopper: event subscribe failed: ${String(e)}`);
    }
  })();

  return () => controller.abort();
}

/** 切替処理中の子セッション（同一 sessionID の二重切替を防ぐ） */
const inflightChildren = new Set<string>();

/**
 * 子セッション（subagent）が作成されたときのモデル切替。
 * quality マップ（verifier / simplify）に入っている agent だけを対象にし、
 * 親が goal の bound セッションであるときだけ切り替える。
 * 実行は detached（イベントループを待たない）。記録は同期書き込み。
 */
function handleChildSessionCreated(gh: Gh, data: Record<string, unknown> | undefined): void {
  if (!data) return;
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
  const parentID = typeof data.parentID === "string" ? data.parentID : null;
  const agent = typeof data.agent === "string" ? data.agent : null;
  if (!sessionID || !agent) return;

  const active = state.getActive(gh.root);
  if (!active) return;
  const config = state.readConfig(gh.root);
  if (!config.cascade.enabled) return;

  const target = resolveChildModel({ childAgent: agent, quality: config.cascade.agents.quality });
  if (!target) return;

  const current = data.model as { providerID?: string; id?: string } | undefined;
  const currentModel =
    current?.providerID && current?.id ? `${current.providerID}/${current.id}` : null;

  if (
    !shouldSwitchChild({
      parentID,
      boundSessionID: active.state.session_id,
      goalStatus: active.goal.status,
      childAgent: agent,
      currentModel,
      target,
      apply: config.cascade.agents.apply,
      level: active.state.cascade?.level ?? null,
    })
  ) {
    return;
  }
  // 冪等: 同じ子セッションは2回切替しない（記録済み or 実行中）
  if ((active.state.cascade?.children ?? []).some((c) => c.sessionID === sessionID)) return;
  if (inflightChildren.has(sessionID)) return;
  inflightChildren.add(sessionID);

  const host: ChildHost = {
    switchModel: async (id, model) => {
      await gh.ctx.session.switchModel({ sessionID: id, model: model as never });
    },
    getModel: async (id) => {
      const info = await gh.ctx.session.get({ sessionID: id });
      const m = info?.model;
      if (!m?.providerID || !m?.id) return null;
      return { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) };
    },
  };

  void (async () => {
    try {
      const r = await escalateChildSession(host, { sessionID, agent, target, timeoutMs: 5000 });
      if (!r) return;
      state.appendCascadeChild(gh.root, {
        sessionID,
        agent,
        model: r.model,
        readback_match: r.readback_match,
        at: new Date().toISOString(),
      });
      if (!r.readback_match) {
        console.warn(`graphhopper: 子セッションのモデル切替を確認できませんでした (${agent} → ${r.model})`);
      }
    } catch {
      // 切替失敗は子セッションの実行を止めない
    } finally {
      inflightChildren.delete(sessionID);
    }
  })();
}

async function onIdle(gh: Gh, sessionID: string): Promise<void> {
  const { ctx, root } = gh;
  if (!sessionID) return;
  let cascadeNote: string | null = null;
  /* MCP経由の complete/clear で残った cascade を先に復元する */
  try {
    const orphanNote = await flushOrphanCascade(gh);
    if (orphanNote) cascadeNote = orphanNote;
  } catch {
    // 復元失敗で idle 処理を止めない
  }
  let active = state.getActive(root);
  if (!active) return;
  if (active.goal.status !== "active") return;
  if (active.state.phase === "done") return;
  if (active.state.session_id !== sessionID) return;

  /* H3: 全文取得→ローカル tail slice。fetch は idle あたり1本。 */
  let idleMsgs: state.SessionMessageLike[] | null = null;
  try {
    if (oversizeSticky) {
      idleMsgs = null;
    } else {
      const all = (await ctx.session.context({ sessionID })) as unknown as V2Msg[];
      idleMsgs = tailLikes(all ?? []);
    }
  } catch {
    // メッセージ取得失敗は検知をスキップ（駆動を止めない）
  }

  {
    const cfg = state.readConfig(root);
    const echoEnabled = cfg.loop_stop_threshold > 0;
    const toolEnabled = cfg.loop_tool_repeat_threshold > 1;
    if (idleMsgs !== null && (echoEnabled || toolEnabled)) {
      const { detected, kind } = state.detectLoopKind(idleMsgs, cfg);
      const loop = state.updateLoopDetection(root, detected, kind);
      if (loop.stopped) {
        if (loop.justStopped) {
          state.stopLoopByPause(root);
          console.warn(
            "graphhopper: infinite loop detected (kind=%s streak=%d). paused goal=%s to stop auto-continuation",
            kind,
            loop.streak,
            active.goal.id,
          );
          try {
            await ctx.session.prompt({
              sessionID,
              text: "[graphhopper] 無限ループ（echo または同一tool callの反復）を検知したため自動継続を停止しました（goal は pause）。以後、同じ応答・同じtool callの繰り返しには応答せず、新しい実際の作業指示を待ってください。",
            });
          } catch {
            // 通知失敗でも停止は成立している
          }
        }
        return;
      }
    }
  }

  let evalNote: string | null = null;

  if (idleMsgs !== null) {
    const marker = state.continuationFingerprint(
      idleMsgs,
      active.state.phase,
      active.state.eval_cmd,
      active.state.last_eval_fingerprint,
    );
    if (active.state.last_continuation_marker !== null && active.state.last_continuation_marker === marker) {
      if (active.goal.id) {
        state.recordEvent(root, { type: "continuation_skipped", goal: active.goal.id, marker });
      }
      return;
    }
  }

  if (active.state.phase === "implementing" && active.state.eval_cmd) {
    const cmd = active.state.eval_cmd;
    const result = await state.runEval($, root, cmd);
    const tail = result.output.split("\n").slice(-20).join("\n");
    state.noteEvalFingerprint(root, `${result.ok}:${state.fnv1a(tail)}`);
    const r = state.recordAttempt(root, result.ok, result.ok ? "" : `eval failed: ${cmd}`);
    if (!result.ok && !r.giveUp) cascadeNote = await syncCascade(gh);
    const wcLines = await state.measureWorkingCopyLines($, root);
    if (wcLines !== null) state.noteDiffLines(root, wcLines);
    if (active.goal.id) {
      state.recordEvent(root, { type: "eval_run", goal: active.goal.id, ok: result.ok, fail_streak: r.fail_streak });
    }
    if (result.ok) {
      // 遷移入力・遷移判定は MCP 側と同一の実装を使う（分岐の食い違いを防ぐ）
      const inp = await state.evalTransitionInput($, root, active.state.router.baseline_rev);
      const t = await state.evalToPolish($, root, { cmd, ...inp });
      evalNote = t.note;
    } else if (r.giveUp) {
      const paused = state.pauseGoal(root);
      if (paused) {
        state.recordEvent(root, { type: "eval_gave_up", goal: paused.goal.id, fail_streak: r.fail_streak });
        console.warn(
          "graphhopper: eval_cmd failed %d times in a row. paused goal=%s to stop auto-continuation",
          r.fail_streak,
          paused.goal.id,
        );
        try {
          await ctx.session.prompt({
            sessionID,
            text: `[graphhopper] eval_cmd が ${r.fail_streak} 回連続失敗したため自動継続を停止しました（goal は pause）。eval を修正してから graphhopper_goal(action: 'resume') で再開してください（fail_streak は resume 時に 0 に戻ります）。\n${cmd}\n${tail}`,
          });
        } catch {
          // 通知失敗でも停止は成立している
        }
      }
      return;
    } else {
      let stuckLine = "";
      if (r.escalate) {
        stuckLine = "escalate: task(subagent_type: 'graphhopper-oracle') に相談せよ。";
      } else {
        const stuck = state.checkStuck(root);
        if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
          const esc = autoEscalateOnStuck(root);
          stuckLine = esc
            ? `stuck: ${stuck.reasons.join(", ")} → light/advised→full自動昇格（designingに巻き戻し）。${ESCALATE_NEXT}`
            : `stuck: ${stuck.reasons.join(", ")} — task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。`;
        }
      }
      evalNote = [`eval_cmd FAILED (fail_streak=${r.fail_streak}): ${cmd}`, tail, stuckLine].filter(Boolean).join("\n");
    }
    active = state.getActive(root);
    if (!active) return;
  }

  await ctx.session.prompt({
    sessionID,
    text: [state.CONTINUATION_MARKER, evalNote, cascadeNote, continuationText(active.goal, active.state)].filter(Boolean).join("\n\n"),
  });
  if (idleMsgs !== null) {
    state.noteContinuation(
      root,
      state.continuationFingerprint(idleMsgs, active.state.phase, active.state.eval_cmd, active.state.last_eval_fingerprint),
    );
  }
}
