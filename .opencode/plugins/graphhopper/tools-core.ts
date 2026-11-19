/**
 * graphhopper v2 plugin: core loop tools (goal/status/phase/decide/
 * set_eval/attempt)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形 (JSON Schema＋{content}) に移植。
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  checkPhaseMove,
  PHASE_ACTION,
  EVAL_MANAGED_NOTE,
  formatUsabilityLine,
  ORACLE_ASK,
  policyDocsChanged,
  usabilityGateRefusal,
} from "../../../src/gate";
import {
  DIFFICULTY_CONFIDENCE_FLOOR,
  decideDifficulty,
  decideRoute,
  formatDecisionNextStep,
  formatDecisionSummary,
} from "../../../src/decision";
import { finishCascade, maybeRequestCheckpoint, syncCascade } from "./cascade";
import { judgeGoalDifficulty } from "../../../src/entry-decide";
import { appendDesigningTurns, formatIntentLine, renderIntent } from "../../../src/intent";
import { catalogPolicyWarning } from "../../../src/bake";
import * as state from "../../../src/state";
import { clearWaitTimer, noteSession, S, text, type Gh } from "./shared";
import { checkBuiltinGoal } from "../../../src/goal-conflict";
import { recordSection } from "../../../src/record";
import { rubricStatus, snapshotRubric } from "../../../src/verify";

type Ctx = { sessionID: string };

const DIFFICULTY_RANK: Record<state.Difficulty, number> = { easy: 0, normal: 1, hard: 2 };

/**
 * implementing 遷移の難易度の判定し直し（design g-mwmykjt4 判断6）。
 * 題と決定記録の「決めたこと」を入力に判定し、上がる方向だけ反映する
 * （easy→normal、easy・normal・判定なし→hard。下げない。判定なしは normal 扱いなので normal へは動かさない）。
 * 上限 2 秒。判定できない・上がらないなら何もしない（null を返す）。
 */
