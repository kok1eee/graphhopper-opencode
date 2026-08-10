/**
 * graphhopper — designing/implementing/polish state machine plugin for opencode
 *
 * graphhopper本体（Claude Code版）の3相グラフをopencodeに移植する。
 * flywheel-opencodeとの最大の違い: C-2不変条件（designing中はsource編集を物理ブロック）を
 * `tool.execute.before` hookで実装している点（flywheel-opencodeにはこの層が無い）。
 *
 * 対応関係（Claude Code → opencode）:
 *   PreToolUse (hooks/design-gate.sh) → tool.execute.before
 *   Stop       (hooks/loop-driver.sh) → event: session.idle
 *
 * 構成:
 * - tools:
 *   - graphhopper_goal          : goal の start/pause/resume/complete/clear
 *   - graphhopper_status        : 現在の goal + フェーズ表示
 *   - graphhopper_phase         : フェーズ遷移（designing → implementing → polish → done）
 *   - graphhopper_router_check  : diff サイズを機械測定し advisor/polish に分岐（loop-driver.sh相当）
 *   - graphhopper_verifier_set  : polish の verifier fan-out 結果（clean/drift）を記録
 * - hook:
 *   - tool.execute.before : designing フェーズで edit/write を許可パス（plans/ 配下）以外に通さない
 * - event:
 *   - session.idle    : active goal があれば継続プロンプトを注入（ループの心臓）
 *   - session.deleted : セッション紐付けを解除
 *
 * state は `.graphhopper/` に保存される（state.ts 参照）。
 */
import { tool, type Plugin } from "@opencode-ai/plugin";
import { injectAgents } from "./agents";
import * as state from "./state";

const SYSTEM_GUIDE = `## graphhopper（designing/implementing/polishループ）の存在

この環境には graphhopper プラグインが常駐している。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら、手を付ける前に graphhopper_goal(action: "start", title: ...) でループを開始せよ。

designing フェーズでは source ファイルの edit/write は物理的にブロックされる（許可されるのは .graphhopper/plans/ 配下の design ドキュメントのみ）。まず design ドキュメントを書き、graphhopper-critic で1回敵対レビューしてから implementing フェーズに遷移して実装せよ。

使わない場面: 単一ファイルの小修正・質問への回答・一回きりのコマンド実行程度の単純作業。その場合は直接やれ。

active な goal が既にあるなら graphhopper_status で状態を確認し、ループの継続として振る舞え。`;

const PHASE_ACTION: Record<state.Phase, string> = {
  designing:
    "goalを理解し、設計判断・実装タスク列を .graphhopper/plans/<goal-id>.md に書く。source編集はここではブロックされる。書けたら task(subagent_type: 'graphhopper-critic') で設計を1回敵対レビューし、指摘を design.md に反映してから graphhopper_phase(phase: 'implementing') へ",
  implementing:
    "design.md のタスクを実装する。まず graphhopper_set_eval(cmd) で合否を機械判定できるコマンド（テスト/lint/typecheck）を1度設定せよ。設定後はターン終了ごとに自動実行され、passならpolishへ自動遷移、failならfail_streakが機械カウントされ、escalateが返ったら task(subagent_type: 'graphhopper-oracle') に相談する。eval_cmdが無い（機械判定できない）場合のみ graphhopper_attempt(ok, note) の自己申告にフォールバックする",
  polish:
    "graphhopper_router_check の route に従う。route=polish（大diff）ならまず simplify を実行する: メインが router.baseline_rev から diff を /tmp/gh-simplify-diff.txt に退避し、task(subagent_type: 'graphhopper-simplify') を1回呼んで提案を集める（3レンズ統合）。適用はメインが行う: 各 finding を Read で裏付け、critical は挙動不変・局所的なものだけ自動適用、high は人間確認、medium/note は報告のみ。適用後は eval_cmd を再実行して機械確認。route=advisor（小diff）なら simplify はスキップ。その後 verifier: route=polish なら requirement/behavior/progress の3charterで、route=advisor なら general charter で task(subagent_type: 'graphhopper-verifier') を呼び、結果を graphhopper_verifier_set で記録。level=clean で graphhopper_phase(phase: 'done') へ。level=drift かつ target=implementing なら implementing に戻る。advisor でも第三者チェック（verifier）は省略不可",
  done: "完了済み。graphhopper_goal(action: 'complete') を確認",
};

