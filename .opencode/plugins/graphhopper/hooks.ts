/**
 * graphhopper v2 plugin: hooks (tool.execute.before/after, session context/
 * compaction, event.subscribe 駆動)。
 * v1 src/index.ts の hooks＋event ハンドラ本体を v2 形に移植。
 * H3 対応: context() は全文のみ (limit 無し) のためローカルで tail slice する。
 */
import { $ } from "bun";
import { beginCheckpointReview, flushOrphanCascade, syncCascade } from "./cascade";
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
import { resolveCompactDb, runCompactGate } from "../../../src/compact";
import { goalResumeContext } from "../../../src/gate";
import {
  decideEntry,
  ENTRY_DECIDE_FRESH_MS,
  formatEntryVerdict,
  INTERNAL_PROMPT_METADATA_KEY,
  isInternalPrompt,
  recordEntrySkip,
  shouldRunEntryDecide,
  type EntryVerdict,
} from "../../../src/entry-decide";
import { decisionAvailable } from "../../../src/decision";
import { isFailedEvent, isInterruptedEvent } from "../../../src/events";
import { evaluateGuard, isMidRoundRestart, progressKeyOf, type GuardPauseReason } from "../../../src/loop-guard";
import { checkBuiltinGoal } from "../../../src/goal-conflict";
import { statSync } from "node:fs";
import { readHandoff } from "../../../src/handoff";
import * as state from "../../../src/state";
import { isDesignDocLocked, isDesignGateBlocked } from "../../../src/state";
import { LSPServerManager } from "../../../src/lsp/client";
import { handleGrandchild } from "./workflow";
import { clearAllWaitTimers, clearWaitTimer, setWaitTimer, type Gh } from "./shared";

