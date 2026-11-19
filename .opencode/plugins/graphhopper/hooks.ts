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
  checkCascadeTarget,
  escalateChildSession,
  parseCascadeModel,
  resolveChildModel,
  shouldSwitchChild,
} from "../../../src/cascade";
import {
  continuationText,
  designDocLockedRefusal,
  designGateRefusal,
  isGateTargetTool,
  ORACLE_ASK,
  isIntentLogPath,
  phaseGuideText,
} from "../../../src/gate";
import { INTENT_MAX_FETCH_CHARS } from "../../../src/intent";
import { describeModelDenial } from "../../../src/model-policy";
import { resolveCompactDb, runCompactGate } from "../../../src/compact";
import { goalResumeContext } from "../../../src/gate";
import {
  decideEntry,
  formatEntryVerdict,
  INTERNAL_PROMPT_METADATA_KEY,
  isInternalPrompt,
  recordEntrySkip,
  shouldRunEntryDecide,
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
import { clearAllWaitTimers, clearWaitTimer, setWaitTimer, type Gh } from "./shared";

/** system に入れる唯一の文。goal の有無・phase で変えない（変えるとキャッシュが切れる。
 * design g-mwj6481n 判断3）。変わる案内はすべて会話の中のメッセージとして届く。 */
const SYSTEM_GUIDE = `## graphhopper（常駐）

この環境には graphhopper プラグインが常駐している。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら、手を付ける前に graphhopper_goal(action: "start", title: ...) でループを開始する。単一ファイルの小修正・質問への回答・一回きりのコマンド実行程度なら、ループを作らず直接対応してよい。

入口の route 判定（d1）はプラグインが自動実行し、結果は会話の中に「## graphhopper 入口判定」で始まるメッセージとして届くことがある（direct・判定不能・内部/子セッション/goal進行中は届かない）。届いたらその判定に従って graphhopper_goal(start) へ進む。判定は参考値で、明らかに単一ファイルの小修正なら直接対応してよい。

designing フェーズでは source ファイルの edit/write は物理的にブロックされる（書けるのは .graphhopper/plans/ 配下の design ドキュメントだけ）。まずユーザーに質問して合意を取り（答えが出るまで自動継続は止まる）、決定記録（決めたこと／やらないこと／完了の確かめ方）を書いてから implementing に遷移して実装する。

案内はこの文ではなく会話の中に届く:
- \`<context key="graphhopper-phase">\`: 進行中 goal の phase と次のアクション。新しい値が前の値を置き換える（古い値は無効）。
- 「## graphhopper 入口判定」「## graphhopper handoff メモ」で始まるメッセージ: プラグインからの通知。

active な goal があるときは、その案内に従う。goal の外の小用件は直接対応してよい。`;

/* idle 取得の窓と上限 (H3: v2 は全文取得のみ。窓切りはローカルで行う)。
 * TAIL_LIMIT: loop検知窓 + echo用履歴 + margin。SAMPLING 概念は廃止
 * (毎回全文のため sampling/full の区別が無い)。oversizeSticky は維持。 */
const TAIL_LIMIT = 50;
const MAX_FETCH_CHARS = INTENT_MAX_FETCH_CHARS;
let oversizeSticky = false;

/** handoff 案内を評価済みのセッション（毎ターンの I/O を避ける） */
const handoffChecked = new Set<string>();
/** handoff メモの案内寿命（過ぎたメモは案内しない） */
const HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/* prompt hook（メッセージ受付）で使う時間の上限。提出した入力が受け付けられるまでの
 * 遅れの上限はこの 1 つだけ（子セッション判定・d1 待ち・phase案内の同期を直列に積まない。
 * design g-mwj6481n 判断5・8）。 */
const PROMPT_HOOK_BUDGET_MS = 1500;

/* phase案内の同期（instructions.entry）。値はセッションごとに「最後に put した値」を持つ。
 * プロセスで初めて見るセッションは list で実値を 1 回読む（再起動後の取りこぼし対策）。 */
const PHASE_GUIDE_KEY = "graphhopper-phase";
const guideKnown = new Map<string, string | null>();
/** 同じセッションの同期を直列にする（古い値が後から上書きするのを防ぐ） */
const guideQueue = new Map<string, Promise<boolean>>();
/** 失敗の警告はセッションごとに 1 回 */
const guideWarned = new Set<string>();

/** phase 案内を instructions.entry に同期する（design g-mwj6481n 判断4・8）。
 *
 * - 値が変わったときだけ put / remove する（同じ値の再送はメッセージを増やさないが、
 *   RPC を減らす）。目標値は phaseGuideText（active・bind 済み・done 以外だけ非 null）。
 * - 同じセッションの同期は直列にする。
 * - 失敗してもループは止めない。警告はセッションごとに 1 回、history に記録する。
 *   呼び出し側（idle）は false を受けたら継続メッセージに全文を付ける。 */
async function syncPhaseGuide(gh: Gh, sessionID: string): Promise<boolean> {
  if (!sessionID) return true;
  const entry = gh.ctx.session.instructions?.entry;
  if (!entry) return false;
  const flush = async (): Promise<boolean> => {
    const want = phaseGuideText(state.getActive(gh.root), sessionID);
    try {
      let known = guideKnown.get(sessionID);
      if (known === undefined) {
        const rows = await entry.list(
          { sessionID },
          { signal: AbortSignal.timeout(1000) },
        );
        const row = rows.find((r) => r.key === PHASE_GUIDE_KEY);
        known = row ? String(row.value) : null;
      }
      if (known === want) {
        guideKnown.set(sessionID, want);
        return true;
      }
      if (want === null) await entry.remove({ sessionID, key: PHASE_GUIDE_KEY });
      else await entry.put({ sessionID, key: PHASE_GUIDE_KEY, value: want });
      guideKnown.set(sessionID, want);
      return true;
    } catch (err) {
      /* 警告も記録もセッションごとに 1 回（失敗し続ける環境で history を溢れさせない） */
      if (!guideWarned.has(sessionID)) {
        guideWarned.add(sessionID);
        console.warn(
          `graphhopper: phase案内の同期に失敗（tool応答と継続メッセージで代替）: ${String(err)}`,
        );
        state.recordEvent(gh.root, {
          type: "phase_guide_sync",
          sessionID,
          ok: false,
          error: String(err),
        });
      }
      return false;
    }
  };
  const prev = guideQueue.get(sessionID) ?? Promise.resolve(true);
  const next = prev.catch(() => false).then(flush);
  guideQueue.set(sessionID, next);
  try {
    return await next;
  } finally {
    if (guideQueue.get(sessionID) === next) guideQueue.delete(sessionID);
  }
}

/** このセッションの同期状態を忘れる（セッション削除・goal完了時） */
function forgetPhaseGuide(sessionID: string): void {
  guideKnown.delete(sessionID);
  guideQueue.delete(sessionID);
  guideWarned.delete(sessionID);
  handoffChecked.delete(sessionID);
}

/** 期限つき await。期限を過ぎたら null を返す（相手の Promise は走り続ける） */
async function withinBudget<T>(p: Promise<T>, deadline: number): Promise<T | null> {
  const ms = deadline - Date.now();
  if (ms <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

export function tailLikes(all: V2Msg[]): state.SessionMessageLike[] | null {
  const size = JSON.stringify(all).length;
  if (size > MAX_FETCH_CHARS) {
    oversizeSticky = true;
    return null;
  }
  oversizeSticky = false;
  const ordered = [...all].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  /* instructions.entry の通知（system 型）は plugin 自身の案内なので、echo 検知・
   * 継続の指紋の入力にしない（design g-mwj6481n 判断6）。synthetic（自動継続）は残す。 */
  return ordered
    .filter((m) => m.type !== "system")
    .slice(-TAIL_LIMIT)
    .map(toLike);
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
    // 意図ログは goal 開始時の一次情報なので、全 phase で書き換えを拒否する（design g-mwebh9vl）
    if (isIntentLogPath(filePath)) {
      state.recordEvent(root, {
        type: "design_gate_block",
        goal: active.goal.id,
        tool: toolName,
        path: filePath,
      });
      throw new Error(
        `Refused: ${e.tool} to ${filePath} is blocked because the intent log is an immutable record of the conversation at goal start.`,
      );
    }
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

  /* graphhopper の tool が状態を変えた直後に phase案内を同期する（design g-mwj6481n 判断4）。
   * goal start / phase / resume / complete / escalate / handoff load を 1 か所で拾う。
   * await するので、案内は tool 結果の直後（同じターン）に届く。Code Mode の execute の
   * 中で呼ばれた tool でも、その tool 名で発火する。値が変わらなければ RPC は走らない。 */
  await ctx.tool.hook("execute.after", async (event: unknown) => {
    try {
      const e = event as AfterEvent;
      if (!e.sessionID || !String(e.tool ?? "").startsWith("graphhopper_")) return;
      /* 応答しない RPC で tool の結果を止めない（期限を過ぎたら同期は裏で続く） */
      await withinBudget(
        syncPhaseGuide(gh, String(e.sessionID)),
        Date.now() + PROMPT_HOOK_BUDGET_MS,
      );
    } catch {
      // 同期の失敗で tool の結果を壊さない
    }
  });

  /* メッセージ受付: phase案内の同期・入口判定・handoff 案内をここでまとめる
   * （design g-mwj6481n 判断3・5）。受付の遅れの上限は PROMPT_HOOK_BUDGET_MS の 1 つだけで、
   * 子セッション判定・d1 待ち・phase案内の同期を直列に積まない。
   * system は変えず、案内は synthetic（履歴に残り、同じ呼び出しに入る）で積む。 */
  await ctx.session.hook("prompt", async (event: unknown) => {
    try {
      const e = event as PromptEvent;
      const sessionID = String(e.sessionID ?? "");
      if (!sessionID) return;
      const text = String(e.prompt?.text ?? "");
      const deadline = Date.now() + PROMPT_HOOK_BUDGET_MS;
      const active = state.getActive(root);

      /* phase案内の同期は d1 と並列に走らせる（再起動後・別セッションでの状態変化を回収） */
      const guideSync = syncPhaseGuide(gh, sessionID);

      /* 子セッション（subagent）は parentID で判定する。session.created イベントに
       * 依存すると prompt admission が先に走った場合に漏れる（design g-mvj7ddcz 判断2-2）。
       * 時間切れは null（不明）で、判定も handoff 案内もしない（design g-mwkfisl7 判断2） */
      const child = await withinBudget(isChildSession(ctx, sessionID), deadline);
      const decision = shouldRunEntryDecide({
        text,
        isInternal: isInternalPrompt(e.metadata, text),
        isChildSession: child,
        /* paused の goal も対象。loop 進行中（active/paused）は入口判定の対象外 */
        hasActiveGoal: !!active && active.goal.status !== "done",
        hasApiKey: decisionAvailable(),
      });
      /* d1 は先に起動だけして、handoff 案内の後で結果を待つ（待ち時間を重ねない） */
      const startedAt = Date.now();
      let errored = false;
      const verdictPromise = decision.run
        ? decideEntry(text, fetch, {
            root,
            sessionID,
            messageID: e.messageID ?? null,
          }).catch((err) => {
            errored = true;
            console.warn(`graphhopper: 入口判定に失敗: ${String(err)}`);
            return null;
          })
        : null;
      if (!decision.run) {
        void recordEntrySkip(root, decision.reason, text, sessionID).catch(() => {});
      }

      /* handoff メモの案内（design g-mvq907g4）。pending かつ write 元でない新セッションに1回だけ。
       * 自動 load はしない（bind は人間の意思で）。subagent には出さない。
       * 入口判定を回さない入力（goal 進行中・キー無し・内部）でも出す（条件は移設前と同じ）。 */
      if (
        !handoffChecked.has(sessionID) &&
        !(active && active.state.session_id === sessionID) &&
        child === false
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
          if (relevant) {
            handoffChecked.add(sessionID);
            await withinBudget(ctx.session.synthetic({
              sessionID,
              text: [
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
              description: "graphhopper handoff メモ",
              resume: false,
            } as never), deadline);
          }
        } catch {
          // 案内の失敗でユーザー入力を止めない
        }
      }

      /* d1 の結果を待って synthetic で積む。間に合わなければ積まない
       * （d1 は裏で走り続け、decisions.jsonl には残る） */
      if (verdictPromise) {
        const verdict = await withinBudget(verdictPromise, deadline);
        const waitedMs = Date.now() - startedAt;
        const inject = verdict ? formatEntryVerdict(verdict) : null;
        if (inject) {
          await withinBudget(
            ctx.session.synthetic({
              sessionID,
              text: inject,
              description: "graphhopper 入口判定",
              resume: false,
            } as never),
            deadline,
          );
        }
        state.recordEvent(root, {
          type: "entry_verdict_delivery",
          sessionID,
          outcome: inject ? "injected" : errored ? "error" : verdict ? "skipped" : "late",
          waited_ms: waitedMs,
          route: verdict?.rawRoute ?? null,
        });
      }

      await withinBudget(guideSync, deadline);
    } catch {
      // 判定・案内の失敗でユーザー入力を止めない
    }
  });

  /* system 注入は固定文 1 つだけ（design g-mwj6481n 判断3）。goal の有無・phase で変えない。
   * 変わる案内は instructions.entry（phase案内）・synthetic・tool 応答で会話に届く。 */
  await ctx.session.hook("context", async (event: unknown) => {
    const e = event as ContextEvent;
    e.system?.push({ type: "text", text: SYSTEM_GUIDE });
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
              forgetPhaseGuide(id);
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
 * 取得失敗・時間切れは null（不明）を返す。不明は「判定しない」側に倒す
 * （design g-mwkfisl7 判断2。subagent の内部 prompt を decisions.jsonl に混ぜない）。
 * 不明は判定しないので、待つ意味は薄い。400ms で打ち切る（design g-mwkgfssi 判断4） */
const CHILD_SESSION_LOOKUP_TIMEOUT_MS = 400;

async function isChildSession(
  ctx: Gh["ctx"],
  sessionID: string,
): Promise<boolean | null> {
  try {
    /* admission 経路なので応答が詰まるとユーザー入力が止まる。短く切る */
    const info = await ctx.session.get(
      { sessionID },
      { signal: AbortSignal.timeout(CHILD_SESSION_LOOKUP_TIMEOUT_MS) },
    );
    return !!info?.parentID;
  } catch {
    return null;
  }
}

/** 切替処理中の子セッション（同一 sessionID の二重切替を防ぐ） */
const inflightChildren = new Set<string>();

/** ポリシーで拒否した子セッション（警告の繰り返しを防ぐ） */
const deniedChildren = new Set<string>();

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

  // 切替先がポリシーで拒否されるなら切り替えない（design g-mw8xvsg8 判断4）。
  // 実際に切替対象になった子だけを見る（shouldSwitchChild の後）。
  // 拒否した sessionID は in-memory で記録し、毎イベントの警告を防ぐ
  const denial = checkCascadeTarget(parseCascadeModel(target), {
    allow: config.model_allow,
    deny: config.model_deny,
  });
  if (denial) {
    if (!deniedChildren.has(sessionID)) {
      deniedChildren.add(sessionID);
      console.warn(
        `graphhopper: 子セッション ${agent} の切替先 ${denial.model} は ${describeModelDenial(denial)} のため切り替えない`,
      );
    }
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
  try {
    await onIdleBody(gh, sessionID, background);
  } finally {
    /* 同期の成否はここでは使わない（継続メッセージへのフォールバックは本体が判断する）。
     * 値が変わらなければ RPC は走らない */
    if (sessionID) void syncPhaseGuide(gh, sessionID);
  }
}

/**
 * idle の本体。phase案内の同期は wrapper（onIdle）の finally が 1 回だけ行う。
 * 早期 return（pause・停止・完了）でも「状態を変えた後の案内」が届くようにするため、
 * 各 return に同期を書かない（design g-mwj6481n 判断4）。
 */
async function onIdleBody(
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
  /* goal 終了・clear の途中で落ちて残った cascade を先に復元する（孤児の保険） */
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
  /* designing は質問して答えを待つ段階。自動継続・eval・待ちタイマーは動かさない（design g-mwmykjt4） */
  if (active.state.phase === "designing") return;
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
      if (await beginCheckpointReview(gh, sessionID)) {
        return; // この idle は確認に使う（eval は回さない）
      }
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
      // 遷移入力・遷移判定は tool 側と同一の実装を使う（分岐の食い違いを防ぐ）
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
        stuckLine = `escalate: ${ORACLE_ASK}`;
      } else {
        const stuck = state.checkStuck(root);
        if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
          stuckLine = `stuck: ${stuck.reasons.join(", ")} — ${ORACLE_ASK}`;
        }
      }
      evalNote = [`eval_cmd FAILED (fail_streak=${r.fail_streak}): ${cmd}`, tail, stuckLine].filter(Boolean).join("\n");
    }
    active = state.getActive(root);
    if (!active) {
      forgetPhaseGuide(sessionID);
      return;
    }
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

  /* 継続メッセージを積む直前に同期する（phase 遷移・昇格・eval通過を反映）。
   * 同期に失敗したときだけ全文を継続に付ける（design g-mwj6481n 判断7）。 */
  const guideOk = await syncPhaseGuide(gh, sessionID);
  const guideFallback = guideOk ? null : phaseGuideText(state.getActive(root), sessionID);
  await ctx.session.synthetic({
    sessionID,
    text: [state.CONTINUATION_MARKER, evalNote, cascadeNote, guideFallback, continuationText(active.goal, active.state)]
      .filter(Boolean)
      .join("\n\n"),
  } as never);
  if (idleMsgs !== null) {
    state.noteContinuation(
      root,
      state.continuationFingerprint(idleMsgs, active.state.phase, active.state.eval_cmd, active.state.last_eval_fingerprint) +
        `|r${state.readState(root).guard.rounds}`,
    );
  }
}
