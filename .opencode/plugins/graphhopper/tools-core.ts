/**
 * graphhopper v2 plugin: core loop tools (goal/status/phase/route/decide/
 * route_set/selector/escalate/set_eval/attempt)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形 (JSON Schema＋{content}) に移植。
 */
import { $ } from "bun";
import {
  autoEscalateOnStuck,
  checkPhaseMove,
  effectivePhaseAction,
  ESCALATE_NEXT,
  EVAL_MANAGED_NOTE,
  parseEntryRoute,
} from "../../../src/gate";
import {
  decideRoute,
  formatDecisionNextStep,
  formatDecisionSummary,
  formatSelectorResult,
  SELECTOR_TOOL_DESCRIPTION,
  selectLenses,
} from "../../../src/decision";
import { finishCascade, maybeRequestCheckpoint, syncCascade } from "./cascade";
import { ensureEntryDecision } from "../../../src/entry-decide";
import * as state from "../../../src/state";
import { readRun, summarizeRun } from "../../../src/workflow";
import { clearWaitTimer, noteSession, S, text, type Gh } from "./shared";
import { checkBuiltinGoal } from "../../../src/goal-conflict";

type Ctx = { sessionID: string };

function sess(gh: Gh, context: Ctx): string {
  const id = String(context.sessionID ?? "");
  if (id) noteSession(gh.root, id);
  return id;
}

/** 組み込み /goal が active なら開始・再開を拒否する（二重ループ防止・fail-open） */
async function builtinGoalRefusal(
  gh: Gh,
  sessionID: string,
): Promise<string | null> {
  if (!sessionID) return null;
  try {
    const rpcClient = gh.ctx.rpc as unknown as {
      call: (input: unknown, options?: unknown) => Promise<{ output?: unknown }>;
    };
    const r = await checkBuiltinGoal((input) => {
      const signal = (input as { signal?: AbortSignal } | null)?.signal;
      return rpcClient.call(input, { signal });
    }, sessionID);
    if (!r.active) return null;
    return (
      "error: このセッションでは opencode 組み込みの /goal が active です。" +
      "2つのループが同じ idle で競合するため開始できません。" +
      "先に `/goal pause` または `/goal clear` を実行してから再試行してください。"
    );
  } catch {
    return null;
  }
}