const SYSTEM_GUIDE = `## graphhopper（designing/implementing/polishループ）の存在

この環境には graphhopper プラグインが常駐している。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら、手を付ける前に graphhopper_goal(action: "start", title: ...) でループを開始せよ。

入口の route 判定（d1）はプラグインが自動実行し、判定結果はこのプロンプトの「graphhopper 入口判定」として渡されることがある（direct・判定不能・内部/子セッション/goal進行中は渡されない）。渡された場合はその判定に従って graphhopper_route_set → graphhopper_goal(start) へ進むこと。判定は参考値であり、明らかに単一ファイルの小修正ならループを作らず直接対応してよい。

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
/** handoff 案内を評価済みのセッション（毎モデル呼び出しの I/O を避ける） */
const handoffChecked = new Set<string>();
/** handoff メモの案内寿命（過ぎたメモは案内しない） */
const HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const seenPonytails = new Set<string>();

/* 入口d1判定: prompt hook で起動し、context hook で注入する。
 * prompt hook は d1 を await しない（判定の待ち時間をメッセージ受付に載せない）。
 * ただし子セッション判定の 1 read だけは admission 経路で待つ（数msのローカル呼び出し）。
 * 判定結果は context hook が待って注入し、消費したら捨てる（1ターン1回）。 */
const entryVerdicts = new Map<string, { at: number; promise: Promise<EntryVerdict | null> }>();

/** 保持する判定の最大件数（context hook に到達しないセッションの取り残し対策。
 * 同時多セッションでも他セッションの pending を捨てないよう余裕を持たせる） */
const ENTRY_VERDICT_MAX_ENTRIES = 128;

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

/* prompt admission イベント（opencode 2.1 の session.hook("prompt")） */
interface PromptEvent {
  sessionID?: string;
  messageID?: string;
  prompt?: { text?: string };
  metadata?: Record<string, unknown>;
}

interface CompactionEvent {
  sessionID?: string;
  messages?: unknown[];
}

/* /goal 競合を記録した goal（1 goal 1回） */
const goalConflictNoted = new Set<string>();

async function notifyPause(gh: Gh, sessionID: string, text: string): Promise<void> {
  try {
    await gh.ctx.session.prompt({
      sessionID,
      text,
      metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
    });
  } catch {
    // 通知失敗でも pause は成立している
  }
}

/** ガードによる pause の通知文 */
export function guardPauseText(
  reason: GuardPauseReason,
  next: { rounds: number; stalls: number },
  cfg: { loop_max_rounds: number; loop_max_stalls: number },
): string {
  const head =
    reason === "rounds"
      ? `自動継続が上限（${cfg.loop_max_rounds} 回）に達した`
      : reason === "stalls"
        ? `進捗の無いターンが ${cfg.loop_max_stalls} 回続いた`
        : reason === "wait"
          ? "background（subagent / shell）の完了を待ち続けた"
          : "継続の途中でプロセスが落ちた";
  return (
    `[graphhopper] ${head}ため自動継続を停止しました（goal は pause）。` +
    `rounds=${next.rounds} stalls=${next.stalls}。` +
    "状況を確認し、続けるなら graphhopper_goal(action: 'resume') で再開してください。"
  );
}

/** 継続可否を判断する材料になる進捗キー */
function currentProgressKey(root: string, goalId: string, s: state.LoopState): string {
  const loaded = state.readTodosStatus(root, goalId);
  const items = loaded.valid ? loaded.store.items : [];
  const todosDone = items.filter((i) => i.status === "completed").length;
  let planSize: number | null = null;
  try {
    planSize = statSync(state.planPath(root, goalId)).size;
  } catch {
    planSize = null;
  }
  return progressKeyOf({
    phase: s.phase,
    todosDone,
    evalFingerprint: s.last_eval_fingerprint,
    diffLines: s.last_diff_lines,
    planSize,
  });
}

export async function registerHooks(gh: Gh): Promise<() => void> {
  const { ctx, root } = gh;

  /* 起動時: 継続を積んだまま落ちた goal を pause する（rounds 予算は維持） */
  try {
    const cfg0 = state.readConfig(root);
    const active0 = state.getActive(root);
    if (
      active0 &&
      active0.goal.status === "active" &&
      isMidRoundRestart(active0.state.guard, state.bootId(), cfg0.loop_restart_pause)
    ) {
      const paused = state.stopLoopByPause(root);
      if (paused) {
        state.noteGuard(root, { pending: false, wait_since: null });
        state.recordEvent(root, {
          type: "guard_pause",
          goal: paused.goal.id,
          reason: "restart",
          rounds: active0.state.guard.rounds,
          stalls: active0.state.guard.stalls,
        });
        console.warn(
          "graphhopper: 継続の途中で落ちた goal を pause しました goal=%s",
          paused.goal.id,
        );
      }
    }
  } catch {
    // 起動時チェックの失敗で plugin を止めない
  }

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

  /* 入口d1判定: prompt admission で起動し、context（モデル呼び出し直前）で注入する。
   * prompt hook は d1 を await しない（メッセージ受付を遅らせない）。結果は context hook が待つ。 */
  await ctx.session.hook("prompt", async (event: unknown) => {
    try {
      const e = event as PromptEvent;
      const sessionID = String(e.sessionID ?? "");
      if (!sessionID) return;
      const text = String(e.prompt?.text ?? "");
      const active = state.getActive(root);
      const decision = shouldRunEntryDecide({
        text,
        isInternal: isInternalPrompt(e.metadata, text),
        /* 子セッション（subagent）は parentID で判定する。session.created イベントに
         * 依存すると prompt admission が先に走った場合に漏れる（design 判断2-2） */
        isChildSession: await isChildSession(ctx, sessionID),
        /* paused の goal も対象。loop 進行中（active/paused）は入口判定の対象外 */
        hasActiveGoal: !!active && active.goal.status !== "done",
        hasApiKey: decisionAvailable(),
      });
      if (!decision.run) {
        void recordEntrySkip(root, decision.reason, text, sessionID).catch(() => {});
        return;
      }
      /* 前回の判定は捨てる（1セッション1件だけ保持） */
      if (entryVerdicts.size >= ENTRY_VERDICT_MAX_ENTRIES) {
        /* 最も古い entry を1件捨てる（context hook に到達しないセッションの取り残し対策） */
        const oldest = [...entryVerdicts.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) entryVerdicts.delete(oldest[0]);
      }
      entryVerdicts.set(sessionID, {
        at: Date.now(),
        promise: decideEntry(text, fetch, {
          root,
          sessionID,
          messageID: e.messageID ?? null,
        }).catch((err) => {
          console.warn(`graphhopper: 入口判定に失敗: ${String(err)}`);
          return null;
        }),
      });
    } catch {
      // 判定の失敗でユーザー入力を止めない
    }
  });

  /* system 注入: guide＋phase指示＋ponytail＋入口判定 (v1 と同型の節約つき) */
  await ctx.session.hook("context", async (event: unknown) => {
    const e = event as ContextEvent;
    const push = (t: string) => e.system?.push({ type: "text", text: t });
    const active = state.getActive(root);
    push(active?.goal.status === "active" ? SYSTEM_GUIDE_IDLE : SYSTEM_GUIDE);
    /* 入口判定の注入（1ターン1回。消費したら捨てる） */
    const sessionID = String(e.sessionID ?? "");
    const pending = sessionID ? entryVerdicts.get(sessionID) : undefined;
    if (pending) {
      entryVerdicts.delete(sessionID);
      /* 保持した判定が古すぎる（失敗したターンの取り残し）なら注入しない */
      if (Date.now() - pending.at <= ENTRY_DECIDE_FRESH_MS) {
        try {
          const verdict = await pending.promise;
          const text = verdict ? formatEntryVerdict(verdict) : null;
          if (text) push(text);
        } catch {
          // 判定の失敗でモデル呼び出しを止めない
        }
      }
    }
    /* handoff メモの案内（design g-mvq907g4）。pending かつ write 元でない新セッションに1回だけ。
     * 自動 load はしない（bind は人間の意思で）。subagent には出さない。 */
    if (
      sessionID &&
      !handoffChecked.has(sessionID) &&
      !(active && active.state.session_id === sessionID)
    ) {
      try {
        const memo = readHandoff(root);
        /* 別 goal のメモ・完了後のメモ・古すぎるメモは案内しない（load しても error になる） */
        const writtenAt = memo?.meta.written_at ? Date.parse(memo.meta.written_at) : NaN;
        const fresh = Number.isFinite(writtenAt) && Date.now() - writtenAt <= HANDOFF_TTL_MS;
        const relevant =
          memo?.meta.pending &&
          memo.meta.status !== "done" &&
          memo.meta.written_by !== sessionID &&
          fresh &&
          (memo.meta.kind === "session"
            ? !active || active.goal.status === "done"
            : !active || memo.meta.goal_id === active.goal.id);
        if (relevant && !(await isChildSession(ctx, sessionID))) {
          handoffChecked.add(sessionID);
          push(
            [
              "## graphhopper handoff メモ",
              "",
              memo.meta.kind === "session"
                ? ".graphhopper/HANDOFF.md に未読の handoff メモがある（goal なしの作業メモ＋会話の要約）。"
                : `.graphhopper/HANDOFF.md に未読の handoff メモがある（goal: "${memo.meta.goal_title}" ${memo.meta.goal_id} / phase: ${memo.meta.phase}）。`,
              memo.meta.kind === "session"
                ? "続きから作業するなら、まずメモを Read し、必要なら `graphhopper_handoff` (action: \"load\") で内容を確認せよ（goal は再開しない）。"
                : "続きから作業するなら、まずメモを Read し、`graphhopper_handoff` (action: \"load\") を呼んで goal をこのセッションに復元せよ。",
              memo.meta.kind === "session"
                ? "別の作業をするなら無視してよい（メモは書いた時点の参考情報で、正は VCS とファイル）。"
                : "別の作業をするなら無視してよい（メモは state の写像であり、state は変わらない）。",
            ].join("\n"),
          );
        }
      } catch {
        // 案内の失敗でモデル呼び出しを止めない
      }
    }
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
      const ctxText = goalResumeContext(root);
      if (ctxText) {
        push(
          "[graphhopper] active goal の再開文脈（要約で失わず、そのまま残せ）:\n" + ctxText,
        );
      }
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
  /* 自動継続は idle フック内で synthetic を積む（同一 execution で次ステップが走る）。
   * イベント（execution.succeeded）経由より、busy period の分裂・ユーザー入力との競合・
   * ラウンド間クラッシュでの取りこぼしが無い。 */
  await ctx.session.hook("experimental.idle", async (event: unknown) => {
    const e = event as { sessionID?: unknown; background?: unknown };
    try {
      await onIdle(
        gh,
        String(e.sessionID ?? ""),
        Array.isArray(e.background) ? e.background : [],
      );
    } catch (err) {
      console.warn(`graphhopper: idle hook failed: ${String(err)}`);
    }
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const event = raw as {
          type?: string;
          data?: { sessionID?: string; info?: { id?: string }; status?: { type?: string } };
        };
        /* 自動継続は experimental.idle フックが担当する（イベント側では駆動しない）。
         * interrupted / failed は idle フック自体が発火しないため、ここでの除外は不要。 */
        if (isInterruptedEvent(event.type) || isFailedEvent(event.type)) continue;
        try {
          if (event.type === "session.created") {
            const created = event.data as Record<string, unknown> | undefined;
            if (handleGrandchild(gh, created)) continue;
            handleChildSessionCreated(gh, created);
            continue;
          }
          if (event.type === "session.deleted") {
            /* SDK の SessionDeleted は data.sessionID（data.info.id ではない） */
            const id = event.data?.sessionID ?? event.data?.info?.id;
            if (id) {
              /* セッション削除: 復元先が消えたセッションを指している時だけ restore を落とす。
               * 無関係なセッション削除で復元を潰さない。level/children は outcome 記録のため残す
               * （restore が無ければ endCascade は何もしない＝別セッションへ持ち越さない） */
              const active = state.getActive(root);
              const cascade = state.readState(root).cascade;
              if (cascade && active?.state.session_id === id) {
                state.setCascade(root, { ...cascade, restore: null });
              }
              state.unbindSession(root, id);
              entryVerdicts.delete(id);
            }
            try {
              await LSPServerManager.stopAll();
            } catch {
              // 停止失敗は無視（idle timeout 60sが最終防御）
            }
            continue;
          }
          continue;
        } catch {
          // ループを止めないためイベントハンドラ内の例外は握りつぶす
        }
      }
    } catch (e) {
      console.warn(`graphhopper: event subscribe failed: ${String(e)}`);
    }
  })();

  return () => {
    controller.abort();
    clearAllWaitTimers();
  };
}

/** 子セッション（subagent）か。parentID があれば親あり。
 * 取得失敗時は「判定しない」側に倒さない（子でなくても d1 が走るだけなので安全側） */
async function isChildSession(
  ctx: Gh["ctx"],
  sessionID: string,
): Promise<boolean> {
  try {
    /* admission 経路なので応答が詰まるとユーザー入力が止まる。短く切る */
    const info = await ctx.session.get(
      { sessionID },
      { signal: AbortSignal.timeout(1000) },
    );
    return !!info?.parentID;
  } catch {
    return false;
  }
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

async function onIdle(
  gh: Gh,
  sessionID: string,
  background: unknown[] = [],
): Promise<void> {
  const { ctx, root } = gh;
  if (!sessionID) return;
  const boot = state.bootId();
  /* 以前の待ちタイマーを必ず落とす（pause/complete 後も残らないように）。
   * 待っている場合だけ、下で張り直す */
  clearWaitTimer(sessionID);
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
  /* 前回このプロセスが積んだ継続が返ってきたので pending を戻す（bound セッションだけ） */
  {
    const g0 = active.state.guard;
    if (g0.pending && g0.boot === boot) {
      state.noteGuard(root, { pending: false });
      active = state.getActive(root) ?? active;
    }
  }

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
              metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
            });
          } catch {
            // 通知失敗でも停止は成立している
          }
        }
        return;
      }
    }
  }

  /* implementing 途中の main 確認（1 goal 1回）。dedupe より前に段を進める */
  const checkpoint = active.state.cascade?.checkpoint;
  if (checkpoint === "requested") {
    try {
      if (await beginCheckpointReview(gh, sessionID)) return; // この idle は確認に使う（eval は回さない）
    } catch {
      // 確認の失敗でループを止めない
    }
    active = state.getActive(root) ?? active;
  } else if (checkpoint === "reviewing") {
    state.setCascadeCheckpoint(root, "done", "途中確認を終了");
    try {
      const back = await syncCascade(gh);
      if (back) cascadeNote = cascadeNote ? `${cascadeNote}\n${back}` : back;
    } catch {
      // 復帰失敗は次の sync で再試行される
    }
    active = state.getActive(root) ?? active;
  }

  const cfg = state.readConfig(root);

  /* background（subagent / shell）が動いている間は継続しない。
   * 完了すると idle が再発火するので、待つだけでよい。
   * ただし完了通知が来ないまま固まる場合に備えて上限時間で pause する。 */
  const waiting = background.some((b) => {
    const kind = (b as { kind?: unknown } | null)?.kind;
    return kind === "subagent" || kind === "shell";
  });
  if (waiting) {
    const d = evaluateGuard({
      guard: state.readState(root).guard,
      config: cfg,
      now: Date.now(),
      progressKey: state.readState(root).guard.progress_key ?? "",
      waiting: true,
      boot,
    });
    state.noteGuard(root, d.next);
    if (d.action === "pause") {
      const paused = state.stopLoopByPause(root);
      if (paused) {
        state.recordEvent(root, {
          type: "guard_pause",
          goal: paused.goal.id,
          reason: "wait",
          rounds: d.next.rounds,
          stalls: d.next.stalls,
        });
        await notifyPause(gh, sessionID, guardPauseText("wait", d.next, cfg));
      }
      return;
    }
    /* 待ち上限のタイマー（idle が来なくても止める） */
    clearWaitTimer(sessionID);
    const timer = setTimeout(() => {
      clearWaitTimer(sessionID);
      void (async () => {
        const a = state.getActive(root);
        if (!a || a.goal.status !== "active" || a.state.session_id !== sessionID) return;
        /* 待ちが解けているなら pause しない（再開後の誤発火を防ぐ） */
        if (!state.readState(root).guard.wait_since) return;
        const paused = state.stopLoopByPause(root);
        if (!paused) return;
        const g = state.readState(root).guard;
        state.noteGuard(root, { wait_since: null });
        state.recordEvent(root, {
          type: "guard_pause",
          goal: paused.goal.id,
          reason: "wait",
          rounds: g.rounds,
          stalls: g.stalls,
        });
        await notifyPause(gh, sessionID, guardPauseText("wait", g, cfg));
      })();
    }, Math.max(1_000, cfg.loop_wait_limit_ms));
    timer.unref?.();
    setWaitTimer(sessionID, timer);
    return;
  }
  /* 組み込み /goal が active なら継続しない（二重ループ防止）。fail-open。 */
  try {
    const rpcClient = ctx.rpc as unknown as {
      call: (input: unknown, options?: unknown) => Promise<{ output?: unknown }>;
    };
    const rpc = (input: unknown) => {
      const signal = (input as { signal?: AbortSignal } | null)?.signal;
      return rpcClient.call(input, { signal });
    };
    const builtin = await checkBuiltinGoal(rpc as never, sessionID);
    const a = state.getActive(root);
    if (builtin.active) {
      if (a?.goal.id && !goalConflictNoted.has(a.goal.id)) {
        goalConflictNoted.add(a.goal.id);
        state.recordEvent(root, { type: "goal_conflict", goal: a.goal.id, reason: builtin.reason });
      }
      return;
    }
    /* 検知できなかった理由を1 goal 1回だけ残す（fail-open の見える化。noise を避けて shape のみ） */
    if (builtin.reason === "shape" && a?.goal.id && !goalConflictNoted.has(`${a.goal.id}:check`)) {
      goalConflictNoted.add(`${a.goal.id}:check`);
      state.recordEvent(root, { type: "goal_conflict", goal: a.goal.id, reason: `check_failed:${builtin.reason}` });
    }
  } catch {
    // 検知失敗でループを止めない
  }

  let evalNote: string | null = null;

  if (idleMsgs !== null) {
    const marker = state.continuationFingerprint(
      idleMsgs,
      active.state.phase,
      active.state.eval_cmd,
      active.state.last_eval_fingerprint,
    ) + `|r${active.state.guard.rounds}`;
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
            metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
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

  /* 上限ガード: ラウンド数・進捗なし回数で止める */
  const progressKey = currentProgressKey(root, active.goal.id, active.state);
  const decision = evaluateGuard({
    guard: active.state.guard,
    config: cfg,
    now: Date.now(),
    progressKey,
    waiting: false,
    boot,
  });
  if (decision.action === "pause") {
    const paused = state.stopLoopByPause(root);
    if (paused) {
      state.noteGuard(root, decision.next);
      state.recordEvent(root, {
        type: "guard_pause",
        goal: paused.goal.id,
        reason: decision.reason,
        rounds: decision.next.rounds,
        stalls: decision.next.stalls,
      });
      await notifyPause(gh, sessionID, guardPauseText(decision.reason, decision.next, cfg));
    }
    return;
  }
  state.noteGuard(root, decision.next);

  await ctx.session.synthetic({
    sessionID,
    text: [state.CONTINUATION_MARKER, evalNote, cascadeNote, continuationText(active.goal, active.state)].filter(Boolean).join("\n\n"),
  } as never);
  if (idleMsgs !== null) {
    state.noteContinuation(
      root,
      state.continuationFingerprint(idleMsgs, active.state.phase, active.state.eval_cmd, active.state.last_eval_fingerprint) +
        `|r${state.readState(root).guard.rounds}`,
    );
  }
}
