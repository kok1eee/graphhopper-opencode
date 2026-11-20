/**
 * graphhopper v2 plugin: ops tools (router_check/diff_stash/verifier_set/
 * hash/edit/discover_start/discover_tick/
 * discover_clear/handoff)。
 * v1 src/index.ts の同名 tool execute 本体を v2 形に移植。
 * handoff の候補列挙は known-sessions sidecar を使う (H2。session.list は v2 plugin API に無い)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  PHASE_ACTION,
  goalResumeContext,
  policyDocsChanged,
  readGraphhopperHashValue,
  runGraphhopperEdit,
} from "../../../src/gate";
import { INTERNAL_PROMPT_METADATA_KEY } from "../../../src/entry-decide";
import { latestSummary } from "../../../src/compaction-store";
import * as handoff from "../../../src/handoff";
import { CHECKS_PATH, checkEntries, matchChecks, parseChecks } from "../../../src/checks";
import { ANGLE_TIMEOUT_MS, invokeStructured, resolveModel } from "../../../src/invoke";
import { rubricStatus } from "../../../src/verify";
import { formatScoreboard } from "../../../src/scoreboard-format";
import { catalogPolicyWarning } from "../../../src/bake";
import { buildAnglePrompt, extractJsonBlock, invokeFailure, parseLensVerdict } from "../../../src/verify";
import {
  SIBLINGS,
  SIBLINGS_ID,
  angleSlots,
  applyAdds,
  applyChecks,
  applyDefaults,
  applyPicks,
  buildSelectorPrompt,
  carryOver,
  firstRoundEntries,
  initialPlan,
  needsFollowup,
  parseSelection,
  remainingSlots,
  type AddInput,
  type AnglePlan,
  type PlanEntry,
} from "../../../src/angles";
import * as state from "../../../src/state";
import { knownSessions, noteSession, S, structured, text, type Gh } from "./shared";

type Ctx = { sessionID: string };

/* ponytail: 2 つの timeout の使い分けはテストしない（定数を渡すだけ。壁時計で確かめると flaky になる） */
const SELECTOR_TIMEOUT_MS = 120_000;
const FOLLOWUP_TIMEOUT_MS = 180_000;