export function registerCoreTools(
  editor: { add(tool: Record<string, unknown>): void },
  gh: Gh,
): void {
  const { root } = gh;

  editor.add({
    name: "graphhopper_goal",
    description:
      "graphhopper の goal を管理する。start=新規 goal でループ開始、pause/resume=一時停止/再開、complete=完了（要直近 verifier clean）、clear=状態リセット",
    input: S.obj(
      {
        action: S.enumOf(["start", "pause", "resume", "complete", "clear"]),
        title: S.optStr("action=start のとき必須。goal の題名"),
        force: {
          type: "boolean",
          description:
            "complete 時に verifier 未clearでも強制完了する、または resume 時に loop_stop_max のブロックを明示的に無視する（人間の判断が見える場合のみ。監査ログに loop_resume_forced が記録される）",
        },
      },
      ["action"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { action: string; title?: string; force?: boolean };
      const sessionID = sess(gh, context as Ctx);
      switch (args.action) {
        case "start": {
          if (!args.title) return text("error: title is required for start");
          {
            const conflict = await builtinGoalRefusal(gh, sessionID);
            if (conflict) return text(conflict);
          }
          const active = state.getActive(root);
          if (active && active.goal.status === "active") {
            return text(
              `error: goal "${active.goal.title}" is already active. complete or pause it first.`,
            );
          }
          /* 入口判定の保険: 直近の decide 行が無ければ goal title を入力に判定して記録だけ残す
           * （route は変えない。entry_route は route_set / fail-safe に委ねる。
           *   d1 の待ち時間を goal start に載せないので await しない。記録は best-effort） */
          void ensureEntryDecision(root, sessionID || null, args.title);
          const a = state.startGoal(root, args.title, sessionID);
          try {
            const rev = await state.captureBaselineRev($, root);
            if (rev) {
              state.snapshotInitialDirt(root, await state.measureDiffLines($, root, rev));
              state.snapshotInitialDiffFiles(root, await state.measureChangedFiles($, root, rev));
            }
          } catch {
            // 測定不能は無視（initial null＝旧挙動）
          }
          const started = state.getActive(root) ?? a;
          const cfg = state.readConfig(root);
          const cascadeBase = await syncCascade(gh);
          const cascadeNote =
            cascadeBase && cfg.cascade.enabled
              ? `${cascadeBase}（注: 判定nodeは cascade.agents.quality の子セッションだけ昇格モデルに切替）`
              : cascadeBase;
          const consumed =
            started.state.entry_route !== null && started.state.entry_route !== undefined
              ? `pending entry_route=${started.state.entry_route} を消費`
              : "pending無し→full（未判定・legacy）扱い";
          return text(
            `goal started: "${started.goal.title}" (${started.goal.id})\n${consumed}${started.state.difficulty ? ` / difficulty=${started.state.difficulty}` : ""}\nphase: designing${cascadeNote ? `\n${cascadeNote}` : ""}\n次: ${effectivePhaseAction("designing", started.state.entry_route)}`,
          );
        }
        case "pause": {
          clearWaitTimer(sessionID);
          /* pause 中に main が残らないよう、途中確認は終わらせる */
          const cp = state.getActive(root)?.state.cascade?.checkpoint;
          if (cp && cp !== "done") state.setCascadeCheckpoint(root, "done", "pause");
          const a = state.pauseGoal(root);
          return text(a ? `paused: "${a.goal.title}"` : "no active goal");
        }
        case "resume": {
          {
            const conflict = await builtinGoalRefusal(gh, sessionID);
            if (conflict) return text(conflict);
          }
          if (state.isResumeBlocked(root) && !args.force) {
            const s = state.getActive(root);
            const max = state.readConfig(root).loop_stop_max;
            const count = s?.state.loop_stop_count ?? 0;
            return text(
              `error: このgoalはループ検知による自動停止が loop_stop_max（${max}）回に達したため resume がブロックされています（現在 ${count}回）。` +
                "人間が原因を確認して graphhopper_goal(action: 'clear') でリセットするか、明示的に resume を続行する場合のみ force: true を使ってください（監査ログに loop_resume_forced が記録されます）。",
            );
          }
          const a = state.resumeGoal(root, sessionID, args.force);
          const cascadeNote = a ? await syncCascade(gh) : null;
          return text(
            a
              ? `resumed: "${a.goal.title}" | phase: ${a.state.phase}${args.force ? " (forced)" : ""}${cascadeNote ? `\n${cascadeNote}` : ""}`
              : "no active goal",
          );
        }
        case "complete": {
          const a = state.getActive(root);
          if (!a) return text("no active goal");
          clearWaitTimer(sessionID);
          if (!args.force && a.state.last_verifier?.level !== "clean") {
            return text(
              "error: complete には直近の graphhopper_verifier_set（集約 clean）が必要です（self-graded 完了は禁止）。" +
                "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。",
            );
          }
          const restored = await finishCascade(gh);
          const done = state.completeGoal(root);
          return text(
            done
              ? `completed: "${done.goal.title}"${args.force ? " (forced)" : ""}${restored ? `\n${restored}` : ""}`
              : "no active goal",
          );
        }
        case "clear": {
          clearWaitTimer(sessionID);
          const restored = await finishCascade(gh);
          state.clearActiveGoal(root);
          state.unbindSession(root, sessionID);
          return text(restored ? `cleared\n${restored}` : "cleared");
        }
        default:
          return text(`error: unknown action "${args.action}"`);
      }
    },
  });

  editor.add({
    name: "graphhopper_status",
    description: "graphhopper の現在状態（goal・フェーズ・router・verifier・critic_review）を表示する",
    input: S.obj({}, []),
    execute: async () => {
      const a = state.getActive(root);
      if (!a) return text("no active goal");
      const v = a.state.last_verifier;
      const lensModels = v ? state.formatLensModels(v.lens, v.models, v.model) : "";
      return text(
        [
          `goal: "${a.goal.title}" (${a.goal.id}) [${a.goal.status}]`,
          `phase: ${a.state.phase}`,
          `session: ${a.state.session_id ?? "unbound"}`,
          `entry_route: ${a.state.entry_route ?? "full（未判定・legacy）"}${a.state.escalated_at ? `（${a.state.escalated_at}にlight/advised→full昇格）` : ""}`,
          a.state.router.route
            ? `router: route=${a.state.router.route} diff_lines=${a.state.router.diff_lines} checked_at=${a.state.router.checked_at}${a.state.router.deep ? ` deep (${a.state.router.deep_reason})` : ""}`
            : "router: (not checked)",
          a.state.initial_diff_lines !== null && a.state.initial_diff_lines !== undefined
            ? `initial_dirt: ${a.state.initial_diff_lines} lines（goal start時の未コミット分。実効diffから除外）`
            : null,
          a.state.last_verifier
            ? `last_verifier: level=${a.state.last_verifier.level} target=${a.state.last_verifier.target ?? "-"} lens=${a.state.last_verifier.lens.join(",") || "-"}${lensModels ? ` models=${lensModels}` : ""} reason=${a.state.last_verifier.reason}`
            : "last_verifier: (none)",
          a.state.critic_review
            ? `critic_review: level=${a.state.critic_review.level} reason=${a.state.critic_review.reason}`
            : "critic_review: (none, opt-in)",
          a.state.advisor_consult
            ? `advisor_consult: ${a.state.advisor_consult.summary.slice(0, 100)}`
            : "advisor_consult: (none)",
          a.state.oracle_consult
            ? `oracle_consult: ${a.state.oracle_consult.summary.slice(0, 100)}`
            : "oracle_consult: (none)",
          `fail_streak: ${a.state.fail_streak}`,
          state.todoSummaryLine(root, a.goal.id),
          a.state.cascade
            ? `cascade: level=${a.state.cascade.level} model=${a.state.cascade.model ?? "-"} children=${a.state.cascade.children.length}`
            : "cascade: (none)",
          ...(a.state.cascade?.children.length
            ? a.state.cascade.children
                .slice(-3)
                .map((c) => `  child: ${c.agent} → ${c.model}${c.readback_match ? "" : " (readback不一致)"}`)
            : []),
          ...(summarizeRun(readRun(root, a.goal.id)) ? [summarizeRun(readRun(root, a.goal.id))!] : []),
          `difficulty: ${a.state.difficulty ?? "unknown"}`,
          `loop: stop_count=${a.state.loop_stop_count}/${state.readConfig(root).loop_stop_max} resume_blocked=${state.isResumeBlocked(root)} streak=${a.state.loop_streak}`,
          a.state.notes ? `notes: ${a.state.notes}` : null,
          state.planLogExists(root, a.goal.id) ? `log: .graphhopper/plans/${a.goal.id}.log.md` : null,
          `updated: ${a.state.updated_at}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_phase",
    description: "graphhopper のフェーズを遷移させる。遷移前にそのフェーズの exit 条件を満たしていること",
    input: S.obj(
      {
        phase: S.enumOf([...state.PHASES]),
        notes: S.optStr("中断・再開用メモ（どこまでやったか）"),
      },
      ["phase"],
    ),
    execute: async (input: unknown) => {
      const args = input as { phase: state.Phase; notes?: string };
      const rejected = checkPhaseMove(root, args.phase);
      if (rejected) return text(rejected);
      const mv = state.setPhaseChecked(root, args.phase, args.notes);
      if (!mv.ok) return text(`error: ${mv.error ?? "遷移に失敗"}`);
      const a = mv.active;
      if (!a) return text("error: no active goal or invalid phase");
      const cascadeNote = await syncCascade(gh);
      return text(
        `phase -> ${a.state.phase}${cascadeNote ? `\n${cascadeNote}` : ""}\n次: ${effectivePhaseAction(a.state.phase, a.state.entry_route)}`,
      );
    },
  });

  editor.add({
    name: "graphhopper_todo",
    description:
      "進捗タスクの操作。list=一覧 / start=進行中 / done=完了 / cancel=やらない（reason必須） / add=追加 / reopen=cancelの誤操作から復帰。implementing→polish の遷移は未完了タスクが残ると拒否される",
    input: S.obj(
      {
        action: S.enumOf(["list", "start", "done", "cancel", "add", "reopen"]),
        id: S.optStr("対象タスクのID（list/start/done/cancel で必須。t1, t2, ...）"),
        text: S.optStr("追加するタスクの文（action=add で必須）"),
        reason: S.optStr("理由（action=cancel で必須）"),
      },
      ["action"],
    ),
    execute: async (input: unknown) => {
      const args = input as { action: state.TodoAction; id?: string; text?: string; reason?: string };
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      const r = state.todoAction(root, active.goal.id, args.action, {
        ...(args.id ? { id: args.id } : {}),
        ...(args.text ? { text: args.text } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      const cp = args.action === "done" && r.ok ? maybeRequestCheckpoint(gh) : null;
      return text(cp ? `${r.text}\n${cp}` : r.text);
    },
  });

  editor.add({
    name: "graphhopper_route",
    description: "入口トリアージの入口（判定は通常hookが自動で走らせる。これは手動再判定用）。やる内容を渡すと graphhopper_decide の呼び出し手順を返す（判定本体はdecide tool。LLM agentは使わない）",
    input: S.obj({ request: S.str("これからやる内容のテキスト（decideの判定入力）") }, ["request"]),
    execute: async (input: unknown) => {
      const args = input as { request: string };
      return text(
        [
          "## 入口トリアージ手順（手動再判定）",
          "0. 通常の入口判定はhookが自動実行済み。下の判定は手動での再判定。",
          "1. graphhopper_decide(request) を呼ぶ（d1 decision-modelがroute＋confidenceを返す。stateは書かない）:",
          "",
          args.request,
          "",
          "2. 返却routeを graphhopper_route_set(route, reason) で記録する。",
          "3. full/light/advised/oracleなら graphhopper_goal(start)（pending routeが消費される）。directならloopなしで直接対応する。",
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_decide",
    description: "d1 decision-modelで入口routeを判定する（jev置換。通常の入口判定はhookが自動実行する。これは手動用）。requestを渡すとroute＋confidenceを返す。stateは書かない",
    input: S.obj({ request: S.str("これからやる内容のテキスト") }, ["request"]),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { request: string };
      const r = await decideRoute(args.request, fetch, {
        root,
        /* 手動判定もセッションに紐付ける。goal start の保険が同じ decide 行を
         * 見つけて二重に走らないようにする */
        sessionID: sess(gh, context as Ctx) || null,
      });
      return text(
        [
          ...formatDecisionSummary(r),
          formatDecisionNextStep(r),
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_route_set",
    description:
      "decide判定の記録。不正・空はfullに倒す（fail-safe）。full/light/advised/oracleは次回goal start時に消費されるpendingに置く。directはhistoryに1行残すのみ（goalを作らない）",
    input: S.obj(
      {
        route: S.str("decide返却のroute（full/light/direct/advised/oracle。旧A/B/Cも受理。大文字小文字不問。不正値はfullに倒す）"),
        reason: S.optStr("判定理由の要旨（任意）"),
        difficulty: S.enumOf(["easy", "normal", "hard"], "decide返却のdifficulty（任意。goal start時にカスケード判定へ渡る）"),
      },
      ["route"],
    ),
    execute: async (input: unknown) => {
      const args = input as { route: string; reason?: string; difficulty?: string };
      const parsed = parseEntryRoute(args.route);
      const difficulty =
        args.difficulty === "easy" || args.difficulty === "normal" || args.difficulty === "hard"
          ? args.difficulty
          : null;
      const reason = args.reason ?? parsed.reason;
      if (parsed.route === "direct") {
        const active = state.getActive(root);
        state.recordEvent(root, {
          type: "entry_route",
          ...(active?.goal.id ? { goal: active.goal.id } : {}),
          route: "direct",
          reason,
        });
        return text("entry_route=direct を記録（historyのみ）。loopなしで直接対応せよ。goalは作らない。");
      }
      state.writePendingRoute(root, parsed.route, reason, difficulty);
      const bound = state.bindEntryRoute(root, parsed.route, reason, difficulty);
      if (bound) state.clearPendingRoute(root);
      return text(
        [
          `pending entry_route=${parsed.route} を記録（${reason}）。`,
          bound
            ? `active goal（${bound.goal.id}）にもbindした（pendingは消去）。`
            : "次: graphhopper_goal(start) で消費される。",
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_selector",
    description: SELECTOR_TOOL_DESCRIPTION,
    input: S.obj(
      {
        design_excerpt: S.str("design.mdの抜粋（goal理解＋受け入れ条件）"),
        diff_stat: S.str("diff統計（ファイル数・行数・対象領域）"),
      },
      ["design_excerpt", "diff_stat"],
    ),
    execute: async (input: unknown) => {
      const args = input as { design_excerpt: string; diff_stat: string };
      return text(
        formatSelectorResult(await selectLenses(args.design_excerpt, args.diff_stat, fetch, { root })),
      );
    },
  });

  editor.add({
    name: "graphhopper_escalate",
    description:
      "light/advised→full昇格（ラチェット）。entry_route=light/advisedのときのみ有効。phaseをdesigningに戻しdesign肉付け＋critic1回＋verifier fan-outに格上げする。full→light・未設定・direct/oracleは拒否",
    input: S.obj({}, []),
    execute: async () => {
      const from = state.getActive(root)?.state.entry_route;
      const r = state.escalateEntryRoute(root);
      if (!r)
        return text(
          "error: 昇格不可（active goalなし、または entry_route=light/advised ではない）。full→light引き下げ・direct/oracle・未設定からの昇格は禁止",
        );
      return text([`escalated: ${from} -> full（designingに巻き戻し）。`, ESCALATE_NEXT].join("\n"));
    },
  });

  editor.add({
    name: "graphhopper_set_eval",
    description:
      "implementingの合否を機械判定するコマンド（テスト/lint/typecheck等）を設定する。設定後はturn終了（idle）ごとに自動実行され、pass=polishへ自動遷移・fail=fail_streak機械カウントになる。graphhopper_attemptの自己申告より優先される",
    input: S.obj(
      { cmd: S.str("実行するシェルコマンド（例: 'npx tsc --noEmit && npm test'）。空文字で解除") },
      ["cmd"],
    ),
    execute: async (input: unknown) => {
      const args = input as { cmd: string };
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      state.setEvalCmd(root, args.cmd);
      return text(
        args.cmd
          ? `eval_cmd set: ${args.cmd}\n次のターン終了時から自動実行される。`
          : "eval_cmd cleared. graphhopper_attemptの自己申告にフォールバックする。",
      );
    },
  });

  editor.add({
    name: "graphhopper_attempt",
    description:
      "implementingでの実装試行の成否を記録する（graphhopper_set_evalでeval_cmdを設定していない場合の自己申告フォールバック。eval_cmd設定済みなら自動実行されるのでこのツールは不要）。連続失敗がstuck_threshold（既定3）に達したら escalate=true を返し、graphhopper-oracleへの相談を促す。okな試行やphase遷移でfail_streakはリセットされる",
    input: S.obj(
      {
        ok: { type: "boolean", description: "この試行は成功したか（テストが通った・目的の変更が完了した等）" },
        note: S.str("何を試して何が起きたか（失敗時はoracleに渡る文脈になる）"),
      },
      ["ok", "note"],
    ),
    execute: async (input: unknown) => {
      const args = input as { ok: boolean; note: string };
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      const r = state.recordAttempt(root, args.ok, args.note);
      const managed = !args.ok && active.state.eval_cmd ? `\n${EVAL_MANAGED_NOTE}` : "";
      const attemptCascade = !args.ok ? await syncCascade(gh) : null;
      const cascadeNote =
        attemptCascade && state.readConfig(root).cascade.enabled
          ? `${attemptCascade}（注: 判定nodeの子セッションは quality マップで昇格モデルに切替）`
          : attemptCascade;
      if (args.ok) return text("attempt recorded: ok (fail_streak reset to 0)");
      if (r.giveUp) {
        const paused = state.pauseGoal(root);
        if (paused) {
          state.recordEvent(root, { type: "eval_gave_up", goal: paused.goal.id, fail_streak: r.fail_streak });
        }
        return text(
          [
            `attempt recorded: fail (fail_streak=${r.fail_streak})`,
            `giveUp: true — 連続失敗が上限に達したため goal を pause した。修正して graphhopper_goal(action: 'resume') で再開せよ（fail_streak は 0 に戻る）。`,
            managed,
            cascadeNote,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      if (r.escalate) {
        return text(
          [
            `attempt recorded: fail (fail_streak=${r.fail_streak})`,
            "escalate: true",
            "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行（何を試して何が起きたか）を渡すこと。",
            managed,
            cascadeNote,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const stuck = state.checkStuck(root);
      if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
        const esc = autoEscalateOnStuck(root);
        if (esc) {
          return text(
            [
              `attempt recorded: fail (fail_streak=${r.fail_streak})`,
              `stuck: ${stuck.reasons.join(", ")} → light/advised→full自動昇格（designingに巻き戻し）。`,
              ESCALATE_NEXT,
              managed,
              cascadeNote,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        return text(
          [
            `attempt recorded: fail (fail_streak=${r.fail_streak})`,
            `escalate: true (stuck: ${stuck.reasons.join(", ")})`,
            "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。",
            managed,
            cascadeNote,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      return text(`attempt recorded: fail (fail_streak=${r.fail_streak})\nescalate: false${managed}`);
    },
  });
}
