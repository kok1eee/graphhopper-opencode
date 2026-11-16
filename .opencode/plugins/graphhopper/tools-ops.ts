/**
 * graphhopper v2 plugin: ops tools (router_check/diff_stash/verifier_set/
 * critic_set/consult_set/hash/edit/discover_start/discover_tick/
 * discover_clear/handoff)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形に移植。
 * handoff の候補列挙は known-sessions sidecar を使う (H2。session.list は v2 plugin API に無い)。
 */
import { $ } from "bun";
import {
  effectivePhaseAction,
  goalResumeContext,
  policyDocsChanged,
  readGraphhopperHashValue,
  runGraphhopperEdit,
} from "../../../src/gate";
import { INTERNAL_PROMPT_METADATA_KEY } from "../../../src/entry-decide";
import { latestSummary } from "../../../src/compaction-store";
import * as handoff from "../../../src/handoff";
import { MAX_TIMEOUT_MS, invokeStructured, resolveModel } from "../../../src/invoke";
import { formatScoreboard } from "../../../src/scoreboard-format";
import { catalogPolicyWarning } from "../../../src/bake";
import { buildLensPrompt, invokeFailure, lensPaths, parseLensVerdict } from "../../../src/verify";
import * as state from "../../../src/state";
import { knownSessions, noteSession, S, structured, text, type Gh } from "./shared";

type Ctx = { sessionID: string };