async function upgradeDifficultyFromDesign(
  gh: Gh,
  active: state.ActiveLoop,
): Promise<string | null> {
  const root = gh.root;
  const from = active.state.difficulty;
  if (from === "hard") return null;
  let decided: string[] = [];
  try {
    decided = (recordSection(readFileSync(state.planPath(root, active.goal.id), "utf8"), "決めたこと") ?? [])
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  if (decided.length === 0) return null;
  const input = [active.goal.title, "", "決めたこと:", ...decided.map((l) => l.slice(0, 200))]
    .join("\n")
    .slice(0, 3000);
  let r: Awaited<ReturnType<typeof decideDifficulty>>;
  try {
    r = await decideDifficulty(input, fetch, {
      root,
      sessionID: active.state.session_id ?? null,
      source: "implementing",
      timeoutMs: 2_000,
      floors: { ...DIFFICULTY_CONFIDENCE_FLOOR, hard: 0.7 },
    });
  } catch {
    return null;
  }
  const to = r.difficulty;
  if (!to) return null;
  /* 判定なし（null）は normal と同じ扱い。normal へ書き換えても何も変わらないので hard だけ反映する */
  if (DIFFICULTY_RANK[to] <= (from ? DIFFICULTY_RANK[from] : DIFFICULTY_RANK.normal)) return null;
  state.setDifficulty(root, to);
  state.recordEvent(root, {
    type: "difficulty_upgraded",
    goal: active.goal.id,
    from,
    to,
    confidence: r.confidence,
    source: "decided",
  });
  return `difficulty: ${from ?? "unknown"} → ${to}（決めたことの判定${to === "hard" ? "。cascade を昇格" : ""}）`;
}

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
        strong: {
          type: "boolean",
          description:
            "action=start のとき、goal の間ずっと強いモデル（cascade.strong→expert→escalate）で回す。cascade が無効なら効かない",
        },
      },
      ["action"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { action: string; title?: string; force?: boolean; strong?: boolean };
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
          /* 難易度は題から判定する。d1 を使えない環境では judgeGoalDifficulty が
           * 待たずに null を返す。上限 1.0 秒。 */
          const judged = await judgeGoalDifficulty(root, sessionID || null, args.title);
          const a = state.startGoal(root, args.title, sessionID, {
            strong: args.strong === true,
            difficulty: judged,
          });
          try {
            const captured = await state.captureStartBaseline($, root);
            if (captured) {
              state.setStartBaselineRev(root, captured.rev, captured.source);
              state.snapshotInitialDirt(root, await state.measureDiffLines($, root, captured.rev));
              state.snapshotInitialDiffFiles(root, await state.measureChangedFiles($, root, captured.rev));
            }
          } catch {
            // 測定不能は無視（initial null＝旧挙動）
          }
          /* complete ゲートのモードと採点基準を開始時に凍結する（design g-mwmnvx3x 判断1・3）。
           * どちらも失敗しても start は止めない（記録だけ残す） */
          let rubricNote = "";
          try {
            const normalized = state.readGateModes(root);
            for (const k of normalized.invalid) {
              state.recordEvent(root, { type: "config_invalid_gate", goal: a.goal.id, gate: k });
            }
            const snap = snapshotRubric(root, a.goal.id);
            state.freezeGoalGates(root, normalized.modes, snap?.hash ?? null);
            rubricNote = snap
              ? `rubric: 凍結（${snap.hash.slice(0, 8)}。この goal の検証は開始時の採点基準で行う）`
              : "rubric: 未凍結（snapshot 失敗。採点基準は現行を使う）";
            if (snap) {
              state.recordEvent(root, {
                type: "rubric_frozen",
                goal: a.goal.id,
                hash: snap.hash,
              });
            } else {
              state.recordEvent(root, { type: "rubric_snapshot_failed", goal: a.goal.id });
            }
          } catch {
            rubricNote = "rubric: 未凍結（snapshot 失敗）";
          }
          // 意図ログ（design g-mwebh9vl）: goal 開始時点の会話を話者ラベル付きで保存。
          // 取得失敗・oversize は null のまま（start は止めない）
          let intentNote = "";
          try {
            if (sessionID) {
              const msgs = (await gh.ctx.session.context({
                sessionID,
              })) as unknown as Parameters<typeof renderIntent>[0];
              const rendered = renderIntent(msgs ?? [], {
                goalId: a.goal.id,
                title: a.goal.title,
                sessionID,
              });
              if (rendered) {
                const path = state.intentPath(root, a.goal.id);
                mkdirSync(dirname(path), { recursive: true });
                const tmp = `${path}.tmp`;
                writeFileSync(tmp, rendered, "utf8");
                renameSync(tmp, path);
                state.setIntentPath(root, path);
                intentNote = formatIntentLine(path);
              }
            }
          } catch (err) {
            // capture 失敗は start を止めない（理由だけ残す）
            console.warn(`graphhopper: intent capture に失敗: ${String(err)}`);
          }
          const started = state.getActive(root) ?? a;
          const cfg = state.readConfig(root);
          const cascadeBase = await syncCascade(gh);
          const cascadeNote =
            cascadeBase && cfg.cascade.enabled
              ? `${cascadeBase}（注: 判定nodeは cascade.agents.quality の子セッションだけ昇格モデルに切替）`
              : cascadeBase;
          const strongNote = args.strong
            ? cfg.cascade.enabled
              ? "strong: on（goal の間は cascade.strong→expert→escalate）"
              : "strong: 指定されたが cascade が無効のため効かない"
            : "";
          /* baseline の由来を見える化する（design g-mwkgfssi 判断3）。
           * 前 goal は baseline が親 commit になり、今回の変更が実効 diff から漏れた */
          const bs = started.state;
          const baselineNote = bs.start_baseline_rev
            ? `baseline: ${bs.baseline_source ?? "不明"} ${bs.start_baseline_rev.slice(0, 8)}${
                bs.baseline_source === "git-HEAD"
                  ? "（開始前の未 commit は含まない）"
                  : "（開始前の未 commit を基準に含む）"
              }`
            : "baseline: 取得できず（差分ゲートは fail-open・未 commit があると実効 diff が漏れうる）";
          return text(
            `goal started: "${started.goal.title}" (${started.goal.id})\n${started.state.difficulty ? `difficulty=${started.state.difficulty}\n` : ""}phase: designing${cascadeNote ? `\n${cascadeNote}` : ""}${strongNote ? `\n${strongNote}` : ""}${intentNote ? `\n${intentNote}` : ""}\n${baselineNote}${rubricNote ? `\n${rubricNote}` : ""}\n次: ${PHASE_ACTION["designing"]}`,
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
          const policyNote = a
            ? catalogPolicyWarning(root, state.readConfig(root))
            : null;
          return text(
            a
              ? `resumed: "${a.goal.title}" | phase: ${a.state.phase}${args.force ? " (forced)" : ""}${cascadeNote ? `\n${cascadeNote}` : ""}${policyNote ? `\n${policyNote}` : ""}\n次: ${PHASE_ACTION[a.state.phase]}`
              : "no active goal",
          );
        }
        case "complete": {
          const a = state.getActive(root);
          if (!a) return text("no active goal");
          clearWaitTimer(sessionID);
          /* ゲートの実効モードは goal 開始時に凍結した値を使う（design g-mwmnvx3x 判断3）。
           * 旧 goal（未凍結）だけ config の現在値にフォールバックする */
          const modes = a.state.gate_modes ?? state.readGateModes(root).modes;
          const effective: { mode: state.GateMode; gate: state.GateName; observed: boolean }[] = [];
          /* 拒否するか、observe として記録して通す。enforce なら理由を返す */
          const gate = (name: state.GateName, reason: string): string | null => {
            const mode = modes[name];
            if (mode === "observe") {
              if (!args.force) {
                state.recordEvent(root, {
                  type: "complete_gate_observe",
                  goal: a.goal.id,
                  gate: name,
                  reason,
                });
                effective.push({ mode, gate: name, observed: true });
              }
              return null;
            }
            effective.push({ mode, gate: name, observed: false });
            return args.force ? null : reason;
          };

          /* 採点基準の凍結（design g-mwmnvx3x 判断1）。検証の信頼性に直結するので最初に見る */
          const rubricNotes: string[] = [];
          if (a.state.rubric_hash) {
            const rs = rubricStatus(root, a.goal.id, a.state.rubric_hash);
            if (!rs.frozen || rs.tampered) {
              const r = gate(
                "verifier_self_modified",
                "error: 採点基準の凍結ファイルが無い／内容が開始時と違います（改ざんの可能性）。" +
                  "force: true で完了するか、新しい goal でやり直してください。",
              );
              if (r) return text(r);
            } else if (rs.selfModified) {
              const r = gate(
                "verifier_self_modified",
                "error: 採点に使うコードか verifier の system prompt が goal 中に変わっています（自己改変）。" +
                  "変更を戻すか、force: true で完了してください。",
              );
              if (r) return text(r);
              state.recordEvent(root, {
                type: "verifier_self_modified",
                goal: a.goal.id,
                code: rs.codeChanged,
                agent: rs.agentChanged,
              });
            }
            if (rs.changed) {
              rubricNotes.push("rubric: goal 中に採点基準が変わった（この goal の検証は開始時の基準）");
              state.recordEvent(root, { type: "rubric_changed", goal: a.goal.id });
            }
          }

          const baseline = await state.resolveBaseline($, root, a.state);
          // ルール文書の usability ゲート（design g-mwfltxyt）。verifier clean より前に判定する
          {
            const docs = policyDocsChanged(
              await state.measureChangedFiles($, root, baseline),
              a.state.initial_diff_files,
            );
            const currentHash = docs.length > 0 ? state.hashFiles(root, docs) : null;
            const refusal = usabilityGateRefusal(
              a.state.usability_review,
              docs,
              currentHash,
            );
            if (refusal) {
              const r = gate("usability", refusal);
              if (r) return text(r);
            }
          }
          if (a.state.last_verifier?.level !== "clean") {
            const r = gate(
              "verifier",
              "error: complete には直近の graphhopper_verifier_set（集約 clean）が必要です（self-graded 完了は禁止）。" +
                "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。",
            );
            if (r) return text(r);
          }
          // 検証後の変更検知（design g-mwd3n5bo）。両方の指紋が取れて不一致なら止める
          const currentHash = await state.computeDiffHash($, root, baseline);
          const verifiedHash = a.state.last_verifier?.diff_hash ?? null;
          const mismatch =
            !!currentHash && !!verifiedHash && currentHash !== verifiedHash;
          if (mismatch) {
            const r = gate(
              "diff_hash",
              "error: 検証後に差分が変わっています（verifier clean の時点と不一致）。graphhopper_verifier_set で再検証してから complete してください。" +
                "差分が問題ないと人間が判断した場合のみ force: true を使ってください（監査ログに diff_gate: forced が残ります）。",
            );
            if (r) return text(r);
          }
          const diffGate = mismatch
            ? "forced"
            : currentHash && verifiedHash
              ? "ok"
              : "unavailable";
          const restored = await finishCascade(gh);
          const done = state.completeGoal(root, {
            forced: args.force === true,
            diff_gate: diffGate,
            gates: effective,
          });
          const observed = effective.filter((e) => e.observed);
          return text(
            done
              ? [
                  `completed: "${done.goal.title}"${args.force ? " (forced)" : ""}`,
                  observed.length
                    ? `observe で通したゲート: ${observed.map((e) => e.gate).join(", ")}（history に理由を記録）`
                    : "",
                  ...rubricNotes,
                  restored,
                ]
                  .filter(Boolean)
                  .join("\n")
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
    description: "graphhopper の現在状態（goal・フェーズ・router・verifier）を表示する",
    input: S.obj({}, []),
    execute: async () => {
      const a = state.getActive(root);
      if (!a) return text("no active goal");
      const v = a.state.last_verifier;
      const lensModels = v ? state.formatLensModels(v.lens, v.models, v.model) : "";
      const severityLine = v ? state.formatSeverity(v.severity) : "";
      /* 採点基準の凍結状態（design g-mwmnvx3x 判断1） */
      const rs = a.state.rubric_hash ? rubricStatus(root, a.goal.id, a.state.rubric_hash) : null;
      const rubricLine = !a.state.rubric_hash
        ? "rubric: 未凍結（legacy goal）"
        : !rs?.frozen || rs.tampered
          ? "rubric: 改ざんの疑い（凍結ファイルが無い／内容が不一致）"
          : `rubric: 凍結${rs.changed ? "・goal 中に基準が変わった" : ""}${rs.selfModified ? "・採点コードか verifier 定義が変わった" : ""}`;
      return text(
        [
          `goal: "${a.goal.title}" (${a.goal.id}) [${a.goal.status}]`,
          `phase: ${a.state.phase}`,
          `session: ${a.state.session_id ?? "unbound"}`,
          ...(a.state.strong_mode ? ["strong: on（cascade.strong→expert→escalate）"] : []),
          a.state.router.route
            ? `router: route=${a.state.router.route} diff_lines=${a.state.router.diff_lines} checked_at=${a.state.router.checked_at}${a.state.router.deep ? ` deep (${a.state.router.deep_reason})` : ""}`
            : "router: (not checked)",
          a.state.initial_diff_lines !== null && a.state.initial_diff_lines !== undefined
            ? `initial_dirt: ${a.state.initial_diff_lines} lines（goal start時の未コミット分。実効diffから除外）`
            : null,
          a.state.intent_path ? formatIntentLine(a.state.intent_path) : null,
          formatUsabilityLine(
            a.state.usability_review,
            state.usabilityStale(root),
          ),
          a.state.last_verifier
            ? `last_verifier: level=${a.state.last_verifier.level} target=${a.state.last_verifier.target ?? "-"} lens=${a.state.last_verifier.lens.join(",") || "-"}${lensModels ? ` models=${lensModels}` : ""} reason=${a.state.last_verifier.reason}`
            : "last_verifier: (none)",
          severityLine ? `verifier_severity: ${severityLine}` : null,
          rubricLine,
          `gates: ${Object.entries(a.state.gate_modes ?? state.readGateModes(root).modes)
            .map(([k, v2]) => `${k}=${v2}`)
            .join(" ")}${a.state.gate_modes ? "（開始時に凍結）" : "（未凍結・config の現在値）"}`,
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
      const before = state.getActive(root);
      const mv = state.setPhaseChecked(root, args.phase, args.notes);
      if (!mv.ok) return text(`error: ${mv.error ?? "遷移に失敗"}`);
      let a = mv.active;
      if (!a) return text("error: no active goal or invalid phase");
      /* designing → implementing のときだけ、題と決定記録の「決めたこと」から難易度を判定し直す（上がる方向だけ）。
       * difficulty を上げてから syncCascade を呼ぶ（escalate_on: ["hard"] を効かせる） */
      const entering = before?.state.phase === "designing" && a.state.phase === "implementing";
      const upgrade = entering ? await upgradeDifficultyFromDesign(gh, a) : null;
      if (upgrade) a = state.getActive(root) ?? a;
      if (entering && a.state.intent_path) {
        try {
          const sid = a.state.session_id;
          if (sid && existsSync(a.state.intent_path)) {
            const msgs = (await gh.ctx.session.context({ sessionID: sid })) as unknown as Parameters<
              typeof appendDesigningTurns
            >[1];
            const next = appendDesigningTurns(readFileSync(a.state.intent_path, "utf8"), msgs ?? [], {
              since: Date.parse(a.goal.created_at),
            });
            if (next) {
              const tmp = `${a.state.intent_path}.tmp`;
              writeFileSync(tmp, next, "utf8");
              renameSync(tmp, a.state.intent_path);
            }
          }
        } catch (err) {
          console.warn(`graphhopper: designing 中の会話の追記に失敗: ${String(err)}`);
        }
      }
      const cascadeNote = await syncCascade(gh);
      return text(
        `phase -> ${a.state.phase}${upgrade ? `\n${upgrade}` : ""}${cascadeNote ? `\n${cascadeNote}` : ""}\n次: ${PHASE_ACTION[a.state.phase]}`,
      );
    },
  });

  editor.add({
    name: "graphhopper_todo",
    description:
      "進捗タスクの操作（任意の道具。タスクは add で自分で足す。決定記録からは作られない）。list=一覧 / start=進行中 / done=完了 / cancel=やらない（reason必須） / add=追加 / reopen=cancelの誤操作から復帰。implementing→polish の遷移は未完了タスクが残ると拒否される",
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
      "implementingでの実装試行の成否を記録する（graphhopper_set_evalでeval_cmdを設定していない場合の自己申告フォールバック。eval_cmd設定済みなら自動実行されるのでこのツールは不要）。連続失敗がstuck_threshold（既定2）に達したら escalate=true を返し、graphhopper_invoke(agent: 'graphhopper-oracle') での相談を促す。okな試行やphase遷移でfail_streakはリセットされる",
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
            `次: ${ORACLE_ASK}`,
            managed,
            cascadeNote,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const stuck = state.checkStuck(root);
      if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
        return text(
          [
            `attempt recorded: fail (fail_streak=${r.fail_streak})`,
            `escalate: true (stuck: ${stuck.reasons.join(", ")})`,
            `次: ${ORACLE_ASK}`,
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
