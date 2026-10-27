/**
 * graphhopper v2 plugin: ops tools (router_check/diff_stash/verifier_set/
 * critic_set/consult_set/hash/edit/discover_start/discover_tick/
 * discover_clear/handoff)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形に移植。
 * handoff の候補列挙は known-sessions sidecar を使う (H2。session.list は v2 plugin API に無い)。
 */
import { $ } from "bun";
import { effectivePhaseAction, goalResumeContext, readGraphhopperHash, runGraphhopperEdit } from "../../../src/gate";
import { INTERNAL_PROMPT_METADATA_KEY } from "../../../src/entry-decide";
import * as handoff from "../../../src/handoff";
import { invokeStructured } from "../../../src/invoke";
import { formatScoreboard } from "../../../src/scoreboard-format";
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
            ? `deep: ${recorded.router.deep_reason} — behavior lens（polish時）／general lens（advisor時）は休止中（verifier既定モデルの上書きは不要。詳細はSKILL refs/verifier.md）`
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
      "goal の進捗を .graphhopper/HANDOFF.md に書き出す（action: write=既定 / load=新セッションで復元 / list=送信候補 / send=別セッションへ直接送信 / clear=削除）。write は state から機械生成し、pause+bind解除して旧セッションの自動継続を止める。新しい会話では案内が自動で出るので load を呼ぶだけで続きから再開できる（compact の代わり）",
    input: S.obj(
      {
        action: S.enumOf(["write", "load", "list", "send", "clear"], "既定 write。session_id 指定時は send 扱い"),
        session_id: S.optStr("send の送信先セッションID"),
        note: S.optStr("write/send に添える任意メモ"),
        force: { type: "boolean", description: "load で loop 恒久ブロックを明示解除する" },
      },
      [],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as { action?: string; session_id?: string; note?: string; force?: boolean };
      const sessionID = sess(gh, context as Ctx);
      const action = args.action ?? (args.session_id ? "send" : "write");
      const active = state.getActive(root);

      if (action === "clear") {
        return text(handoff.clearHandoff(root) ? "handoff メモを削除した" : "handoff メモは無い");
      }

      if (action === "list") {
        const candidates = knownSessions(root).filter((s) => s.id !== sessionID);
        if (candidates.length === 0) {
          return text(
            "error: 候補セッションなし（このディレクトリで graphhopper_* tool を使った他セッションが無い）。通常は action: write でファイルに書き出し、新しい会話で action: load する。",
          );
        }
        return text(
          [
            "handoff 候補セッション（known-sessions・新しい順）:",
            "※ exit 済み（TUI を閉じた）セッションも含まれる。",
            "",
            ...candidates.map((s) => `- ${s.id} | seen: ${new Date(s.seen).toISOString()}`),
            "",
            "ファイル経由なら action: write → 新しい会話で action: load。直接送るなら action: send（session_id 必須）。",
          ].join("\n"),
        );
      }

      if (!active || active.goal.status === "done") {
        return text("error: handoff できる goal が無い（active か paused の goal が必要）");
      }

      if (action === "load") {
        const memo = handoff.readHandoff(root);
        if (!memo) {
          return text(
            `error: ${handoff.handoffPath(root)} が無い。書いた側で graphhopper_handoff(action: 'write') を実行せよ`,
          );
        }
        if (memo.meta.goal_id !== active.goal.id) {
          return text(
            [
              `error: メモの goal (${memo.meta.goal_id}) と state の active goal (${active.goal.id}) が違う。`,
              "メモが古い可能性がある。state を正として扱い、必要なら書き直せ（write）。",
            ].join("\n"),
          );
        }
        const liveHead = await state.captureBaselineRev($, root);
        const drift = handoff.staleness(root, memo, { vcsHead: liveHead }).filter((i) => !i.same);
        let resumeNote = "";
        if (active.goal.status === "paused") {
          const r = state.resumeGoal(root, sessionID, args.force === true);
          if (!r) {
            return text(
              [
                "error: resume が拒否された（loop 停止が上限に達している）。",
                "内容を確認のうえ graphhopper_handoff(action: 'load', force: true) か graphhopper_goal(action: 'resume', force: true) を使え。",
              ].join("\n"),
            );
          }
          resumeNote = `resumed: "${r.goal.title}" (${r.goal.id}) / phase: ${r.state.phase}`;
        } else if (active.state.session_id && active.state.session_id !== sessionID) {
          /* 別セッションが実行中の goal を、このセッションが横取りしない（pending も据え置く） */
          return text(
            [
              `error: goal "${active.goal.title}" (${active.goal.id}) は別セッション (${active.state.session_id}) が実行中。`,
              "そのセッションで続けるか、こちらで引き継ぐなら graphhopper_goal(action: 'resume') で明示的に bind し直せ。",
            ].join("\n"),
          );
        } else {
          resumeNote = `already active: "${active.goal.title}" (${active.goal.id}) / phase: ${active.state.phase}`;
        }
        handoff.setPending(root, false);
        const a2 = state.getActive(root);
        return text(
          [
            resumeNote,
            drift.length
              ? `メモとのズレ（state を正とする）: ${drift.map((d) => `${d.key} memo=${d.memo || "-"} live=${d.live}`).join(" / ")}`
              : "メモと state は一致（ズレなし）",
            "",
            `次のアクション: ${a2 ? effectivePhaseAction(a2.state.phase, a2.state.entry_route) : "-"}`,
            "",
            "続行せよ。design は designing 終了後は不変（変更は .log.md に追記）。",
          ].join("\n"),
        );
      }

      if (action === "send") {
        if (!args.session_id) {
          return text("error: send には session_id が要る。ファイル経由なら action: write → 新しい会話で load");
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
        const textBody = [
          "## graphhopper handoff",
          "",
          "受け取った goal を引き継いで続行せよ。",
          "これは1回限りの handoff であり、さらに他セッションへ転送しないこと。",
          "続行には graphhopper_goal(action: 'resume') で goal を再バインドしてから実施せよ。",
          "",
          goalResumeContext(root, { includeLoop: true }),
          `- 送信元 session: ${sessionID} | state updated: ${active.state.updated_at}`,
          args.note ? `- 補足: ${args.note}` : null,
          "",
          `引き継いだら「handoff received: ${active.goal.id}」と返信せよ。`,
        ]
          .filter(Boolean)
          .join("\n");
        await gh.ctx.session.prompt({
          sessionID: args.session_id,
          text: textBody,
          metadata: { [INTERNAL_PROMPT_METADATA_KEY]: true },
        });
        state.pauseGoal(root);
        state.unbindSession(root, sessionID);
        return text(
          [
            `handoff sent to ${args.session_id}: "${active.goal.title}" (${active.goal.id})`,
            "送信側の goal は解放された（pause + unbind）。",
          ].join("\n"),
        );
      }

      if (action !== "write") {
        return text(`error: unknown action: ${action}（write/load/list/send/clear）`);
      }

      // write（既定）
      if (active.state.session_id && active.state.session_id !== sessionID) {
        return text(
          [
            `error: goal "${active.goal.title}" (${active.goal.id}) は別セッション (${active.state.session_id}) が実行中。`,
            "そのセッションで handoff を実行するか、こちらへ引き継ぐなら graphhopper_goal(action: 'resume') で bind し直してから書け。",
          ].join("\n"),
        );
      }
      const vcsHead = await state.captureBaselineRev($, root);
      let dirty: boolean | null = null;
      try {
        const r = await $`git status --porcelain`.cwd(root).nothrow().quiet();
        if (r.exitCode === 0) dirty = r.stdout.toString().trim().length > 0;
      } catch {
        dirty = null;
      }
      /* pause してから書く。前に書くと memo の status/updated_at が実 state と
       * 1段ずれて、load のたびに「ズレ」と報告されてしまう */
      const wasLoopStopped = active.state.loop_stopped;
      /* pause 後は goalResumeContext が null になるため、先に取得して render に渡す */
      const resumeContext = goalResumeContext(root, { includeLoop: true });
      state.pauseGoal(root);
      state.unbindSession(root, sessionID);
      let path: string | null = null;
      try {
        path = handoff.writeHandoff(root, { sessionID, vcsHead, dirty, resumeContext });
      } catch (e) {
        /* 書き込み失敗で pause だけ残るのを防ぐ。pause の副作用（loop フラグのリセット）は
         * 戻らないが、goal が paused のまま取り残されるよりはよい */
        state.resumeGoal(root, sessionID, true);
        return text(`error: handoff メモの書き込みに失敗した: ${e instanceof Error ? e.message : String(e)}（goal は resume で戻した）`);
      }
      if (!path) {
        state.resumeGoal(root, sessionID, true);
        return text("error: handoff メモの生成に失敗した（goal が無い）");
      }
      let ignoreNote = "";
      try {
        const r = await $`git check-ignore -q .graphhopper/HANDOFF.md`.cwd(root).nothrow().quiet();
        if (r.exitCode !== 0) {
          ignoreNote =
            "注意: この repo では .graphhopper/HANDOFF.md が gitignore されていない（commit に乗り得る）";
        }
      } catch {
        // VCS 無しは警告不要
      }
      return text(
        [
          `handoff メモを書いた: ${path}`,
          `goal: "${active.goal.title}" (${active.goal.id}) / phase: ${active.state.phase}`,
          "この goal は pause + unbind した（旧セッションの自動継続は止まる）。",
          wasLoopStopped ? "※ loop 停止フラグは pause により解除された（意図せず解除された場合は注意）" : null,
          ignoreNote || null,
          args.note ? `補足: ${args.note}` : null,
          "",
          "新しい会話を開けば案内が出る。出ない場合は graphhopper_handoff(action: 'load') を呼ぶ。",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_scoreboard",
    description:
      "評価機能（成績表）: モデル×役割の成績表（verdict集計）とgoal転帰（巻き戻し・eval・採点）。マッピング判断の素材",
    input: S.obj({}, []),
    execute: async () => text(formatScoreboard(state.buildScoreboard(root))),
  });

  editor.add({
    name: "graphhopper_invoke",
    description:
      "別モデルでsubagent相当を実行する。opencode run をspawnし stdout を返す。入れ子禁止・prompt上限12000文字・timeout既定120s・上限300s。並列fan-out可。delayMsで起動ずらし可（429 herd回避）",
    input: S.obj(
      {
        agent: S.str("graphhopper-* agent名（例: graphhopper-critic）"),
        model: S.optStr("provider/model形式。省略時はconfig既定"),
        prompt: S.str("charter＋渡し物全文（12000文字まで）"),
        timeoutMs: S.num("タイムアウトms（既定120000・上限300000）"),
        delayMs: S.num("起動前の待機ms（並列herd回避用。既定0・上限60000）"),
      },
      ["agent", "prompt"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const a = input as {
        agent: string;
        model?: string;
        prompt: string;
        timeoutMs?: number;
        delayMs?: number;
      };
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
      const r = await invokeStructured(
        {
          agent: a.agent,
          model: a.model,
          prompt: a.prompt,
          root,
          timeoutMs: a.timeoutMs,
          delayMs: a.delayMs,
        },
        undefined,
        { signal },
      );
      const flags = [
        r.timedOut ? "timedOut" : null,
        r.cancelled ? "cancelled" : null,
        r.fallbackWarning ? "fallbackWarning" : null,
      ].filter(Boolean);
      return text(flags.length ? `${r.output}\n[invoke: ${flags.join(", ")}]` : r.output);
    },
  });
}