/** verify の lens 1実行分（判定が読めなければ level なし＋reason） */
interface LensRun {
  lens: state.VerifierLens;
  level?: state.VerdictLevel;
  target?: state.DriftTarget;
  summary?: string;
  body: string;
  reason?: string;
}

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
      "diffサイズを機械測定してrouteを決める（advisor=小diff: verifier general×1 / polish=大diff: simplify＋verifier 3lens）。implementing完了時に1回呼ぶ。返り値の lenses / simplify / escalated に従って refs/verifier.md のレシピを実行する（散文は読まなくてよい）。escalated=true ならその場でdesigningに巻き戻るので、レシピは打ち切る。self-graded完了防止のため、advisorでも第三者チェック（verifier）は省略できない",
    input: S.obj({}, []),
    output: S.obj(
      {
        route: S.enumOf(["advisor", "polish"]),
        diff_lines: S.num("実効diffの行数（初期dirty除外）"),
        threshold: S.num("route判定の閾値"),
        lenses: S.arrOf(
          S.enumOf(["requirement", "behavior", "progress", "general"]),
          "verifier に渡す lens（この編成で graphhopper_verifier_set が通る）",
        ),
        simplify: S.bool("simplify を先に実行するか（route=polish のみ true）"),
        escalated: S.bool("light/advised→full の自動昇格が起きたか（true なら designing に戻る）"),
        deep: S.bool("RISK_PATHS に触れたか（参考情報）"),
        deep_reason: S.optStr("deep=true の理由（触れたriskファイル）"),
        next: S.str("次にやること（1行）"),
      },
      ["route", "diff_lines", "threshold", "lenses", "simplify", "escalated", "deep", "next"],
    ),
    execute: async () => {
      const active = state.getActive(root);
      if (!active) throw new Error("no active goal");
      const cfg = state.readConfig(root);
      const baseline = await state.resolveBaseline($, root, active.state);
      const measured = await state.measureDiffLines($, root, baseline);
      const diffLines = state.effectiveDiffLines(measured, active.state.initial_diff_lines);
      const route: state.RouterRoute = diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
      const recorded = await state.recordRouterCheckWithRisk($, root, baseline, diffLines, route);
      const pre = state.getActive(root);
      const willEscalate =
        (pre?.state.entry_route === "light" || pre?.state.entry_route === "advised") &&
        route === "polish";
      let next: string;
      if (willEscalate) {
        const { ESCALATE_NEXT } = await import("../../../src/gate");
        state.escalateEntryRoute(root);
        next = ESCALATE_NEXT;
      } else if (route === "polish") {
        next = "refs/verifier.md の polish レシピ: diff_stash → simplify → 適用 → diag → diff_stash → verify → verifier_set";
      } else {
        next = "refs/verifier.md の advisor レシピ: diag → diff_stash → verify → verifier_set → phase → goal";
      }
      const after = state.getActive(root);
      const plan = state.planVerifier({
        route,
        entryRoute: after?.state.entry_route ?? null,
        escalated: !!after?.state.escalated_at,
      });
      return structured(
        {
          route,
          diff_lines: diffLines,
          threshold: cfg.router_threshold_lines,
          lenses: plan.lenses,
          simplify: plan.simplify,
          escalated: willEscalate,
          deep: recorded.router.deep,
          ...(recorded.router.deep_reason ? { deep_reason: recorded.router.deep_reason } : {}),
          next,
        },
        [
          `route: ${route} (${diffLines} lines, threshold ${cfg.router_threshold_lines})`,
          `lenses: ${plan.lenses.join(",")}${plan.simplify ? " / simplify: yes" : ""}${
            willEscalate ? " / 自動昇格してdesigningに戻った（レシピ打ち切り）" : ""
          }`,
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_diff_stash",
    description:
      "verifier fan-out用のdiff退避。baselineからのdiffを.graphhopper/tmpに1回だけ置きpathを返す（3 lensへのinline 3重展開防止。子権限で読めるようrepo内配置）。.graphhopper/ 配下の作業ファイルは含めない（設定2つは含む）。verify の直前に呼ぶ（simplify適用後・編集後は必ず取り直す）",
    input: S.obj({}, []),
    output: S.obj(
      {
        path: S.str("退避したdiffのpath（verify に渡す。子セッションから読める）"),
        lines: S.num("退避したdiffの行数"),
        baseline: S.str("比較元のrev"),
      },
      ["path", "lines", "baseline"],
    ),
    execute: async () => {
      const active = state.getActive(root);
      if (!active) throw new Error("no active goal");
      const baseline = await state.resolveBaseline($, root, active.state);
      const stashed = await state.stashDiff($, root, baseline, active.goal.id);
      if (!stashed) throw new Error("diff取得失敗（VCS不在またはbaseline不正）");
      // verifier が読む入力を固定する（design g-mwd3n5bo）。全文 diff の指紋を退避
      state.setStashDiffHash(root, await state.computeDiffHash($, root, baseline));
      return structured(
        stashed,
        `diff stashed: ${stashed.path} (${stashed.lines} lines)`,
      );
    },
  });

  editor.add({
    name: "graphhopper_verifier_set",
    description:
      'verifier結果を記録する（polish/advisor共通・唯一の記録入口）。resultsを渡すとlevel/targetは機械集約される（drift かつ target=implementing なら implementing に巻き戻し可能。target=design/requirementsは人間のhand-back待ち）。self-graded完了防止のため、resultsが空（=verifierを一度も呼んでいない）場合はエラーになる。graphhopper_verify の返り値 out.results をそのまま渡せる（呼び出し例: {"results":[{"lens":"general","level":"clean"}],"reason":"要約1〜3文"}）。キーは results[].lens / results[].level / results[].target / results[].model / reason / model のみ',
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
          "実際にverifier（graphhopper_verify または graphhopper_invoke）を呼んで得た各lensの結果。route=advisorならgeneral 1件、route=polishならrequirement/behavior/progressの3件。level/targetの最終決定は機械集約（state.aggregateVerdicts）で行う",
        ),
        reason: S.str("集約結果の要約（1〜3文。監査証跡のため必須）。採用基準自体は機械集約される"),
        model: S.optStr("判定を実行したモデル（例: x/provider-model。省略時はconfig既定で補完。成績表の帰属に使う）"),
      },
      ["results", "reason"],
    ),
    output: S.obj(
      {
        level: S.enumOf(["clean", "drift"], "機械集約された最終判定"),
        target: S.enumOf(["implementing", "design", "requirements"], "drift時の巻き戻し先（clean時は省略）"),
        lens: S.arrOf(S.str("lens名"), "記録した lens"),
        next: S.str("次にやること（1行）"),
      },
      ["level", "lens", "next"],
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
      if (rejected) throw new Error(rejected.replace(/^error:\s*/, ""));
      const decided = state.aggregateVerdicts(results);
      // 検証した差分の指紋（stash 時点。無ければ現在の全文 diff）
      const baseline = await state.resolveBaseline($, root, active?.state ?? null);
      const diffHash =
        state.getStashDiffHash(root) ??
        (await state.computeDiffHash($, root, baseline));
      const result = state.setVerifierVerdict(root, {
        level: decided.level,
        reason: args.reason,
        target: decided.target,
        lens: results.map((r) => r.lens),
        model: args.model,
        models: results.map((r) => r.model ?? args.model ?? null),
        diff_hash: diffHash,
      });
      const lens = results.map((r) => r.lens);
      if (result.last_verifier?.level === "clean") {
        const next = "graphhopper_goal(action: 'complete')（done への遷移は complete が行う）";
        return structured(
          { level: "clean" as const, lens, next },
          `verifier verdict: clean\n同じターン内で続けること: ${next}。途中で報告して止まらない。`,
        );
      }
      const next =
        decided.target === "implementing"
          ? "graphhopper_phase(phase: 'implementing') で巻き戻す"
          : "人間の hand-back を待つ（design/requirementsは自動で戻らない）";
      return structured(
        {
          level: "drift" as const,
          ...(decided.target ? { target: decided.target } : {}),
          lens,
          next,
        },
        [
          `verifier verdict: drift -> ${decided.target ?? "-"}`,
          `reason: ${args.reason}`,
          `lens: ${results.map((r) => `${r.lens}=${r.level}`).join(",")}`,
          `次: ${next}`,
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_usability_set",
    description:
      "ルール文書（AGENTS.md・skills/**.md・src/agents.ts）を変更した goal の usability レビュー結果を記録する（design g-mwfltxyt）。clean=確認して問題なし / drift=要修正 / skipped=不要と判断（reason 必須）。complete は対象文書の変更に対してこの記録を要求する",
    input: S.obj(
      {
        level: S.enumOf(["clean", "drift", "skipped"]),
        reason: S.str("確認の要約、または skipped の理由（必須）"),
        model: S.optStr("レビューを実行したモデル（省略時は config 既定）"),
      },
      ["level", "reason"],
    ),
    execute: async (args: { level: "clean" | "drift" | "skipped"; reason: string; model?: string }) => {
      const active = state.getActive(root);
      if (!active) return text("error: no active goal");
      const reason = String(args.reason ?? "").trim();
      if (!reason) return text("error: reason は必須です（skipped も理由を書く）");
      const baseline = await state.resolveBaseline($, root, active.state);
      const files = policyDocsChanged(
        await state.measureChangedFiles($, root, baseline),
        active.state.initial_diff_files,
      );
      const docHash = files.length > 0 ? state.hashFiles(root, files) : null;
      const result = state.setUsabilityVerdict(root, {
        level: args.level,
        reason,
        files,
        doc_hash: docHash,
        model: args.model ?? null,
      });
      return text(
        [
          `usability: ${args.level}（${files.length} docs${files.length ? `: ${files.join(", ")}` : ""}）`,
          result.usability_review?.level === "drift"
            ? "次: 指摘を直し、graphhopper_invoke(agent: 'graphhopper-usability') で再確認して clean を記録"
            : "次: complete へ",
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
      "entry相談の記録。kind=advisorはadvised入口の第二意見、kind=oracleはoracle入口の開始時相談。相談自体はgraphhopper_invoke(agent: 'graphhopper-advisor' または 'graphhopper-oracle')で別途行い、ここでは記録のみする（実在は検証しない）。designing→implementingの機械ゲートの入力になる",
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
    name: "graphhopper_diag",
    description:
      "型・lint 診断を1回実行し .graphhopper/tmp/diag-<goal>.txt に保存して path を返す（verifier の添付証拠。実行するのは eval_cmd のみ）。status=failed/timeout なら verifier を呼ばずに止まる（直すものがある証拠）。unset（eval_cmd 未設定）でもファイルは作り verifier は走る（診断の不在を clean の根拠にしない）。diff_stash の直前に呼ぶ",
    input: S.obj({}, []),
    output: S.obj(
      {
        path: S.str("診断ファイルのpath（verify が自動で読む。プロンプトに手書きしない）"),
        status: S.enumOf(["passed", "failed", "unset", "timeout"]),
        command: S.optStr("実行した eval_cmd（未設定なら省略）"),
        exit_code: S.num("終了コード（timeout・起動失敗時は省略）"),
        tail: S.str("出力の末尾（20行まで。失敗時にそのまま報告できる）"),
        diff_hash: S.optStr("実行後のdiff指紋（VCS不能なら省略）"),
      },
      ["path", "status", "tail"],
    ),
    execute: async () => {
      const active = state.getActive(root);
      if (!active) throw new Error("no active goal");
      const cmd = active.state.eval_cmd ?? null;
      const run = await state.runDiagCommand(root, cmd);
      const baseline = await state.resolveBaseline($, root, active.state);
      const diffHash = await state.computeDiffHash($, root, baseline);
      const written = state.writeDiagFile(root, active.goal.id, run, diffHash);
      const tail = run.output.split("\n").slice(-20).join("\n").trim();
      const label = {
        passed: "診断passed",
        failed: `診断失敗（exit ${run.exitCode ?? "?"}）`,
        timeout: "診断失敗（timeout）",
        unset: "診断未実行（eval_cmd 未設定）",
      }[run.status];
      return structured(
        {
          path: written.path,
          status: run.status,
          ...(run.command ? { command: run.command } : {}),
          ...(run.exitCode === null ? {} : { exit_code: run.exitCode }),
          tail,
          ...(diffHash ? { diff_hash: diffHash } : {}),
        },
        run.status === "passed"
          ? `${label}: ${written.path}`
          : `${label}: ${written.path}\n${tail.split("\n").slice(-8).join("\n")}`,
      );
    },
  });

  editor.add({
    name: "graphhopper_verify",
    description:
      "verifier を lens ごとに同期実行し、verifier_set にそのまま渡せる results を返す（記録はしない）。prompt（lens指示・design/intent/diff/diag のpath・出力契約）と起動ずらしはツール側で固定する。前提: 同じ diff で graphhopper_diag → graphhopper_diff_stash を済ませておくこと（指紋が3つ揃わなければ throw）。判定を読めなかった lens は missing に入る（results が欠けるので進めない）。一部 lens の再実行は lens で指定（同じ diff 指紋のときだけ保存済み結果と合成する）",
    input: S.obj(
      {
        lens: S.arrOf(
          S.enumOf(["requirement", "behavior", "progress", "general"]),
          "実行する lens（省略時は router_check の編成。polish=3lens / advisor=general）",
        ),
        model: S.optStr("verifier のモデル上書き（provider/model）。config の model_allow/model_deny で検査される"),
        timeoutMs: S.num("lens あたりの timeout ms（既定300000・上限300000）"),
        delayMs: S.num("起動ずらしの間隔 ms（既定5000。claude-oauth の単一プロキシ対策）"),
      },
      [],
    ),
    output: S.obj(
      {
        results: S.arrOf(
          S.obj(
            {
              lens: S.enumOf(["requirement", "behavior", "progress", "general"]),
              level: S.enumOf(["clean", "drift"]),
              target: S.enumOf(["implementing", "design", "requirements"]),
              model: S.str("その lens を実行したモデル"),
            },
            ["lens", "level"],
          ),
          "verifier_set にそのまま渡せる results",
        ),
        summaries: S.arrOf(
          S.obj({ lens: S.str("lens名"), summary: S.str("その lens の判定要約") }, ["lens", "summary"]),
        ),
        bodies: S.arrOf(
          S.obj({ lens: S.str("lens名"), body: S.str("drift・判定不能だった lens の本文") }, ["lens", "body"]),
          "drift と missing の lens だけ（clean の本文は含めない）",
        ),
        missing: S.arrOf(
          S.obj(
            { lens: S.str("lens名"), reason: S.str("読めなかった理由") },
            ["lens", "reason"],
          ),
          "判定を読めなかった lens（空でなければ verifier_set に進まない）",
        ),
        lenses: S.arrOf(S.str("lens名"), "今回の編成（router_check と同じ）"),
        diff_hash: S.str("検証した diff の指紋（verifier_set が記録する値）"),
      },
      ["results", "summaries", "bodies", "missing", "lenses", "diff_hash"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as {
        lens?: state.VerifierLens[];
        model?: string;
        timeoutMs?: number;
        delayMs?: number;
      };
      const active = state.getActive(root);
      if (!active) throw new Error("no active goal");
      const goalId = active.goal.id;
      const plan = state.planVerifier({
        route: active.state.router.route,
        entryRoute: active.state.entry_route,
        escalated: !!active.state.escalated_at,
      });
      const wanted = args.lens?.length ? args.lens : plan.lenses;

      // 前提: diag と diff_stash が同じ差分に対して済んでいること
      const baseline = await state.resolveBaseline($, root, active.state);
      const current = await state.computeDiffHash($, root, baseline);
      if (!current) throw new Error("diff指紋が取れない（VCS不在またはbaseline不正）");
      const stashed = state.getStashDiffHash(root);
      if (!stashed) throw new Error("先に graphhopper_diff_stash を呼べ（退避diffが無い）");
      if (stashed !== current) {
        throw new Error(
          "退避した diff と現在の差分が違う（diff_stash の後に編集された）。graphhopper_diag → graphhopper_diff_stash をやり直せ",
        );
      }
      if (!state.diagExists(root, goalId)) throw new Error("先に graphhopper_diag を呼べ（診断ファイルが無い）");
      const diagHash = state.readDiagDiffHash(root, goalId);
      if (diagHash !== current) {
        throw new Error(
          "診断が現在の差分より古い（diag の後に編集された）。graphhopper_diag → graphhopper_diff_stash をやり直せ",
        );
      }

      const paths = {
        designPath: state.planPath(root, goalId),
        diffPath: state.stashedDiffPath(root, goalId),
        diagPath: state.diagPath(root, goalId),
        intentPath: state.intentPath(root, goalId),
      };
      const modelName = resolveModel(root, "graphhopper-verifier", args.model) ?? null;
      const delay = Math.max(0, args.delayMs ?? 5000);
      const timeout = args.timeoutMs ?? MAX_TIMEOUT_MS;
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal;

      const runs = await Promise.all(
        wanted.map(async (lens, i): Promise<LensRun> => {
          const prompt = buildLensPrompt(root, goalId, lens, lensPaths(root, goalId, lens, paths));
          const r = await invokeStructured(
            {
              agent: "graphhopper-verifier",
              model: args.model,
              prompt,
              root,
              timeoutMs: timeout,
              delayMs: delay * i,
            },
            undefined,
            { signal },
          );
          const broken = (reason: string): LensRun => ({ lens, body: r.output, reason });
          if (r.cancelled) return broken("invoke がキャンセルされた");
          if (r.timedOut) return broken(`timeout (${timeout}ms)`);
          if (r.fallbackWarning) return broken("agent が既定にフォールバックした（判定を採用できない）");
          const failed = invokeFailure(r.output);
          if (failed) return broken(failed);
          const parsed = parseLensVerdict(r.output);
          if (!parsed.ok) return broken(parsed.reason);
          return {
            lens,
            level: parsed.verdict.level,
            ...(parsed.verdict.target ? { target: parsed.verdict.target } : {}),
            summary: parsed.verdict.summary,
            body: r.output,
          };
        }),
      );

      const missing = runs
        .filter((x) => x.level === undefined)
        .map((x) => ({ lens: x.lens, reason: x.reason ?? "判定不能" }));
      const next: state.SavedLensResult[] = runs
        .filter((x) => x.level !== undefined)
        .map((x) => ({
          lens: x.lens,
          level: x.level as state.VerdictLevel,
          ...(x.target ? { target: x.target as state.DriftTarget } : {}),
          ...(modelName ? { model: modelName } : {}),
          summary: x.summary ?? "",
        }));
      const merged = state.mergeSavedVerify(state.readSavedVerify(root, goalId), current, next).filter(
        (r) => plan.lenses.includes(r.lens),
      );
      state.writeSavedVerify(root, goalId, { diff_hash: current, results: merged });
      const covered = new Set(merged.map((r) => r.lens));
      for (const lens of plan.lenses) {
        if (!covered.has(lens) && !missing.some((m) => m.lens === lens)) {
          missing.push({ lens, reason: "この diff ではまだ判定が無い（再実行せよ）" });
        }
      }

      const bodies = runs
        .filter((x) => x.level === undefined || x.level === "drift")
        .map((x) => ({ lens: x.lens, body: x.body.slice(0, 6000) }));

      return structured(
        {
          results: merged.map((r) => ({
            lens: r.lens,
            level: r.level,
            ...(r.target ? { target: r.target } : {}),
            ...(r.model ? { model: r.model } : {}),
          })),
          summaries: merged.map((r) => ({ lens: r.lens, summary: r.summary })),
          bodies,
          missing: missing.map(({ lens, reason }) => ({ lens, reason })),
          lenses: plan.lenses,
          diff_hash: current,
        },
        missing.length
          ? `verify: 判定不能 ${missing.map((m) => `${m.lens}(${m.reason})`).join(", ")} — 記録せずに止まる`
          : `verify: ${merged.map((r) => `${r.lens}=${r.level}`).join(", ")}（次: verifier_set に results を渡す）`,
      );
    },
  });

  editor.add({
    name: "graphhopper_hash",
    description:
      "ファイルのsha1 + size + mtimeを返すread-only tool（graphhopper_editのexpectedHash取得用）。返り値 out.sha1 を edit に渡す。refs/implementing.md のレシピで hash→edit を1バッチにできる",
    input: S.obj({ filePath: S.str("対象ファイルパス") }, ["filePath"]),
    output: S.obj(
      {
        path: S.str("対象ファイルパス"),
        sha1: S.str("内容のsha1（edit の expectedHash に渡す）"),
        size: S.num("バイト数"),
        mtime: S.str("更新時刻（ISO）"),
      },
      ["path", "sha1", "size", "mtime"],
    ),
    execute: async (input: unknown) => {
      const args = input as { filePath: string };
      try {
        const h = readGraphhopperHashValue(root, args.filePath);
        return structured(h, `${h.sha1} ${h.path} (${h.size} bytes)`);
      } catch (e) {
        throw new Error(
          `hash取得失敗 ${args.filePath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
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
          "次: task(subagent_type: 'graphhopper-researcher') を broad-scan/semantic-read/edge-case の3lensで並列に呼び、",
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
        overwrite: {
          type: "boolean",
          description: "write 時に、pending な別 goal のメモを明示的に上書きする",
        },
      },
      [],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as {
        action?: string;
        session_id?: string;
        note?: string;
        force?: boolean;
        overwrite?: boolean;
      };
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

      if (action === "load") {
        const memo = handoff.readHandoff(root);
        if (!memo) {
          return text(
            `error: ${handoff.handoffPath(root)} が無い。書いた側で graphhopper_handoff(action: 'write') を実行せよ`,
          );
        }
        if (memo.meta.kind === "session") {
          if (active && active.goal.status !== "done") {
            return text(
              [
                "error: session メモ（goal 無し）は active な goal があるセッションでは読めない（state と食い違う）。",
                "この goal を続けるか、graphhopper_goal(action: 'complete') してから読め。",
              ].join("\n"),
            );
          }
          handoff.setPending(root, false);
          return text(
            [
              `handoff（goal なし）を読んだ: ${handoff.handoffPath(root)}`,
              "",
              memo.body,
              "",
              "新しい goal を立てるときは graphhopper_goal(action: 'start', title: ...) を使う。",
            ].join("\n"),
          );
        }
        if (!active || active.goal.status === "done") {
          return text(
            `error: メモは goal (${memo.meta.goal_id}) のものだが、現在 active な goal が無い（または done）。まず graphhopper_goal(action: 'resume') で戻せ`,
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
          const policyNote = catalogPolicyWarning(root, state.readConfig(root));
          if (policyNote) resumeNote += `\n${policyNote}`;
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
        if (!active || active.goal.status === "done") {
          return text("error: send できる goal が無い（active か paused の goal が必要）");
        }
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
      const vcsHead = await state.captureBaselineRev($, root);
      let dirty: boolean | null = null;
      try {
        const r = await $`git status --porcelain`.cwd(root).nothrow().quiet();
        if (r.exitCode === 0) dirty = r.stdout.toString().trim().length > 0;
      } catch {
        dirty = null;
      }
      /* 要約は「この会話」のもの。goal が複数セッションに跨っても直近の会話だけを使う */
      /* テスト用に DB パスを差し替えられる（本番は未設定） */
      const summary = latestSummary(sessionID, { dbPath: process.env["GH_HANDOFF_DB"] ?? null });
      const hasGoal = !!active && active.goal.status !== "done";

      /* 上書き保護: pending な別 goal のメモを黙って潰さない（goal 無しの session メモでも守る） */
      const existing = handoff.readHandoff(root);
      const conflicts = handoff.isPendingGoalMemo(existing, hasGoal ? active.goal.id : undefined);
      if (conflicts && !args.overwrite) {
        return text(
          [
            `error: 未読の handoff メモ（別 goal: ${existing?.meta.goal_id}）が残っている。`,
            "先にその goal を再開するか、上書きしてよいなら graphhopper_handoff(action: 'write', overwrite: true) を使え。",
          ].join("\n"),
        );
      }

      if (!hasGoal) {
        /* goal が無い（完了済み・未 start）: 会話の要約と作業メモだけを書く */
        const path = handoff.writeHandoff(root, {
          sessionID,
          vcsHead,
          dirty,
          note: args.note,
          summary,
        });
        if (!path) {
          return text(
            "error: 書き出す内容が無い（goal が無いので、note か compaction 要約のどちらかが必要）",
          );
        }
        return text(
          [
            `handoff メモ（goal なし）を書いた: ${path}`,
            summary ? `会話の要約を添付（model=${summary.model || "不明"} / ${summary.at || "日時不明"}）` : "会話の要約なし（このセッションはまだ compact していない）",
            args.note ? `作業メモ: ${args.note}` : null,
            "",
            "新しい会話を開けば案内が出る。出ない場合は graphhopper_handoff(action: 'load') を呼ぶ。",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (active.state.session_id && active.state.session_id !== sessionID) {
        return text(
          [
            `error: goal "${active.goal.title}" (${active.goal.id}) は別セッション (${active.state.session_id}) が実行中。`,
            "そのセッションで handoff を実行するか、こちらへ引き継ぐなら graphhopper_goal(action: 'resume') で bind し直してから書け。",
          ].join("\n"),
        );
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
        path = handoff.writeHandoff(root, {
          sessionID,
          vcsHead,
          dirty,
          resumeContext,
          note: args.note,
          summary,
        });
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
          summary ? `会話の要約を添付（model=${summary.model || "不明"} / ${summary.at || "日時不明"}）` : "会話の要約なし（このセッションはまだ compact していない）",
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
        model: S.optStr("provider/model形式。省略時はconfig既定。configのmodel_allow/model_denyで拒否される場合がある"),
        prompt: S.str("lens指示＋渡し物全文（12000文字まで）"),
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
