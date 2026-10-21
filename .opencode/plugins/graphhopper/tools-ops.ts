/**
 * graphhopper v2 plugin: ops tools (router_check/diff_stash/verifier_set/
 * critic_set/consult_set/hash/edit/discover_start/discover_tick/
 * discover_clear/handoff)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形に移植。
 * handoff の候補列挙は known-sessions sidecar を使う (H2。session.list は v2 plugin API に無い)。
 */
import { $ } from "bun";
import { readGraphhopperHash, runGraphhopperEdit } from "../../../src/gate";
import * as state from "../../../src/state";
import { knownSessions, noteSession, S, text, type Gh } from "./shared";

type Ctx = { sessionID: string };

function sess(gh: Gh, context: Ctx): string {
  const id = String(context.sessionID ?? "");
  if (id) noteSession(gh.root, id);
  return id;
}

export function registerOpsTools(
  editor: { add(tool: Record<string, unknown>): void },
  gh: Gh,
): void {
  const { root } = gh;

  editor.add({
    name: "graphhopper_router_check",
    description:
      "diffサイズを機械測定してrouteを決める。route=advisor（小diff・graphhopper-verifierを1回だけ呼ぶ）/ route=polish（大diff・3charterでverifier fan-out）。implementing完了時、polishフェーズに入る前に呼ぶ。self-graded完了防止のため、advisorでも第三者チェック（verifier呼び出し）は省略できない",
    input: S.obj({}, []),
    execute: async () => {
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      const cfg = state.readConfig(root);
      const baseline = active.state.router.baseline_rev ?? (await state.captureBaselineRev($, root));
      const measured = await state.measureDiffLines($, root, baseline);
      const diffLines = state.effectiveDiffLines(measured, active.state.initial_diff_lines);
      const route: state.RouterRoute = diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
      const recorded = await state.recordRouterCheckWithRisk($, root, baseline, diffLines, route);
      const pre = state.getActive(root);
      if (
        (pre?.state.entry_route === "light" || pre?.state.entry_route === "advised") &&
        route === "polish"
      ) {
        const { ESCALATE_NEXT } = await import("../../../src/gate");
        state.escalateEntryRoute(root);
        return text(
          [
            `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
            "route: polish + light/advised→full自動昇格（designingに巻き戻し）。",
            ESCALATE_NEXT,
          ].join("\n"),
        );
      }
      return text(
        [
          `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
          `route: ${route}`,
          recorded.router.deep
            ? `deep: ${recorded.router.deep_reason} — behavior lens（polish時）／general lens（advisor時）は休止中（verifier既定がsonnet-5-5のため上書き不要。詳細はSKILL refs/verifier.md）`
            : null,
          route === "polish"
            ? "次: task(subagent_type: 'graphhopper-verifier') をrequirement/behavior/progressの3charterで呼び、graphhopper_verifier_setで記録する"
            : "次: task(subagent_type: 'graphhopper-verifier') を1回、'general'charter（3観点を統合したレビュー）で呼び、graphhopper_verifier_set(results: [{lens: 'general', level}], reason: '要約1〜3文')で記録する（reason必須。自己レビューだけでの完了は不可）",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_diff_stash",
    description:
      "verifier fan-out用のdiff退避。baselineからの全文diffを.graphhopper/tmpに1回だけ置きpathを返す（3 lensへのinline 3重展開防止。子権限で読めるようrepo内配置）。router_check後に呼ぶ",
    input: S.obj({}, []),
    execute: async () => {
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      const baseline = active.state.router.baseline_rev ?? (await state.captureBaselineRev($, root));
      const stashed = await state.stashDiff($, root, baseline, active.goal.id);
      if (!stashed) return text("error: diff取得失敗（VCS不在またはbaseline不正）");
      return text(
        [
          `diff stashed: ${stashed.path} (${stashed.lines} lines)`,
          "各lensにはpathを渡し、inline展開禁止。読むのは差分範囲＋疑義点のみに留めよ。",
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_verifier_set",
    description:
      "polish/advisorのverifier結果を記録する。各charterの結果をresultsに詰めるとlevel/targetは機械集約される（drift かつ target=implementing なら implementing に巻き戻し可能。target=design/requirementsは人間のhand-back待ち）。self-graded完了防止のため、resultsが空（=task(graphhopper-verifier)を一度も呼んでいない）場合はエラーになる",
    input: S.obj(
      {
        results: S.arrOf(
          S.obj(
            {
              lens: S.enumOf(["requirement", "behavior", "progress", "general"]),
              level: S.enumOf(["clean", "drift"]),
              target: S.enumOf(["implementing", "design", "requirements"], "drift時の巻き戻し先（level=drift なら必須）。clean時は不要"),
              model: S.optStr("このlensを実行したモデル（deep時の上位モデル等。省略時はトップレベルmodel→config既定）"),
            },
            ["lens", "level"],
          ),
          "実際にtask(graphhopper-verifier)を呼んで得た各charterの結果。route=advisorならgeneral 1件、route=polishならrequirement/behavior/progressの3件。level/targetの最終決定は機械集約（state.aggregateVerdicts）で行う",
        ),
        reason: S.str("集約結果の要約（1〜3文。監査証跡のため必須）。採用基準自体は機械集約される"),
        model: S.optStr("判定を実行したモデル（例: x/provider-model。省略時はconfig既定で補完。成績表の帰属に使う）"),
      },
      ["results", "reason"],
    ),
    execute: async (input: unknown) => {
      const args = input as {
        results: state.VerifierResult[];
        reason: string;
        model?: string;
      };
      const results = args.results ?? [];
      const active = state.getActive(root);
      const rejected = state.checkVerifierResults(results, {
        entryRoute: active?.state.entry_route ?? null,
        escalated: !!active?.state.escalated_at,
      });
      if (rejected) return text(rejected);
      const decided = state.aggregateVerdicts(results);
      const result = state.setVerifierVerdict(root, {
        level: decided.level,
        reason: args.reason,
        target: decided.target,
        lens: results.map((r) => r.lens),
        model: args.model,
        models: results.map((r) => r.model ?? args.model ?? null),
      });
      if (result.last_verifier?.level === "clean") {
        return text(
          "verifier verdict: clean\n同じターン内で続けること: graphhopper_phase(phase: 'done') → graphhopper_goal(action: 'complete')。途中で報告して止まらない。",
        );
      }
      return text(
        [
          `verifier verdict: drift -> ${decided.target}`,
          `reason: ${args.reason}`,
          `lens: ${results.map((r) => `${r.lens}=${r.level}`).join(",")}`,
          decided.target === "implementing"
            ? "次: graphhopper_phase(phase: 'implementing') で巻き戻し"
            : "次: 人間の hand-back を待つ（design/requirementsは自動で戻らない）",
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_critic_set",
    description:
      "designing終了前のdesign.md質レビュー結果（clean/drift）を記録する（opt-in、graphhopper_phaseの前提条件にはしない）。graphhopper-criticを呼んだかどうかに関わらず記録できる——self-graded防止は行わない",
    input: S.obj(
      {
        level: S.enumOf(["clean", "drift"]),
        reason: S.str("critic reviewの結果の根拠、またはcriticを呼ばなかった判断理由を1〜3文で"),
        model: S.optStr("レビューを実行したモデル（省略時はconfig既定で補完。成績表の帰属に使う）"),
      },
      ["level", "reason"],
    ),
    execute: async (input: unknown) => {
      const args = input as { level: "clean" | "drift"; reason: string; model?: string };
      const result = state.setCriticVerdict(root, { level: args.level, reason: args.reason, model: args.model });
      return text(`critic review recorded: ${args.level}. phase: ${result.phase}`);
    },
  });

  editor.add({
    name: "graphhopper_consult_set",
    description:
      "entry相談の記録。kind=advisorはadvised入口の第二意見、kind=oracleはoracle入口の開始時相談。相談自体はtask(graphhopper-advisor/oracle)／graphhopper_invokeで別途行い、ここでは記録のみする（実在は検証しない）。designing→implementingの機械ゲートの入力になる",
    input: S.obj(
      {
        kind: S.enumOf(["advisor", "oracle"]),
        summary: S.str("相談の要旨（1〜3文。何を聞いて何を得たか）"),
        model: S.optStr("相談を実行したモデル（省略時はconfig agents表からkind別に補完）"),
      },
      ["kind", "summary"],
    ),
    execute: async (input: unknown) => {
      const args = input as { kind: "advisor" | "oracle"; summary: string; model?: string };
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      state.setConsult(root, args.kind, { summary: args.summary, model: args.model });
      return text(`consult recorded: ${args.kind}`);
    },
  });

  editor.add({
    name: "graphhopper_hash",
    description: "ファイルのsha1 + size + mtimeを返すread-only tool（graphhopper_editのexpectedHash取得用）",
    input: S.obj({ filePath: S.str("対象ファイルパス") }, ["filePath"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string };
      return text(readGraphhopperHash(root, args.filePath));
    },
  });

  editor.add({
    name: "graphhopper_edit",
    description:
      "hash検証付きedit（goal中のsource編集用。素のeditはフォールバック）。read→sha1検証→単一箇所exact-match→atomic writeを一連実行。不一致・複数一致はthrowで拒否",
    input: S.obj(
      {
        filePath: S.str("対象ファイルパス"),
        expectedHash: S.str("graphhopper_hashで取得したsha1"),
        oldString: S.str("置換前（単一箇所exact-match）"),
        newString: S.str("置換後"),
      },
      ["filePath", "expectedHash", "oldString", "newString"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as {
        filePath: string;
        expectedHash: string;
        oldString: string;
        newString: string;
      };
      return text(runGraphhopperEdit(root, sess(gh, context as Ctx), args));
    },
  });

  editor.add({
    name: "graphhopper_discover_start",
    description:
      "loop-until-dry探索を開始する。件数が事前に分からない探索タスク（バグ探し・セキュリティ監査・網羅的レビュー）に使う。phase graphには影響しない",
    input: S.obj(
      {
        target: S.str("何を探すか（例: 認証チェック漏れ、エラー握り潰し、境界値バグ）"),
        scope: S.str("どこを探すか（パスglob、モジュール名）"),
      },
      ["target", "scope"],
    ),
    execute: async (input: unknown) => {
      const args = input as { target: string; scope: string };
      const active = state.getActive(root);
      const s = state.startDiscover(root, args.target, args.scope, active?.goal.id ?? null);
      return text(
        [
          `discover started: target="${s.target}" scope="${s.scope}"`,
          "次: task(subagent_type: 'graphhopper-researcher') を broad-scan/semantic-read/edge-case の3charterで並列に呼び、",
          "結果を graphhopper_discover_tick に渡す。stopped_reasonがnullの間、繰り返す。",
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_discover_tick",
    description:
      "1ラウンド分のfindingsを渡し、既見全体（reject/未採用も含む）に対してdedupeする。round cap（既定8）とdry判定（2連続新規0で停止）をここで機械的に強制する",
    input: S.obj(
      {
        findings: S.arrOf(
          S.obj(
            {
              title: S.str(""),
              severity: S.enumOf(["critical", "high", "medium", "low"]),
              confidence: S.num(""),
              quote: S.str(""),
            },
            ["title", "severity", "confidence", "quote"],
          ),
          "このラウンドで見つかった全件（新規・既知問わず。tool側でdedupeする）",
        ),
      },
      ["findings"],
    ),
    execute: async (input: unknown) => {
      const args = input as {
        findings: { title: string; severity: "critical" | "high" | "medium" | "low"; confidence: number; quote: string }[];
      };
      const s = state.tickDiscover(root, args.findings);
      if (s.stopped_reason) {
        return text(
          [
            `stopped: ${s.stopped_reason} (round ${s.round}, ${s.stopped_reason === "max_rounds" ? "上限で打ち切り" : "自然に尽きた"})`,
            `confirmed: ${s.confirmed.length}件`,
            JSON.stringify(s.confirmed, null, 2),
          ].join("\n"),
        );
      }
      return text(`round ${s.round} 完了。dry_streak=${s.dry_streak}, seen=${s.seen.length}件。次のラウンドへ`);
    },
  });

  editor.add({
    name: "graphhopper_discover_clear",
    description: "discoverセッションをクリアする",
    input: S.obj({}, []),
    execute: async () => {
      state.clearDiscover(root);
      return text("cleared");
    },
  });

  editor.add({
    name: "graphhopper_handoff",
    description:
      "現在の active goal の状態を要約して、別の opencode セッションへ引き継ぎとして送信する（Claude Code の cross-session messaging / SendMessage 相当）。送信後は送信側が goal から解放される（pause + unbind）。session_id 未指定ならknownセッションを列挙する（送信しない）。受け手は内容を読んで graphhopper_resume で引き継ぐ運用",
    input: S.obj(
      {
        session_id: S.optStr("送信先セッションID。送信時は必須。省略時は候補一覧のみ返す"),
        note: S.optStr("送信メッセージに追記する任意の補足"),
      },
      [],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { session_id?: string; note?: string };
      const sessionID = sess(gh, context as Ctx);
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");

      if (!args.session_id) {
        const candidates = knownSessions(root).filter((s) => s.id !== sessionID);
        if (candidates.length === 0) {
          return text(
            "error: 候補セッションなし（このディレクトリで graphhopper_* tool を使った他セッションが無い）。known-sessions に記録されるのは tool 使用済みセッションのみ。",
          );
        }
        return text(
          [
            "handoff 候補セッション（known-sessions・新しい順）:",
            "※ 一覧には exit 済み（TUI を閉じた）セッションも含まれる。受け手が「開いている」ものへ送ること。",
            "",
            ...candidates.map((s) => `- ${s.id} | seen: ${new Date(s.seen).toISOString()}`),
            "",
            "送信するには graphhopper_handoff(session_id: '<ID>') を呼べ。送信後はこのセッションの goal が解放される（pause + unbind）。",
          ].join("\n"),
        );
      }

      if (args.session_id === sessionID) {
        return text("error: 自分自身への handoff は禁止（ループ防止）");
      }
      let target: { parentID?: string | null } | null;
      try {
        const got = (await gh.ctx.session.get({ sessionID: args.session_id })) as unknown as {
          parentID?: string | null;
        } | null;
        target = got;
      } catch (e) {
        return text(`error: session get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!target) return text(`error: session ${args.session_id} not found`);
      if (target.parentID) {
        return text(`error: session ${args.session_id} は subagent なので handoff 先にできない`);
      }

      const { effectivePhaseAction: epa } = await import("../../../src/gate");
      const s = active.state;
      const textBody = [
        "## graphhopper handoff",
        "",
        "受け取った goal を引き継いで続行せよ。",
        "これは1回限りの handoff であり、さらに他セッションへ転送しないこと。",
        "続行には graphhopper_resume で goal を再バインドしてから実施せよ。",
        "",
        `- goal: "${active.goal.title}" (${active.goal.id}) [${active.goal.status}]`,
        `- phase: ${s.phase}`,
        `- notes: ${s.notes || "(none)"}`,
        `- fail_streak: ${s.fail_streak}`,
        `- loop: stop_count=${s.loop_stop_count}/${state.readConfig(root).loop_stop_max} resume_blocked=${state.isResumeBlocked(root)}`,
        `- eval_cmd: ${s.eval_cmd || "(none)"}`,
        s.router.route
          ? `- router: route=${s.router.route} diff_lines=${s.router.diff_lines}${s.router.deep ? " deep" : ""}`
          : null,
        s.last_verifier ? `- last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})` : null,
        s.critic_review
          ? `- critic_review: ${s.critic_review.level} (${s.critic_review.reason})`
          : "- critic_review: (none, opt-in)",
        `- design doc: .graphhopper/plans/${active.goal.id}.md（designing終了後は不変）`,
        state.planLogExists(root, active.goal.id)
          ? `- log: .graphhopper/plans/${active.goal.id}.log.md（決定の経緯・棄却した代替案・進捗）`
          : null,
        `- 送信元 session: ${sessionID} | state updated: ${s.updated_at}`,
        `- 次のアクション: ${epa(s.phase, s.entry_route)}`,
        args.note ? `- 補足: ${args.note}` : null,
        "",
        `引き継いだら「handoff received: ${active.goal.id}」と返信せよ。`,
      ]
        .filter(Boolean)
        .join("\n");

      await gh.ctx.session.prompt({ sessionID: args.session_id, text: textBody });
      state.pauseGoal(root);
      state.unbindSession(root, sessionID);
      return text(
        [
          `handoff sent to ${args.session_id}: "${active.goal.title}" (${active.goal.id})`,
          "送信側の goal は解放された（pause + unbind）。受け手が graphhopper_resume で引き継ぐ。",
        ].join("\n"),
      );
    },
  });
}