/** verify の lens 1実行分（判定が読めなければ level なし＋reason） */
interface LensRun {
  lens: state.VerifierLens;
  level?: state.VerdictLevel;
  target?: state.DriftTarget;
  summary?: string;
  /** 重要度の件数（未申告は undefined。design g-mwmnvx3x 判断4） */
  severity?: state.VerifierSeverityCounts;
  prior?: { valid: number; invalid: number; unresolved: number };
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
      "diffサイズを機械測定してrouteを決める（advisor=小diff / polish=大diff: simplify を先に実行。verifier の角度は graphhopper_verify が選ぶ）。implementing完了時に1回呼ぶ。返り値の angle_slots / simplify に従って refs/verifier.md のレシピを実行する（散文は読まなくてよい）。self-graded完了防止のため、advisorでも第三者チェック（verifier）は省略できない",
    input: S.obj({}, []),
    output: S.obj(
      {
        route: S.enumOf(["advisor", "polish"]),
        diff_lines: S.num("実効diffの行数（初期dirty除外）"),
        threshold: S.num("route判定の閾値"),
        angle_slots: S.num("選ぶ役が選ぶ角度の枠の数（agreement は別。graphhopper_verify が計画を作る）"),
        simplify: S.bool("simplify を先に実行するか（route=polish のみ true）"),
        deep: S.bool("RISK_PATHS に触れたか（参考情報）"),
        deep_reason: S.optStr("deep=true の理由（触れたriskファイル）"),
        next: S.str("次にやること（1行）"),
      },
      ["route", "diff_lines", "threshold", "angle_slots", "simplify", "deep", "next"],
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
      let next: string;
      if (route === "polish") {
        next = "refs/verifier.md の polish レシピ: diff_stash → simplify → 適用 → diag → diff_stash → verify → verifier_set";
      } else {
        next = "refs/verifier.md の advisor レシピ: diag → diff_stash → verify → verifier_set → phase → goal";
      }
      const slots = angleSlots({ route, difficulty: active.state.difficulty });
      const simplify = route === "polish";
      return structured(
        {
          route,
          diff_lines: diffLines,
          threshold: cfg.router_threshold_lines,
          angle_slots: slots,
          simplify,
          deep: recorded.router.deep,
          ...(recorded.router.deep_reason ? { deep_reason: recorded.router.deep_reason } : {}),
          next,
        },
        [
          `route: ${route} (${diffLines} lines, threshold ${cfg.router_threshold_lines})`,
          `angle_slots: ${slots}${simplify ? " / simplify: yes" : ""}`,
        ].join("\n"),
      );
    },
  });

  editor.add({
    name: "graphhopper_diff_stash",
    description:
      "verifier fan-out用のdiff退避。baselineからのdiffを.graphhopper/tmpに1回だけ置きpathを返す（角度ごとの inline 展開防止。子権限で読めるようrepo内配置）。.graphhopper/ 配下の作業ファイルは含めない（設定2つは含む）。verify の直前に呼ぶ（simplify適用後・編集後は必ず取り直す）",
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
      'verifier結果を記録する（polish/advisor共通・唯一の記録入口）。resultsを渡すとlevel/targetは機械集約される（drift かつ target=implementing なら implementing に巻き戻し可能。target=design/requirementsは人間のhand-back待ち）。self-graded完了防止のため、resultsが空（=verifierを一度も呼んでいない）場合はエラーになる。graphhopper_verify の返り値 out.results をそのまま渡せる（呼び出し例: {"results":[{"lens":"agreement","level":"clean"}],"reason":"要約1〜3文"}）。キーは results[].lens / results[].level / results[].target / results[].model / results[].severity / results[].prior / reason / model のみ',
    input: S.obj(
      {
        results: S.arrOf(
          S.obj(
            {
              lens: S.str("角度の id（graphhopper_verify の results の lens）"),
              level: S.enumOf(["clean", "drift"]),
              target: S.enumOf(["implementing", "design", "requirements"], "drift時の巻き戻し先（level=drift なら必須）。clean時は不要"),
              model: S.optStr("このlensを実行したモデル（deep時の上位モデル等。省略時はトップレベルmodel→config既定）"),
              prior: {
                type: "object",
                description: "前回の指摘の判定（持ち越した角度のみ）。{valid,invalid,unresolved}",
              },
              severity: {
                type: "object",
                description:
                  "重要度の件数（任意）。{must_fix,should_fix,nit,pre_existing}。判定は変えない観測値。数えられないなら省略（未申告）し、0 と書かない",
              },
            },
            ["lens", "level"],
          ),
          "graphhopper_verify が返した各角度の結果。今の diff の計画の角度を全部含むこと（足りなければ拒否）。level/targetの最終決定は機械集約（aggregateVerdicts）で行う",
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
      // 検証した差分の指紋（stash 時点。無ければ現在の全文 diff）
      const baseline = await state.resolveBaseline($, root, active?.state ?? null);
      const diffHash =
        state.getStashDiffHash(root) ??
        (await state.computeDiffHash($, root, baseline));
      const savedPlan = active ? state.readSavedVerify(root, active.goal.id)?.plan ?? null : null;
      const rejected = state.checkVerifierResults(results, { plan: savedPlan, diffHash });
      if (rejected) throw new Error(rejected.replace(/^error:\s*/, ""));
      const decided = state.aggregateVerdicts(results);
      const severityEntries = state.collectSeverity(results);
      const result = state.setVerifierVerdict(root, {
        level: decided.level,
        reason: args.reason,
        target: decided.target,
        lens: results.map((r) => r.lens),
        angles: results.map((r) => ({
          lens: r.lens,
          level: r.level,
          ...(r.prior ? { prior: r.prior } : {}),
        })),
        model: args.model,
        models: results.map((r) => r.model ?? args.model ?? null),
        diff_hash: diffHash,
        severity: severityEntries,
      });
      /* severity の矛盾（clean なのに must-fix）は記録だけ（判定は変えない） */
      const sev = state.sumSeverity(severityEntries);
      if (decided.level === "clean" && sev.must_fix > 0 && active) {
        state.recordEvent(root, { type: "severity_inconsistent", goal: active.goal.id, must_fix: sev.must_fix });
      }
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
      "verifier を角度ごとに同期実行し、verifier_set にそのまま渡せる results を返す（記録はしない）。角度は、前の diff で drift だった角度の持ち越し＋選ぶ役（verifier 1 回）が選んだ角度＋常設の agreement で、計画として sidecar に保存される。add で角度を足せる（枠の外・1 つの diff につき 2 個まで）。1 巡目に drift があれば、同じ種類の問題を探す追い検証（siblings）を 1 回だけ続けて走らせる。前提: 同じ diff で graphhopper_diag → graphhopper_diff_stash を済ませておくこと（指紋が3つ揃わなければ throw）。判定を読めなかった角度は missing に入る（results が欠けるので進めない）。lens は計画のうち一部だけ走らせ直す指定、add は計画に角度を足す指定（同時に渡せる）",
    input: S.obj(
      {
        lens: S.arrOf(S.str("角度の id"), "実行する角度（計画の一部だけ走らせ直す。省略時は結果の無い角度すべて）"),
        add: S.arrOf(
          S.obj(
            {
              id: S.str("角度の id（小文字英数とハイフン、32 文字まで）"),
              title: S.optStr("題（一覧に無い新しい角度は必須）"),
              doubt: S.optStr("疑うこと（一覧に無い新しい角度は必須）"),
              scope: S.optStr("見る範囲"),
            },
            ["id"],
          ),
          "計画に足す角度（枠の外。1 つの diff につき 2 個まで）",
        ),
        model: S.optStr("verifier のモデル上書き（provider/model）。config の model_allow/model_deny で検査される"),
        timeoutMs: S.num("角度あたりの timeout ms（既定300000・上限600000）"),
        delayMs: S.num("起動ずらしの間隔 ms（既定5000。claude-oauth の単一プロキシ対策）"),
      },
      [],
    ),
    output: S.obj(
      {
        results: S.arrOf(
          S.obj(
            {
              lens: S.str("角度の id"),
              level: S.enumOf(["clean", "drift"]),
              target: S.enumOf(["implementing", "design", "requirements"]),
              model: S.str("その角度を実行したモデル"),
              severity: { type: "object", description: "重要度の件数（verifier が申告したときだけ）" },
              prior: { type: "object", description: "前回の指摘の判定（持ち越した角度のみ）。{valid,invalid,unresolved}" },
            },
            ["lens", "level"],
          ),
          "verifier_set にそのまま渡せる results",
        ),
        summaries: S.arrOf(
          S.obj({ lens: S.str("角度の id"), summary: S.str("その角度の判定要約") }, ["lens", "summary"]),
        ),
        bodies: S.arrOf(
          S.obj({ lens: S.str("角度の id"), body: S.str("drift・判定不能だった角度の本文") }, ["lens", "body"]),
          "drift と missing の角度だけ（clean の本文は含めない）",
        ),
        missing: S.arrOf(
          S.obj(
            { lens: S.str("角度の id"), reason: S.str("読めなかった理由") },
            ["lens", "reason"],
          ),
          "判定を読めなかった角度（空でなければ verifier_set に進まない）",
        ),
        lenses: S.arrOf(S.str("角度の id"), "今回の計画（agreement を含む）"),
        diff_hash: S.str("検証した diff の指紋（verifier_set が記録する値）"),
      },
      ["results", "summaries", "bodies", "missing", "lenses", "diff_hash"],
    ),
    execute: async (input: unknown, context: unknown) => {
      const args = input as {
        lens?: string[];
        add?: AddInput[];
        model?: string;
        timeoutMs?: number;
        delayMs?: number;
      };
      const active = state.getActive(root);
      if (!active) throw new Error("no active goal");
      const goalId = active.goal.id;
      /* 採点基準の改ざんは検証を止める（design g-mwmnvx3x 判断1）。
       * 採点コード/system prompt の変更は記録だけ（complete のゲートで扱う） */
      if (active.state.rubric_hash) {
        const rs = rubricStatus(root, goalId, active.state.rubric_hash);
        if (!rs.frozen || rs.tampered) {
          throw new Error(
            "rubric_tampered: 採点基準の凍結ファイルが無い／内容が開始時と違います。" +
              "採点基準を戻すか、新しい goal でやり直してください（verify に force は無い）",
          );
        }
        if (rs.changed) state.recordEvent(root, { type: "rubric_changed", goal: goalId });
        if (rs.selfModified) {
          state.recordEvent(root, {
            type: "verifier_self_modified",
            goal: goalId,
            code: rs.codeChanged,
            agent: rs.agentChanged,
          });
        }
      }
      const slots = angleSlots({
        route: active.state.router.route,
        difficulty: active.state.difficulty,
      });

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
      const timeout = args.timeoutMs ?? ANGLE_TIMEOUT_MS;
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
      const notes: string[] = [];

      const runAngle = async (
        entry: PlanEntry,
        i: number,
        timeoutMs: number,
        extra: { priorPath?: string | null; findingsPath?: string | null },
      ): Promise<LensRun> => {
        const prompt = buildAnglePrompt(root, goalId, entry, { ...paths, ...extra });
        const r = await invokeStructured(
          { agent: "graphhopper-verifier", model: args.model, prompt, root, timeoutMs, delayMs: delay * i },
          undefined,
          { signal },
        );
        const lens = entry.id;
        const broken = (reason: string): LensRun => ({ lens, body: r.output, reason });
        if (r.cancelled) return broken("invoke がキャンセルされた");
        if (r.timedOut) return broken(`timeout（${(r.elapsedMs / 1000).toFixed(1)}s / 上限 ${(timeoutMs / 1000).toFixed(0)}s）`);
        if (r.fallbackWarning) return broken("agent が既定にフォールバックした（判定を採用できない）");
        const failed = invokeFailure(r.output);
        if (failed) return broken(failed);
        const parsed = parseLensVerdict(r.output);
        if (!parsed.ok) return broken(parsed.reason);
        if (entry.carried && !parsed.verdict.prior) {
          return broken("出力の形の違反: 持ち越した角度なのに prior が無い（呼び直すと再実行する）");
        }
        return {
          lens,
          level: parsed.verdict.level,
          ...(parsed.verdict.target ? { target: parsed.verdict.target } : {}),
          summary: parsed.verdict.summary,
          ...(parsed.verdict.severity ? { severity: parsed.verdict.severity } : {}),
          ...(parsed.verdict.prior ? { prior: parsed.verdict.prior } : {}),
          body: r.output,
        };
      };
      const toSaved = (x: LensRun): state.SavedLensResult => ({
        lens: x.lens,
        level: x.level as state.VerdictLevel,
        ...(x.target ? { target: x.target as state.DriftTarget } : {}),
        ...(modelName ? { model: modelName } : {}),
        ...(x.severity ? { severity: x.severity } : {}),
        ...(x.prior ? { prior: x.prior } : {}),
        ...(x.level === "drift" ? { body: x.body.slice(0, 6000) } : {}),
        summary: x.summary ?? "",
      });

      /* 1. 計画（同じ diff の保存済みがあればそれを使う。無ければ持ち越し→選ぶ役） */
      const saved = state.readSavedVerify(root, goalId);
      let plan: AnglePlan;
      let results: state.SavedLensResult[];
      if (saved && saved.diff_hash === current && saved.plan) {
        plan = saved.plan;
        results = saved.results;
      } else {
        const carried = carryOver(saved?.plan ?? null, saved?.results ?? []);
        const drifts = (saved?.results ?? []).filter((r) => r.level === "drift" && r.body);
        /* 判定が出ないまま持ち越す角度があれば、その指摘は前の prior.md にしか無いので残す */
        const pending = carried.some((e) => !(saved?.results ?? []).some((r) => r.lens === e.id));
        const oldPrior = state.priorFindingsPath(root, goalId);
        const kept = pending && existsSync(oldPrior) ? [readFileSync(oldPrior, "utf8")] : [];
        state.writePriorFindings(
          root,
          goalId,
          carried.length > 0
            ? [...kept, ...drifts.map((r) => `## ${r.lens}\n${r.body}`)].join("\n\n")
            : null,
        );
        plan = initialPlan(current, carried);
        results = [];
        if (remainingSlots(plan, slots) > 0) {
          const sel = await invokeStructured(
            {
              agent: "graphhopper-verifier",
              model: args.model,
              prompt: buildSelectorPrompt({
                designPath: paths.designPath,
                diffPath: paths.diffPath,
                slots: remainingSlots(plan, slots),
                taken: plan.entries.map((e) => e.id),
              }),
              root,
              timeoutMs: SELECTOR_TIMEOUT_MS,
            },
            undefined,
            { signal },
          );
          let reason = "";
          if (sel.cancelled) reason = "invoke がキャンセルされた";
          else if (sel.timedOut) reason = `timeout (${SELECTOR_TIMEOUT_MS}ms)`;
          else if (sel.fallbackWarning) reason = "agent が既定にフォールバックした";
          else reason = invokeFailure(sel.output) ?? "";
          let picked = false;
          if (!reason) {
            const parsed = parseSelection(extractJsonBlock(sel.output), remainingSlots(plan, slots));
            if (parsed.ok) {
              plan = applyPicks(plan, parsed.picks, slots);
              picked = true;
            } else reason = parsed.reason;
          }
          if (!picked) {
            plan = applyDefaults(plan, slots);
            state.recordEvent(root, { type: "angle_select_failed", goal: goalId, reason });
            notes.push(`選ぶ役が失敗し（${reason}）、既定の角度で検証した`);
          }
        }
        state.recordEvent(root, {
          type: "angles_selected",
          goal: goalId,
          angles: plan.entries.map((e) => ({ id: e.id, source: e.source, carried: e.carried })),
        });
        state.writeSavedVerify(root, goalId, { v: 2, diff_hash: current, plan, results });
      }

      /* diff トリガ付きチェック（refs/checks.md）。選ぶ役の判断に依らず、当たった確認は必ず走らせる。
       * 読めない・壊れている場合は verify を止めない（fail-open） */
      try {
        const checksFile = join(root, CHECKS_PATH);
        if (existsSync(checksFile)) {
          const matched = matchChecks(
            readFileSync(paths.diffPath, "utf8"),
            parseChecks(readFileSync(checksFile, "utf8")),
          );
          const fresh = checkEntries(matched);
          const added = fresh.filter((e) => !plan.entries.some((p) => p.id === e.id));
          if (added.length > 0) {
            plan = applyChecks(plan, added);
            notes.push(`トリガ付きチェック: ${added.map((e) => e.id).join(", ")}（必ず実行）`);
            state.writeSavedVerify(root, goalId, { v: 2, diff_hash: current, plan, results });
          }
        }
      } catch {
        // チェック一覧の読み込み失敗で verify を止めない
      }

      /* 2. メインの add（枠の外。エラーなら何も足さない） */
      if (args.add?.length) {
        const added = applyAdds(plan, args.add);
        if (!added.ok) throw new Error(added.error);
        plan = added.plan;
        state.writeSavedVerify(root, goalId, { v: 2, diff_hash: current, plan, results });
      }

      /* 3. 1 巡目（結果の無い角度。lens 指定なら計画のうちその角度だけ） */
      const have = (id: string) => results.some((r) => r.lens === id);
      const requested = args.lens?.length ? args.lens : null;
      if (requested) {
        const unknown = requested.filter((id) => !plan.entries.some((e) => e.id === id));
        if (unknown.length) throw new Error(`lens に計画に無い角度があります: ${unknown.join(", ")}`);
      }
      const firstRound = firstRoundEntries(plan).filter((e) =>
        requested ? requested.includes(e.id) : !have(e.id),
      );
      const priorFile = state.priorFindingsPath(root, goalId);
      const priorPath = existsSync(priorFile) ? priorFile : null;
      const missing: { lens: string; reason: string }[] = [];
      const bodiesOf: { lens: string; body: string }[] = [];
      const merge = (runs: LensRun[]) => {
        for (const x of runs) {
          if (x.level === undefined) {
            missing.push({ lens: x.lens, reason: x.reason ?? "判定不能" });
            bodiesOf.push({ lens: x.lens, body: x.body.slice(0, 6000) });
          } else if (x.level === "drift") {
            bodiesOf.push({ lens: x.lens, body: x.body.slice(0, 6000) });
          }
        }
        const ok = runs.filter((x) => x.level !== undefined).map(toSaved);
        results = [...results.filter((r) => !ok.some((o) => o.lens === r.lens)), ...ok];
        state.writeSavedVerify(root, goalId, { v: 2, diff_hash: current, plan, results });
      };
      merge(
        await Promise.all(
          firstRound.map((e, i) => runAngle(e, i, timeout, { priorPath: e.carried ? priorPath : null })),
        ),
      );

      /* 4. 追い検証（siblings。1 回の呼び出しで 1 回だけ。結果が保存されたら走らない） */
      const planned = plan.entries.find((e) => e.id === SIBLINGS_ID);
      /* lens に siblings を指定したら（持ち越して計画にあるときだけ通る）走らせ直す */
      if (requested ? requested.includes(SIBLINGS_ID) : !have(SIBLINGS_ID)) {
        const seen = results.filter((r) => r.lens !== SIBLINGS_ID).map((r) => ({ lens: r.lens, level: r.level }));
        if (needsFollowup(plan, seen)) {
          const drifts = results.filter((r) => r.level === "drift" && r.body && r.lens !== SIBLINGS_ID);
          const findings = drifts.length
            ? state.writeFindings(root, goalId, drifts.map((r) => `## ${r.lens}\n${r.body}`).join("\n\n"))
            : null;
          const entry: PlanEntry = planned ?? { ...SIBLINGS, source: "followup", carried: false };
          const run = await runAngle(entry, 0, FOLLOWUP_TIMEOUT_MS, {
            findingsPath: findings,
            priorPath: entry.carried ? priorPath : null,
          });
          state.recordEvent(root, {
            type: "angle_followup",
            goal: goalId,
            carried: !!planned,
            level: run?.level ?? "unknown",
          });
          if (run) {
            if (planned) merge([run]);
            else if (run.level === undefined) notes.push(`追い検証は判定不能（${run.reason ?? ""}）。呼び直すともう一度走る`);
            else merge([run]);
          }
        }
      }

      /* 5. 計画に対して結果が無い角度は missing（追い検証だけの siblings は必須ではない） */
      for (const e of plan.entries) {
        if (!have(e.id) && !missing.some((m) => m.lens === e.id)) {
          missing.push({ lens: e.id, reason: "この diff ではまだ判定が無い（再実行せよ）" });
        }
      }

      const shown = results.filter((r) => plan.entries.some((e) => e.id === r.lens) || r.lens === SIBLINGS_ID);
      return structured(
        {
          results: shown.map((r) => ({
            lens: r.lens,
            level: r.level,
            ...(r.target ? { target: r.target } : {}),
            ...(r.model ? { model: r.model } : {}),
            ...(r.severity ? { severity: r.severity } : {}),
            ...(r.prior ? { prior: r.prior } : {}),
          })),
          summaries: shown.map((r) => ({ lens: r.lens, summary: r.summary })),
          bodies: bodiesOf,
          missing,
          lenses: plan.entries.map((e) => e.id),
          diff_hash: current,
        },
        [
          ...notes,
          missing.length
            ? `verify: 判定不能 ${missing.map((m) => `${m.lens}(${m.reason})`).join(", ")} — 記録せずに止まる`
            : `verify: ${shown.map((r) => `${r.lens}=${r.level}`).join(", ")}（次: verifier_set に results を渡す）`,
        ].join("\n"),
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
          const stuckNote = state.stuckResumeNote(r.state.guard);
          resumeNote = `resumed: "${r.goal.title}" (${r.goal.id}) / phase: ${r.state.phase}` +
            (stuckNote ? `\n${stuckNote}` : "");
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
            `次のアクション: ${a2 ? PHASE_ACTION[a2.state.phase] : "-"}`,
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
      "別モデルでsubagent相当を実行する。opencode run をspawnし stdout を返す。入れ子禁止・prompt上限12000文字・timeout既定120s（advisor/oracleは240s）・上限600s。依頼文の先頭に持ち時間と「渡された範囲だけ読み時間内に答える」を自動で足す。並列fan-out可。delayMsで起動ずらし可（429 herd回避）",
    input: S.obj(
      {
        agent: S.str("graphhopper-* agent名（例: graphhopper-advisor）"),
        model: S.optStr("provider/model形式。省略時はconfig既定。configのmodel_allow/model_denyで拒否される場合がある"),
        prompt: S.str("lens指示＋渡し物全文（12000文字まで）"),
        timeoutMs: S.num("タイムアウトms（既定120000。advisor/oracle は 240000・上限600000）"),
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
      const act = state.getActive(root);
      if (act) {
        try {
          state.recordEvent(root, {
            type: "invoke",
            goal: act.goal.id,
            agent: a.agent,
            model: a.model ?? null,
            timed_out: !!r.timedOut,
            cancelled: !!r.cancelled,
            elapsed_ms: r.elapsedMs,
          });
        } catch {
          // 履歴の失敗で相談結果を失わない
        }
      }
      const elapsedS = (r.elapsedMs / 1000).toFixed(1);
      const flags = [
        /* 時間切れは経過秒数も返す（上限の見直しと較正のため） */
        r.timedOut ? `timedOut ${elapsedS}s` : null,
        r.cancelled ? `cancelled ${elapsedS}s` : null,
        r.fallbackWarning ? "fallbackWarning" : null,
      ].filter(Boolean);
      return text(flags.length ? `${r.output}\n[invoke: ${flags.join(", ")}]` : r.output);
    },
  });
}