function continuationText(goal: state.Goal, s: state.LoopState): string {
  return [
    `[graphhopper] Goal: "${goal.title}" | phase: ${s.phase}`,
    s.notes ? `notes: ${s.notes}` : null,
    s.eval_cmd ? `eval_cmd: ${s.eval_cmd}` : null,
    s.router.route
      ? `router: route=${s.router.route} diff_lines=${s.router.diff_lines}`
      : null,
    s.last_verifier
      ? `last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})`
      : null,
    s.fail_streak > 0 ? `fail_streak: ${s.fail_streak}` : null,
    `次のアクション: ${PHASE_ACTION[s.phase]}`,
    "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
    "ブロックしたら回らずに理由を述べて停止。完了したら graphhopper_goal(complete)。無駄な空転は禁止。",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const a = args as Record<string, unknown>;
  const raw = a["filePath"] ?? a["path"] ?? a["file_path"];
  return typeof raw === "string" ? raw : undefined;
}

export const Graphhopper: Plugin = async ({ client, $, directory }) => {
  const root = directory;

  return {
    config: async (input) => {
      injectAgents(input, root);
    },

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_GUIDE);
    },

    /* ================================================================ *
     * C-2不変条件: designing フェーズで source 編集を物理ブロックする
     * Claude Code の hooks/design-gate.sh (PreToolUse) 相当
     * ================================================================ */
    "tool.execute.before": async (input, output) => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== "write" && toolName !== "edit") return;

      const active = state.getActive(root);
      if (!active) return;
      const cfg = state.readConfig(root);
      const filePath = resolveFilePath(
        (output as { args?: unknown } | undefined)?.args,
      );
      if (!filePath) return;

      if (state.isDesignGateBlocked(cfg, active.state.phase, filePath)) {
        state.recordEvent(root, {
          type: "design_gate_block",
          goal: active.goal.id,
          tool: toolName,
          path: filePath,
        });
        throw new Error(
          `Refused: ${toolName} to ${filePath} is blocked because the goal is in the "designing" phase. ` +
            `Only paths under ${cfg.design_gate_allow.join(", ")} may be written while designing. ` +
            `Write the design doc first, then graphhopper_phase(phase: "implementing") before editing source.`,
        );
      }
    },

    tool: {
      graphhopper_goal: tool({
        description:
          "graphhopper の goal を管理する。start=新規 goal でループ開始、pause/resume=一時停止/再開、complete=完了（要直近 verifier clean）、clear=状態リセット",
        args: {
          action: tool.schema.enum([
            "start",
            "pause",
            "resume",
            "complete",
            "clear",
          ]),
          title: tool.schema
            .string()
            .optional()
            .describe("action=start のとき必須。goal の題名"),
          force: tool.schema
            .boolean()
            .optional()
            .describe(
              "complete 時に verifier 未clearでも強制完了する（人間の判断が見える場合のみ）",
            ),
        },
        async execute(args, ctx) {
          switch (args.action) {
            case "start": {
              if (!args.title) return "error: title is required for start";
              const active = state.getActive(root);
              if (active && active.goal.status === "active") {
                return `error: goal "${active.goal.title}" is already active. complete or pause it first.`;
              }
              const a = state.startGoal(root, args.title, ctx.sessionID);
              return `goal started: "${a.goal.title}" (${a.goal.id})\nphase: designing\n次: ${PHASE_ACTION.designing}`;
            }
            case "pause": {
              const a = state.pauseGoal(root);
              return a ? `paused: "${a.goal.title}"` : "no active goal";
            }
            case "resume": {
              const a = state.resumeGoal(root, ctx.sessionID);
              return a
                ? `resumed: "${a.goal.title}" | phase: ${a.state.phase}`
                : "no active goal";
            }
            case "complete": {
              const a = state.getActive(root);
              if (!a) return "no active goal";
              // self-graded done 禁止: 直近の verifier clean を機械要求する（drift残りの完了を防ぐ）
              if (!args.force && a.state.last_verifier?.level !== "clean") {
                return (
                  "error: complete には直近の graphhopper_verifier_set(level: 'clean') が必要です（self-graded 完了は禁止）。" +
                  "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。"
                );
              }
              const done = state.completeGoal(root);
              return done
                ? `completed: "${done.goal.title}"${args.force ? " (forced)" : ""}`
                : "no active goal";
            }
            case "clear": {
              const a = state.completeGoal(root);
              if (a) state.setPhase(root, "designing", "");
              state.unbindSession(root, ctx.sessionID);
              return "cleared";
            }
          }
        },
      }),

      graphhopper_status: tool({
        description:
          "graphhopper の現在状態（goal・フェーズ・router・verifier）を表示する",
        args: {},
        async execute() {
          const a = state.getActive(root);
          if (!a) return "no active goal";
          return [
            `goal: "${a.goal.title}" (${a.goal.id}) [${a.goal.status}]`,
            `phase: ${a.state.phase}`,
            `session: ${a.state.session_id ?? "unbound"}`,
            a.state.router.route
              ? `router: route=${a.state.router.route} diff_lines=${a.state.router.diff_lines} checked_at=${a.state.router.checked_at}`
              : "router: (not checked)",
            a.state.last_verifier
              ? `last_verifier: level=${a.state.last_verifier.level} target=${a.state.last_verifier.target ?? "-"} lens=${a.state.last_verifier.lens.join(",") || "-"} reason=${a.state.last_verifier.reason}`
              : "last_verifier: (none)",
            `fail_streak: ${a.state.fail_streak}`,
            a.state.notes ? `notes: ${a.state.notes}` : null,
            `updated: ${a.state.updated_at}`,
          ]
            .filter(Boolean)
            .join("\n");
        },
      }),

      graphhopper_phase: tool({
        description:
          "graphhopper のフェーズを遷移させる。遷移前にそのフェーズの exit 条件を満たしていること",
        args: {
          phase: tool.schema.enum(state.PHASES),
          notes: tool.schema
            .string()
            .optional()
            .describe("中断・再開用メモ（どこまでやったか）"),
        },
        async execute(args) {
          const a = state.setPhase(root, args.phase, args.notes);
          if (!a) return "error: no active goal or invalid phase";
          return `phase -> ${a.state.phase}\n次: ${PHASE_ACTION[a.state.phase]}`;
        },
      }),

      /* ============================================================ *
       * eval_cmd（graphhopper本体のeval_cmd相当）: implementingの合否を
       * 自己申告ではなくコマンド実行のexit codeで機械判定する。
       * ============================================================ */
      graphhopper_set_eval: tool({
        description:
          "implementingの合否を機械判定するコマンド（テスト/lint/typecheck等）を設定する。設定後はsession.idle（ターン終了）ごとに自動実行され、pass=polishへ自動遷移・fail=fail_streak機械カウントになる。graphhopper_attemptの自己申告より優先される",
        args: {
          cmd: tool.schema
            .string()
            .describe(
              "実行するシェルコマンド（例: 'npx tsc --noEmit && npm test'）。空文字で解除",
            ),
        },
        async execute(args) {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          state.setEvalCmd(root, args.cmd);
          return args.cmd
            ? `eval_cmd set: ${args.cmd}\n次のターン終了時から自動実行される。`
            : "eval_cmd cleared. graphhopper_attemptの自己申告にフォールバックする。";
        },
      }),

      /* ============================================================ *
       * stuck escalation: diffサイズ（router gate）とは別軸のタイミング判断。
       * 「詰まった回数」を機械カウントし、閾値超で上位モデル(oracle)を促す
       * ============================================================ */
      graphhopper_attempt: tool({
        description:
          "implementingでの実装試行の成否を記録する（graphhopper_set_evalでeval_cmdを設定していない場合の自己申告フォールバック。eval_cmd設定済みなら自動実行されるのでこのツールは不要）。連続失敗がstuck_threshold（既定3）に達したら escalate=true を返し、graphhopper-oracleへの相談を促す。okな試行やphase遷移でfail_streakはリセットされる",
        args: {
          ok: tool.schema
            .boolean()
            .describe(
              "この試行は成功したか（テストが通った・目的の変更が完了した等）",
            ),
          note: tool.schema
            .string()
            .describe(
              "何を試して何が起きたか（失敗時はoracleに渡る文脈になる）",
            ),
        },
        async execute(args) {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          const r = state.recordAttempt(root, args.ok, args.note);
          if (args.ok) return "attempt recorded: ok (fail_streak reset to 0)";
          if (r.escalate) {
            return [
              `attempt recorded: fail (fail_streak=${r.fail_streak})`,
              "escalate: true",
              "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行（何を試して何が起きたか）を渡すこと。",
            ].join("\n");
          }
          return `attempt recorded: fail (fail_streak=${r.fail_streak})\nescalate: false`;
        },
      }),

      /* ============================================================ *
       * router gate（loop-driver.sh相当）: diffサイズでadvisor/polishに分岐
       * ============================================================ */
      graphhopper_router_check: tool({
        description:
          "diffサイズを機械測定してrouteを決める。route=advisor（小diff・graphhopper-verifierを1回だけ呼ぶ）/ route=polish（大diff・3charterでverifier fan-out）。implementing完了時、polishフェーズに入る前に呼ぶ。self-graded完了防止のため、advisorでも第三者チェック（verifier呼び出し）は省略できない",
        args: {},
        async execute() {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          const cfg = state.readConfig(root);
          const baseline =
            active.state.router.baseline_rev ??
            (await state.captureBaselineRev($, root));
          const diffLines = await state.measureDiffLines($, root, baseline);
          const route: state.RouterRoute =
            diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
          state.recordRouterCheck(root, baseline, diffLines, route);
          return [
            `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
            `route: ${route}`,
            route === "polish"
              ? "次: task(subagent_type: 'graphhopper-verifier') をrequirement/behavior/progressの3charterで呼び、graphhopper_verifier_setで記録する"
              : "次: task(subagent_type: 'graphhopper-verifier') を1回、'general'charter（3観点を統合したレビュー）で呼び、graphhopper_verifier_set(lens: ['general'])で記録する（自己レビューだけでの完了は不可）",
          ].join("\n");
        },
      }),

      graphhopper_verifier_set: tool({
        description:
          "polish/advisorのverifier結果（clean/drift）を記録する。drift かつ target=implementing なら implementing に巻き戻し可能。target=design/requirementsは人間のhand-back待ち。self-graded完了防止のため、lensが1つも無い（=task(graphhopper-verifier)を一度も呼んでいない）場合はエラーになる",
        args: {
          level: tool.schema.enum(["clean", "drift"]),
          reason: tool.schema
            .string()
            .describe("採用したdrift、またはcleanの根拠を1〜3文で"),
          target: tool.schema
            .enum(["implementing", "design", "requirements"])
            .optional()
            .describe("drift時の巻き戻し先。clean時は不要"),
          lens: tool.schema
            .array(
              tool.schema.enum([
                "requirement",
                "behavior",
                "progress",
                "general",
              ]),
            )
            .describe(
              "実際にtask(graphhopper-verifier)を呼んで得たレンズ。route=advisorなら['general']1つで良いが、必ず1つ以上必要（第三者チェック無しのself-graded完了を防ぐため空配列は拒否される）",
            ),
        },
        async execute(args) {
          if (args.level === "drift" && !args.target)
            return "error: drift には target が必要です";
          if (!args.lens || args.lens.length === 0) {
            return "error: lens が空です。graphhopper_verifier_set は task(subagent_type: 'graphhopper-verifier') を実際に呼んだ後にしか記録できません（self-graded完了を防ぐための機械的ゲート）。route=advisorでも最低1回、'general'charterで呼んでください。";
          }
          const result = state.setVerifierVerdict(root, {
            level: args.level,
            reason: args.reason,
            target: args.target ?? null,
            lens: args.lens,
          });
          if (result.last_verifier?.level === "clean") {
            return "verifier verdict: clean\ngraphhopper_phase(phase: 'done') で完了に進める。";
          }
          return [
            `verifier verdict: drift -> ${args.target}`,
            `reason: ${args.reason}`,
            `lens: ${args.lens?.join(",") || "-"}`,
            args.target === "implementing"
              ? "次: graphhopper_phase(phase: 'implementing') で巻き戻し"
              : "次: 人間の hand-back を待つ（design/requirementsは自動で戻らない）",
          ].join("\n");
        },
      }),

      /* ============================================================ *
       * discover（loop-until-dry）: phase graphの外にあるオンデマンド探索。
       * round cap / dedupeはtool側（state.tickDiscover）が機械的に強制する。
       * ============================================================ */
      graphhopper_discover_start: tool({
        description:
          "loop-until-dry探索を開始する。件数が事前に分からない探索タスク（バグ探し・セキュリティ監査・網羅的レビュー）に使う。phase graphには影響しない",
        args: {
          target: tool.schema
            .string()
            .describe(
              "何を探すか（例: 認証チェック漏れ、エラー握り潰し、境界値バグ）",
            ),
          scope: tool.schema
            .string()
            .describe("どこを探すか（パスglob、モジュール名）"),
        },
        async execute(args) {
          const s = state.startDiscover(root, args.target, args.scope);
          return [
            `discover started: target="${s.target}" scope="${s.scope}"`,
            "次: task(subagent_type: 'graphhopper-researcher') を broad-scan/semantic-read/edge-case の3charterで並列に呼び、",
            "結果を graphhopper_discover_tick に渡す。stopped_reasonがnullの間、繰り返す。",
          ].join("\n");
        },
      }),

      graphhopper_discover_tick: tool({
        description:
          "1ラウンド分のfindingsを渡し、既見全体（reject/未採用も含む）に対してdedupeする。round cap（既定8）とdry判定（2連続新規0で停止）をここで機械的に強制する",
        args: {
          findings: tool.schema
            .array(
              tool.schema.object({
                title: tool.schema.string(),
                severity: tool.schema.enum([
                  "critical",
                  "high",
                  "medium",
                  "low",
                ]),
                confidence: tool.schema.number(),
                quote: tool.schema.string(),
              }),
            )
            .describe(
              "このラウンドで見つかった全件（新規・既知問わず。tool側でdedupeする）",
            ),
        },
        async execute(args) {
          const s = state.tickDiscover(root, args.findings);
          if (s.stopped_reason) {
            return [
              `stopped: ${s.stopped_reason} (round ${s.round}, ${s.stopped_reason === "max_rounds" ? "上限で打ち切り" : "自然に尽きた"})`,
              `confirmed: ${s.confirmed.length}件`,
              JSON.stringify(s.confirmed, null, 2),
            ].join("\n");
          }
          return `round ${s.round} 完了。dry_streak=${s.dry_streak}, seen=${s.seen.length}件。次のラウンドへ`;
        },
      }),

      graphhopper_discover_clear: tool({
        description: "discoverセッションをクリアする",
        args: {},
        async execute() {
          state.clearDiscover(root);
          return "cleared";
        },
      }),
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.deleted") {
          state.unbindSession(root, event.properties.info.id);
          return;
        }
        if (event.type !== "session.idle") return;

        const sessionID = event.properties.sessionID;
        let active = state.getActive(root);
        if (!active) return;
        if (active.goal.status !== "active") return;
        if (active.state.phase === "done") return;
        if (active.state.session_id !== sessionID) return;

        let evalNote: string | null = null;

        /* eval_cmd（Metric）: implementing中でeval_cmd設定済みなら自己申告に依存せず
         * ターンごとに機械実行する。graphhopper本体のloop-driver.shが毎Stop hookで
         * eval_cmdを実行する挙動と同じ */
        if (active.state.phase === "implementing" && active.state.eval_cmd) {
          const cmd = active.state.eval_cmd;
          const result = await state.runEval($, root, cmd);
          const tail = result.output.split("\n").slice(-20).join("\n");
          // state.notesにはtail済みの短い文字列だけを残す（全文を永続化しない）
          const r = state.recordAttempt(
            root,
            result.ok,
            result.ok ? "" : `eval failed: ${cmd}`,
          );
          if (active.goal.id)
            state.recordEvent(root, {
              type: "eval_run",
              goal: active.goal.id,
              ok: result.ok,
              fail_streak: r.fail_streak,
            });
          if (result.ok) {
            const baseline =
              active.state.router.baseline_rev ??
              (await state.captureBaselineRev($, root));
            const diffLines = await state.measureDiffLines($, root, baseline);
            if (baseline === null) {
              // baseline 取得失敗（jj/git エラー）: diff 0 として advisor route で polish へ進む。
              // simplify の入力 diff は空になるが整理対象が無いのでスキップ扱いになる
              // （実装未着手の diff=0 とは区別して滞留させない）
              state.recordRouterCheck(root, baseline, 0, "advisor");
              state.setPhase(root, "polish");
              evalNote = `eval_cmd passed but baseline not captured — polishへ進む（simplifyはスキップ、verifierで検証）: ${cmd}`;
            } else if (diffLines > 0) {
              // route を機械決定して baseline_rev + route を記録してから polish へ
              // （simplify が router.baseline_rev を参照するため null のままにしない）
              const cfg = state.readConfig(root);
              const route: state.RouterRoute =
                diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
              state.recordRouterCheck(root, baseline, diffLines, route);
              state.setPhase(root, "polish");
              evalNote = `eval_cmd passed (diff ${diffLines} lines since baseline): ${cmd}`;
            } else {
              state.recordRouterCheck(root, baseline, 0, "advisor");
              evalNote = `eval_cmd passed but diff_lines=0 since baseline — まだ何も実装していない。polishへは進めない。実装を進めよ: ${cmd}`;
            }
          } else {
            evalNote = [
              `eval_cmd FAILED (fail_streak=${r.fail_streak}): ${cmd}`,
              tail,
              r.escalate
                ? "escalate: task(subagent_type: 'graphhopper-oracle') に相談せよ。"
                : "",
            ]
              .filter(Boolean)
              .join("\n");
          }
          active = state.getActive(root);
          if (!active) return;
        }

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: [evalNote, continuationText(active.goal, active.state)]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        });
      } catch {
        // ループを止めないためイベントハンドラ内の例外は握りつぶす
      }
    },
  };
};
