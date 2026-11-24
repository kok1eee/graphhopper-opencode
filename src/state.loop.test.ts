/**
 * ループ検知（echo + 同一tool call反復）・累積loop停止カウンタの単体テスト。
 * bun test で実行する: `bun test src/state.loop.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillCompliantDesign } from "./design-fixture";
import {
  type GraphhopperConfig,
  type SessionMessageLike,
  CONTINUATION_MARKER,
  aggregateVerdicts,
  archiveGoalFiles,
  canonicalJSON,
  checkStuck,
  checkVerifierResults,
  clearActiveGoal,
  continuationFingerprint,
  detectLoopKind,
  isDesignDocLocked,
  isDesignGateBlocked,
  isEchoMessage,
  isHumanTextPart,
  isLegalPhaseTransition,
  isResumeBlocked,
  isToolRepeatLoop,
  isValidBaselineRev,
  fnv1a,
  lastHumanId,
  nextDiffStall,
  nextEditStreak,
  noteDiffLines,
  noteEdit,
  noteStuckNotified,
  measureDiffLines,
  noteContinuation,
  noteEvalFingerprint,
  parseDiffShortstat,
  pauseGoal,
  readConfig,
  readDiscover,
  readJson,
  readGoals,
  noteGuard,
  readHistory,
  readState,
  recordAttempt,
  DEFAULT_GATES,
  recordEvent,
  resetLoopForClear,
  resumeGoal,
  setIntentPath,
  setEvalCmd,
  setPhase,
  setStartBaselineRev,
  setUsabilityVerdict,
  startDiscover,
  startGoal,
  stopLoopByPause,
  buildGoalSummary,
  buildTelemetry,
  recordEventBatch,
  toolCallHash,
  unreadableStateFiles,
  unreadableStateNotice,
} from "./state";

const CFG: GraphhopperConfig = {
  gates: DEFAULT_GATES,
  router_threshold_lines: 400,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
  stuck_threshold: 3,
  loop_stop_threshold: 6,
  loop_stop_max: 3,
  loop_tool_window: 8,
  loop_tool_repeat_threshold: 4,
  max_eval_fails: 6,
  verify_drift_max: 3,
  stuck_edit_repeat: 5,
  stuck_diff_stall: 4,
  loop_max_rounds: 50,
  loop_max_stalls: 3,
  loop_wait_limit_ms: 30 * 60_000,
  loop_restart_pause: true,
  lsp_servers: [],
  cascade: {
    enabled: false,
    baseline: "minimax/MiniMax-M3.1-Flash",
    escalate: "claude-oauth/claude-sonnet-5-5",
    escalate_on: ["hard"],
    fail_threshold: 2,
    agents: { apply: "always", quality: {} },
  },
};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-loop-test-"));
}

function msg(
  role: "user" | "assistant",
  text: string,
  synthetic = false,
): SessionMessageLike {
  return {
    info: { id: `${role}-${Math.random().toString(36).slice(2)}`, role },
    parts: [{ type: "text", text, synthetic }],
  };
}

function toolMsg(role: "user" | "assistant", call: Partial<SessionMessageLike["parts"][number]>): SessionMessageLike {
  return {
    info: { id: `${role}-${Math.random().toString(36).slice(2)}`, role },
    parts: [call as SessionMessageLike["parts"][number]],
  };
}

const completedTool = (callID: string, tool: string, input: unknown) => ({
  type: "tool",
  callID,
  tool,
  state: { status: "completed", input },
});

describe("isEchoMessage", () => {
  test("パターン1: 末尾=user・直前=assistant のミラー echo", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "実装完了、検証済み、再起動で有効です。"),
        msg("user", "実装完了、検証済み、再起動で有効です。"),
      ]),
    ).toBe(true);
  });

  test("パターン2: 自動継続ループ（末尾=assistant、echo user が[-3]と一致）", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("user", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
      ]),
    ).toBe(true);
  });

  test("パターン3: 連続assistant同一文（新規user入力後の繰り返し）", () => {
    // [-3]と[-1]が共にassistantで同一文。間のuserは新規入力（echoでない）。
    // パターン2（userがecho）とは別分岐のテスト
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("user", "別の作業をして"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
      ]),
    ).toBe(true);
  });

  test("通常会話は false", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "design を書きます。"),
        msg("user", "OK、進めて"),
        msg("assistant", "implementing に遷移しました。"),
      ]),
    ).toBe(false);
  });

  test("短い挨拶は false", () => {
    expect(isEchoMessage([msg("assistant", "👋"), msg("user", "👋")])).toBe(false);
  });

  test("synthetic の自動継続でもパターン2を検知する", () => {
    const body = "已实施完毕。等待新的实际作业指示。以上。";
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", body),
        msg("user", `${CONTINUATION_MARKER}\n続けよ`, true),
        msg("assistant", "次のタスクに進みます。"),
      ]),
    ).toBe(false); // 継続への応答が別文なら echo ではない
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", body),
        msg("user", `${CONTINUATION_MARKER}\n${body}`, true),
        msg("assistant", body),
      ]),
    ).toBe(true); // 継続への応答が直前の assistant の繰り返し
  });
});

describe("isToolRepeatLoop / toolCallHash", () => {
  const mkBash = (i: number) =>
    toolMsg("assistant", completedTool(`c${i}`, "bash", { command: "npm test" }));

  test("同一 tool+input の反復（4回）で検知", () => {
    const msgs = [
      msg("user", "実装して"),
      mkBash(1),
      mkBash(2),
      mkBash(3),
      mkBash(4),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(true);
  });

  test("callID 重複は dedupe して数える（同一callIDの多重状態が誤計上されない）", () => {
    // c1 は同一callIDで複数状態（completed/running）が現れる → 1件に数える。
    // 別入力の c2 も入れる。distinct は2件 < threshold4 → 検知しない
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("c2", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);

    // c1 を3回重複状態で出しても 1件（+c2）→ 検知しない（二重計上されないことの確認）
    const dupMany = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("c2", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(dupMany, CFG)).toBe(false);
  });

  test("pending/running は数えない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", { type: "tool", callID: "p1", tool: "bash", state: { status: "pending", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p2", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p3", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p4", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("input 欠損の tool 部品はスキップ", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", { type: "tool", callID: "x1", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x2", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x3", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x4", tool: "bash", state: { status: "completed" } }),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("異なる入力の tool call は検知しない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("d1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("d2", "bash", { command: "npm run build" })),
      toolMsg("assistant", completedTool("d3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("d4", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("人間の新規入力でバーストが切れる（正常な再利用は非検知）", () => {
    // 前ターンの同一 tool call は、人間入力が挟まるため判定に残らない
    const before = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("a1", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a2", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a3", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a4", "read", { path: "src/x.ts" })),
    ];
    const after = [
      msg("user", "方針変更: 別の場所を確認して"),
      toolMsg("assistant", completedTool("b1", "read", { path: "src/y.ts" })),
    ];
    expect(isToolRepeatLoop([...before, ...after], CFG)).toBe(false);
  });

  test("canonicalJSON はキー順に依存しない・fnv1a は同値で一致", () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });
});

describe("detectLoopKind", () => {
  test("echo のみで kind=echo", () => {
    const msgs = [
      msg("user", "実装を始めよう"),
      msg("assistant", "完了です。"),
      msg("user", "完了です。"),
    ];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("echo");
  });

  test("tool のみで kind=tool", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("tool");
  });

  test("echo と tool 両方で kind=echo+tool", () => {
    // 人間入力を挟まず、assistant が同一文 + 同一 tool call を4連続（退化ループの実構造）。
    // echo パターン3（[-3]/[-1] assistant 同一文）+ tool 反復（4件同一）を両方満たす
    const asstWithTool = (text: string, callID: string) => ({
      info: {
        id: `asst-${Math.random().toString(36).slice(2)}`,
        role: "assistant",
      } as const,
      parts: [
        { type: "text", text },
        completedTool(callID, "bash", { command: "npm test" }),
      ],
    });
    const msgs = [
      msg("user", "実装して"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e1"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e2"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e3"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e4"),
    ] as SessionMessageLike[];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("echo+tool");
  });

  test("echo 無効（loop_stop_threshold=0）でも tool 検知は生きる", () => {
    const cfg = { ...CFG, loop_stop_threshold: 0 };
    const echoMsgs = [
      msg("user", "実装を始めよう"),
      msg("assistant", "完了です。"),
      msg("user", "完了です。"),
    ];
    expect(detectLoopKind(echoMsgs, cfg).detected).toBe(false);

    const toolMsgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(toolMsgs, cfg).detected).toBe(true);
  });

  test("tool 無効（repeat_threshold<=1）なら tool 検知しない", () => {
    const cfg = { ...CFG, loop_tool_repeat_threshold: 1 };
    const toolMsgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(toolMsgs, cfg).detected).toBe(false);
  });
});

describe("累積loop停止カウンタ", () => {
  test("自動stopで+1、明示pauseでは増えない、clearで0", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");

    stopLoopByPause(root);
    expect(isResumeBlocked(root)).toBe(false); // 1/3

    stopLoopByPause(root);
    stopLoopByPause(root);
    expect(isResumeBlocked(root)).toBe(true); // 3/3

    // force resume でもカウンタは保持
    const r = resumeGoal(root, "sess1", true);
    expect(r).not.toBeNull();
    expect(isResumeBlocked(root)).toBe(true);

    // 明示 pause では増えない
    pauseGoal(root);
    expect(isResumeBlocked(root)).toBe(true);

    // clear でリセット
    resetLoopForClear(root);
    expect(isResumeBlocked(root)).toBe(false);
  });

  test("通常resumeはブロック時に拒否、forceで復帰", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    stopLoopByPause(root);
    stopLoopByPause(root);
    stopLoopByPause(root); // 3/3 → blocked

    expect(resumeGoal(root, "sess1")).toBeNull(); // blocked
    expect(resumeGoal(root, "sess1", true)).not.toBeNull(); // force
  });

  test("blocked前は通常resumeが通る", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    stopLoopByPause(root); // 1/3
    expect(resumeGoal(root, "sess1")).not.toBeNull();
  });
});

describe("継続注入dedupe", () => {
  const contMsg = (id: string): SessionMessageLike => ({
    info: { id, role: "user" },
    parts: [{ type: "text", text: `${CONTINUATION_MARKER}\n[graphhopper] Goal: x` }],
  });

  test("自前の継続注入は人間入力扱いしない", () => {
    expect(isHumanTextPart({ type: "text", text: `${CONTINUATION_MARKER} foo` })).toBe(false);
    expect(isHumanTextPart({ type: "text", text: "実装して" })).toBe(true);
    expect(isHumanTextPart({ type: "text", text: "実装して", synthetic: true })).toBe(false);
    expect(isHumanTextPart({ type: "text", text: "[graphhopper] eval_cmd が 6 回連続失敗" })).toBe(false);
    expect(isHumanTextPart({ type: "text", text: "[graphhopper] 無限ループを検知" })).toBe(false);
  });

  test("待機ackの言い換えだけではフィンガープリントが変わらない", () => {
    const base = [msg("user", "実装して"), msg("assistant", "了解、進めます")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    // 注入 → 言い換え待機ack → idle: ack文面が変わっても進展なし
    const after = [...base, contMsg("c1"), msg("assistant", "明示の合図があるまで待機します")];
    const m2 = continuationFingerprint(after, "implementing", null, null);
    expect(m2).toBe(m1);
  });

  test("tool実行・人間入力・phase変化ではフィンガープリントが変わる", () => {
    const base = [msg("user", "実装して"), msg("assistant", "了解")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    // tool 実行あり
    const withTool = [...base, toolMsg("assistant", completedTool("t1", "read", { path: "a.ts" }))];
    expect(continuationFingerprint(withTool, "implementing", null, null)).not.toBe(m1);
    // 人間入力あり
    const withHuman = [...base, msg("user", "続けて")];
    expect(continuationFingerprint(withHuman, "implementing", null, null)).not.toBe(m1);
    // phase 変化
    expect(continuationFingerprint(base, "polish", null, null)).not.toBe(m1);
    // eval 結果変化
    expect(continuationFingerprint(base, "implementing", "npm test", "false:abc")).not.toBe(
      continuationFingerprint(base, "implementing", "npm test", "true:def"),
    );
  });

  test("自前注入をまたいでもtool反復検知のウィンドウが切れない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      contMsg("c1"),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      contMsg("c2"),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      contMsg("c3"),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(msgs, CFG).detected).toBe(true);
  });

  test("noteContinuation/noteEvalFingerprintの往復", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    expect(readState(root).last_continuation_marker).toBeNull();
    noteContinuation(root, "marker1");
    expect(readState(root).last_continuation_marker).toBe("marker1");
    noteEvalFingerprint(root, "false:abc");
    expect(readState(root).last_eval_fingerprint).toBe("false:abc");
  });

  test("lastHumanId: 自前注入を飛ばして人間のidを返す・無ければnull", () => {
    const human = msg("user", "実装して");
    const humanId = human.info.id;
    const msgs = [
      human,
      msg("assistant", "了解"),
      {
        info: { id: "c1", role: "user" },
        parts: [{ type: "text", text: `${CONTINUATION_MARKER}\nfoo` }],
      } as SessionMessageLike,
    ];
    expect(lastHumanId(msgs)).toBe(humanId);
    expect(
      lastHumanId([
        msg("assistant", "待機します"),
        msg("assistant", "待機しています"),
      ]),
    ).toBeNull();
  });

  test("スライドウィンドウ下でも注入1往復でfingerprint不変（ID化の回帰）", () => {
    // deny/ack 空転: 人間アンカーが窓内にいる間は、注入前後で人間id・
    // tool件数ともに不変のはず。旧実装（配列インデックス）ではウィンドウが
    // 2件スライドして不一致になり毎 idle 再注入した
    const base = [msg("user", "実装して"), msg("assistant", "了解、進めます")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    const after = [...base, contMsg("c1"), msg("assistant", "待機します")];
    expect(continuationFingerprint(after, "implementing", null, null)).toBe(
      m1,
    );
  });

  test("人間が窓外に出ると一度だけ変化し以後安定する", () => {
    // 実運用のスライド（先頭脱落）を再現: アンカー喪失の遷移は1回、
    // その後のack追加では不変でなければならない
    const full = [
      msg("user", "実装して"),
      msg("assistant", "了解"),
      contMsg("c1"),
      msg("assistant", "待機します"),
    ];
    const mFull = continuationFingerprint(full, "implementing", null, null);
    const slid = full.slice(2);
    const mSlid = continuationFingerprint(slid, "implementing", null, null);
    expect(mSlid).not.toBe(mFull);
    const more = [
      ...slid,
      contMsg("c2"),
      msg("assistant", "待機しています"),
    ];
    expect(continuationFingerprint(more, "implementing", null, null)).toBe(
      mSlid,
    );
  });

  test("tool件数は窓内アンカー以降のみ数えスライド後は安定する", () => {
    const t1 = toolMsg(
      "assistant",
      completedTool("k1", "bash", { command: "a" }),
    );
    const t2 = toolMsg(
      "assistant",
      completedTool("k2", "bash", { command: "a" }),
    );
    const full = [msg("user", "せよ"), t1, msg("assistant", "中間"), t2];
    // full: h=U.id, t=2
    const mFull = continuationFingerprint(full, "implementing", null, null);
    // Uとt1が脱落 → h=null、窓内toolはt2のみ → 変化は一度だけ
    const slid = full.slice(2);
    const mSlid = continuationFingerprint(slid, "implementing", null, null);
    expect(mSlid).not.toBe(mFull);
    // 非tool ack追加では安定
    const more = [...slid, msg("assistant", "待機")];
    expect(continuationFingerprint(more, "implementing", null, null)).toBe(
      mSlid,
    );
    // 新規toolは進展として検知（変化する）
    const moreTool = [
      ...slid,
      toolMsg("assistant", completedTool("k3", "bash", { command: "b" })),
    ];
    expect(
      continuationFingerprint(moreTool, "implementing", null, null),
    ).not.toBe(mSlid);
  });
});

describe("回帰: diff統計パース (insert-only/delete-only)", () => {
  test("insert-only でも件数を返す（旧regexは両方必須で0に誤判定）", () => {
    expect(parseDiffShortstat(" 1 file changed, 3 insertions(+)")).toBe(3);
  });

  test("delete-only でも件数を返す", () => {
    expect(parseDiffShortstat(" 1 file changed, 2 deletions(-)")).toBe(2);
  });

  test("両方あれば合算", () => {
    expect(
      parseDiffShortstat(" 2 files changed, 10 insertions(+), 5 deletions(-)"),
    ).toBe(15);
  });

  test("件数なしは null（呼び出し側で0扱い・fallback）", () => {
    expect(parseDiffShortstat("")).toBeNull();
    expect(parseDiffShortstat(" 1 file changed")).toBeNull();
  });
});

describe("回帰: baseline検証", () => {
  test("hex は許可", () => {
    expect(isValidBaselineRev("73222ed4")).toBe(true);
    expect(
      isValidBaselineRev(
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).toBe(true);
  });

  test("注入文字列・空白・空は拒否", () => {
    expect(isValidBaselineRev("x; rm -rf /")).toBe(false);
    expect(isValidBaselineRev("abc def")).toBe(false);
    expect(isValidBaselineRev("")).toBe(false);
    expect(isValidBaselineRev("HEAD~1")).toBe(false);
  });

  test("不正 baseline の measureDiffLines は shell を呼ばず 0", async () => {
    const noShell = undefined as unknown as Parameters<
      typeof measureDiffLines
    >[0];
    await expect(
      measureDiffLines(noShell, tmpRoot(), "x; rm -rf /"),
    ).resolves.toBe(0);
    await expect(measureDiffLines(noShell, tmpRoot(), null)).resolves.toBe(
      0,
    );
  });
});

describe("回帰: design gate の path 判定", () => {
  const root = "/repo";

  test("plans 配下の相対・絶対パスは許可", () => {
    expect(
      isDesignGateBlocked(root, CFG, "designing", ".graphhopper/plans/g-x.md"),
    ).toBe(false);
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "/repo/.graphhopper/plans/g-x.md",
      ),
    ).toBe(false);
  });

  test("source は拒否・designing以外は素通り", () => {
    expect(
      isDesignGateBlocked(root, CFG, "designing", "src/index.ts"),
    ).toBe(true);
    expect(
      isDesignGateBlocked(root, CFG, "implementing", "src/index.ts"),
    ).toBe(false);
  });

  test("部分文字列の偽装は拒否（旧includesは許可していた）", () => {
    // 別ディレクトリ配下の同名パス
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "/tmp/.graphhopper/plans/evil.md",
      ),
    ).toBe(true);
    // 類似prefix
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "my.graphhopper/plans/x.md",
      ),
    ).toBe(true);
    // traversal で plans 外へ脱出
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        ".graphhopper/plans/../../src/x.ts",
      ),
    ).toBe(true);
  });

  test("design doc ロックは正規化後の完全一致・log は対象外", () => {
    const id = "g-abc123";
    expect(
      isDesignDocLocked(root, "polish", id, `.graphhopper/plans/${id}.md`),
    ).toBe(true);
    expect(
      isDesignDocLocked(
        root,
        "polish",
        id,
        `/repo/.graphhopper/plans/${id}.md`,
      ),
    ).toBe(true);
    expect(
      isDesignDocLocked(root, "polish", id, `.graphhopper/plans/${id}.log.md`),
    ).toBe(false);
    expect(
      isDesignDocLocked(
        root,
        "designing",
        id,
        `.graphhopper/plans/${id}.md`,
      ),
    ).toBe(false);
  });
});

describe("回帰: state 読み書きの堅牢化", () => {
  test("破損 phase は designing にフォールバック", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    const path = join(root, ".graphhopper", "state.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.phase = "bogus-phase";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(readState(root).phase).toBe("designing");
  });

  test("canonicalJSON は stringify不能入力で 'undefined' を返す", () => {
    expect(canonicalJSON(undefined)).toBe("undefined");
    expect(canonicalJSON(() => {})).toBe("undefined");
    expect(canonicalJSON({ b: 2, a: 1 })).toBe(canonicalJSON({ a: 1, b: 2 }));
  });

  /* 読めない状態ファイルを「goal なし」と区別し、上書きで goal を失わない（g-mwoernih） */
  describe("状態ファイルが読めないとき", () => {
    const BAD_GOALS = '{ "goals": [ {"id": "g-1"';

    test("壊れた goals.json は開始を拒否し、ファイルを書き換えない", () => {
      const root = tmpRoot();
      mkdirSync(join(root, ".graphhopper"), { recursive: true });
      const p = join(root, ".graphhopper", "goals.json");
      writeFileSync(p, BAD_GOALS, "utf8");
      expect(unreadableStateFiles(root)).toContain(p);
      expect(() => startGoal(root, "new goal", "s1")).toThrow(/cannot be parsed/);
      expect(readFileSync(p, "utf8")).toBe(BAD_GOALS);
    });

    test("壊れた state.json は上書きしない（goal と検証記録を残す）", () => {
      const root = tmpRoot();
      startGoal(root, "keeper", "s1");
      const p = join(root, ".graphhopper", "state.json");
      writeFileSync(p, "{ broken", "utf8");
      expect(unreadableStateNotice(root)).toContain("state.json");
      expect(() => setIntentPath(root, "/tmp/x.md")).toThrow(/cannot be parsed/);
      expect(readFileSync(p, "utf8")).toBe("{ broken");
      // goals.json は無事なので goal 自体は読める
      expect(readGoals(root).goals.map((g) => g.title)).toEqual(["keeper"]);
    });

    test("ファイルが無いのは「読めない」ではない（従来どおり開始できる）", () => {
      const root = tmpRoot();
      expect(unreadableStateFiles(root)).toEqual([]);
      expect(unreadableStateNotice(root)).toBeNull();
      expect(startGoal(root, "ok", "s1").goal.title).toBe("ok");
    });

    test("同じプロセスで一度読めていれば記憶値で書き込みを続ける", () => {
      const root = tmpRoot();
      startGoal(root, "memory", "s1");
      const p = join(root, ".graphhopper", "state.json");
      readState(root); // このプロセスで一度読む（記憶される）
      writeFileSync(p, "{ broken", "utf8");
      // 記憶があるので「読めない」とは扱わず、書き込みは通る（従来の保険）
      expect(unreadableStateFiles(root)).toEqual([]);
      expect(() => setIntentPath(root, "/tmp/memo.md")).not.toThrow();
      expect(readState(root).intent_path).toBe("/tmp/memo.md");
    });
  });
});

describe("config 2層解決（グローバル既定 → プロジェクト上書き）", () => {
  /** GRAPHHOPPER_CONFIG を差分ファイルに向けて readConfig を実行する（実ユーザー設定を読まない） */
  function withGlobal(json: object | null, fn: () => void): void {
    const prev = process.env.GRAPHHOPPER_CONFIG;
    const path = join(tmpRoot(), "global.json");
    if (json !== null) writeFileSync(path, JSON.stringify(json), "utf8");
    process.env.GRAPHHOPPER_CONFIG = path; // 未作成なら readJson が {} を返す
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    }
  }

  function withProject(root: string, cfg: object): void {
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify(cfg),
      "utf8",
    );
  }

  test("model_deny は和集合・model_allow は project 置き換え（design g-mw8qwiy6 判断2）", () => {
    withGlobal({ model_deny: ["a/*"], model_allow: ["a/*"] }, () => {
      const root = tmpRoot();
      withProject(root, { model_deny: ["b/*"], model_allow: ["b/*"] });
      const cfg = readConfig(root);
      // deny は禁止を単調に強くする（project の空配列で global を外せない）
      expect(cfg.model_deny).toEqual(["a/*", "b/*"]);
      // allow は和集合だと制限が緩むため、project が置き換える
      expect(cfg.model_allow).toEqual(["b/*"]);
    });
    withGlobal({ model_deny: ["a/*"] }, () => {
      const root = tmpRoot();
      withProject(root, { model_deny: [] });
      expect(readConfig(root).model_deny).toEqual(["a/*"]);
    });
  });

  test("cascade.phase_models は global と project をキー単位でマージし、空文字は捨てる", () => {
    withGlobal(
      { cascade: { phase_models: { designing: "g/opus", polish: "g/sonnet" } } },
      () => {
        const root = tmpRoot();
        withProject(root, { cascade: { enabled: true, phase_models: { polish: "p/x", implementing: " " } } });
        const pm = readConfig(root).cascade.phase_models;
        expect(pm).toEqual({ designing: "g/opus", polish: "p/x" });
      },
    );
  });

  test("プロジェクト設定が無ければグローバル既定が効く", () => {
    withGlobal({ agents: { "graphhopper-verifier": "zai/glm" }, stuck_threshold: 9 }, () => {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents["graphhopper-verifier"]).toBe("zai/glm");
      expect(cfg.stuck_threshold).toBe(9);
    });
  });

  test("プロジェクトは同名だけ上書きし、他はグローバルを継承する", () => {
    withGlobal(
      {
        agents: { "graphhopper-verifier": "global-v", "graphhopper-librarian": "global-c" },
        stuck_threshold: 9,
      },
      () => {
        const root = tmpRoot();
        withProject(root, { agents: { "graphhopper-verifier": "project-v" } });
        const cfg = readConfig(root);
        expect(cfg.agents["graphhopper-verifier"]).toBe("project-v");
        expect(cfg.agents["graphhopper-librarian"]).toBe("global-c");
        expect(cfg.stuck_threshold).toBe(9);
      },
    );
  });

  test("グローバル・プロジェクトとも無ければ DEFAULT にフォールバック", () => {
    withGlobal(null, () => {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents).toEqual({});
      // 既定は 2（oracle 相談を早める。CFG は明示設定の検証用フィクスチャ）
      expect(cfg.stuck_threshold).toBe(2);
    });
  });

  test("グローバル設定が壊れていても既定で動く（例外を投げない）", () => {
    const prev = process.env.GRAPHHOPPER_CONFIG;
    const path = join(tmpRoot(), "broken.json");
    writeFileSync(path, "{ not json", "utf8");
    process.env.GRAPHHOPPER_CONFIG = path;
    try {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents).toEqual({});
      expect(cfg.stuck_threshold).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    }
  });

  test("返却値の変更はキャッシュを汚染しない（readJson直結）", () => {
    const path = join(tmpRoot(), "alias.json");
    writeFileSync(path, JSON.stringify({ nested: { v: "v1" } }), "utf8");
    const a = readJson<{ nested: { v: string } }>(path, { nested: { v: "fb" } });
    a.nested.v = "MUTATED";
    writeFileSync(path, "{ not json", "utf8");
    // 壊れ読みは記憶値を返す。返却時の変更が記憶に波及していなければv1
    expect(readJson<{ nested: { v: string } }>(path, { nested: { v: "fb" } }).nested.v).toBe("v1");
  });

  test("書換え途中の壊れJSONは前回値を維持する（モデル欠落防止）", () => {
    const prev = process.env.GRAPHHOPPER_CONFIG;
    const path = join(tmpRoot(), "race.json");
    process.env.GRAPHHOPPER_CONFIG = path;
    try {
      writeFileSync(
        path,
        JSON.stringify({ agents: { "graphhopper-verifier": "v1" } }),
        "utf8",
      );
      expect(readConfig(tmpRoot()).agents["graphhopper-verifier"]).toBe("v1");
      writeFileSync(path, "{ not json", "utf8");
      expect(readConfig(tmpRoot()).agents["graphhopper-verifier"]).toBe("v1");
      writeFileSync(
        path,
        JSON.stringify({ agents: { "graphhopper-verifier": "v2" } }),
        "utf8",
      );
      expect(readConfig(tmpRoot()).agents["graphhopper-verifier"]).toBe("v2");
    } finally {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    }
  });
});

describe("回帰: clear は goal_complete を記録しない", () => {
  test("履歴汚染なし・goal は done・active は null", () => {
    const root = tmpRoot();
    const { goal } = startGoal(root, "test goal", "sess1");
    const cleared = clearActiveGoal(root);
    expect(cleared?.id).toBe(goal.id);

    const goals = readGoals(root);
    expect(goals.active).toBeNull();
    expect(goals.goals.find((g) => g.id === goal.id)?.status).toBe("done");

    const historyPath = join(root, ".graphhopper", "history.jsonl");
    const history = existsSync(historyPath)
      ? readFileSync(historyPath, "utf8")
      : "";
    expect(history).not.toContain("goal_complete");
    expect(readState(root).phase).toBe("designing");
  });
});

describe("evalリトライ上限 giveUp", () => {
  test("上限到達でgiveUp（escalateは先に発火）", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    let r = recordAttempt(root, false, "");
    expect(r.escalate).toBe(false); // fail_streak=1 < stuck_threshold=2
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(2);
    expect(r.escalate).toBe(true); // stuck_threshold=2（既定）
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(3);
    expect(r.escalate).toBe(true);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(5);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(6);
    expect(r.giveUp).toBe(true); // max_eval_fails=6
  });

  test("okでリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    const r = recordAttempt(root, true, "");
    expect(r.fail_streak).toBe(0);
    expect(r.escalate).toBe(false);
    expect(r.giveUp).toBe(false);
    expect(r.kept_progress).toBe(false);
  });

  /* 合否は eval が決める。自己申告の ok で詰まりを消せないようにする（design g-mwoiwjif 決めたこと7） */
  test("eval_cmd 設定中の自己申告 ok は fail_streak と停滞カウンタを戻さない", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    setEvalCmd(root, "make test");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    noteEdit(root, "src/a.ts");
    noteEdit(root, "src/a.ts");
    noteDiffLines(root, 10);
    noteDiffLines(root, 10);
    noteDiffLines(root, 10);
    const r = recordAttempt(root, true, "", { selfReported: true });
    expect(r.fail_streak).toBe(2);
    expect(r.kept_progress).toBe(true);
    const s = readState(root);
    expect(s.edit_streak).toBe(2);
    expect(s.diff_stall).toBe(2);
  });

  test("eval_cmd 設定中でも eval 経由の ok はリセットする", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    setEvalCmd(root, "make test");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    noteEdit(root, "src/a.ts");
    noteDiffLines(root, 10);
    noteDiffLines(root, 10);
    const r = recordAttempt(root, true, "");
    expect(r.fail_streak).toBe(0);
    expect(r.kept_progress).toBe(false);
    expect(readState(root).edit_streak).toBe(0);
    expect(readState(root).diff_stall).toBe(0);
  });

  test("eval_cmd が無ければ自己申告 ok は従来どおりリセットする", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "");
    noteEdit(root, "src/a.ts");
    const r = recordAttempt(root, true, "", { selfReported: true });
    expect(r.fail_streak).toBe(0);
    expect(r.kept_progress).toBe(false);
    expect(readState(root).edit_streak).toBe(0);
  });

  function rootWithConfig(cfg: object): string {
    const root = tmpRoot();
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify(cfg),
      "utf8",
    );
    startGoal(root, "test goal", "sess1");
    return root;
  }

  test("無効時(0以下)はgiveUpしない", () => {
    const root = rootWithConfig({ max_eval_fails: 0 });
    let r = recordAttempt(root, false, "");
    for (let i = 0; i < 9; i++) r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(10);
    expect(r.escalate).toBe(true);
    expect(r.giveUp).toBe(false);
  });

  test("クランプ: stuck 10 / max 6 → 実効10", () => {
    const root = rootWithConfig({ stuck_threshold: 10, max_eval_fails: 6 });
    let r = recordAttempt(root, false, "");
    for (let i = 0; i < 8; i++) r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(9);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(10);
    expect(r.giveUp).toBe(true);
  });

  test("resumeでfail_streakがリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    expect(readState(root).fail_streak).toBe(2);
    pauseGoal(root);
    resumeGoal(root, "sess1");
    expect(readState(root).fail_streak).toBe(0);
  });
});

const planOf = (diff_hash: string, ids: string[]) => ({
  diff_hash,
  entries: ids.map((id) => ({
    id,
    title: id,
    doubt: "d",
    scope: "s",
    source: "list" as const,
    carried: false,
  })),
});

describe("verifier集約 aggregateVerdicts / checkVerifierResults", () => {
  test("全clean → clean", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "clean" },
        { lens: "behavior", level: "clean" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "clean", target: null });
  });

  test("単一drift → drift", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "clean" },
        { lens: "behavior", level: "drift", target: "design" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "drift", target: "design" });
  });

  test("混在時はimplementingを優先", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "drift", target: "design" },
        { lens: "behavior", level: "drift", target: "implementing" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "drift", target: "implementing" });
  });

  test("advisor単発（general 1件）", () => {
    expect(
      aggregateVerdicts([{ lens: "general", level: "clean" }]),
    ).toEqual({ level: "clean", target: null });
    expect(
      aggregateVerdicts([
        { lens: "general", level: "drift", target: "requirements" },
      ]),
    ).toEqual({ level: "drift", target: "requirements" });
  });

  test("空配列は拒否", () => {
    expect(checkVerifierResults([])).toMatch(/^error/);
    expect(checkVerifierResults(null)).toMatch(/^error/);
    expect(checkVerifierResults(undefined)).toMatch(/^error/);
  });

  test("不正 id・重複・計画外は、計画があっても理由つきで拒否する", () => {
    const o = { plan: planOf("h", ["agreement"]), diffHash: "h" };
    expect(checkVerifierResults([{ lens: "Bad Id", level: "clean" }], o)).toMatch(/不正な lens/);
    expect(
      checkVerifierResults(
        [
          { lens: "agreement", level: "clean" },
          { lens: "agreement", level: "clean" },
        ],
        o,
      ),
    ).toMatch(/重複/);
    expect(
      checkVerifierResults(
        [
          { lens: "agreement", level: "clean" },
          { lens: "unknown", level: "clean" },
        ],
        o,
      ),
    ).toMatch(/計画に無い/);
  });

  test("driftのtarget無しは拒否・cleanは通る", () => {
    expect(
      checkVerifierResults([{ lens: "behavior", level: "drift" }]),
    ).toMatch(/^error/);
    expect(
      checkVerifierResults(
        [{ lens: "behavior", level: "drift", target: "implementing" }],
        { plan: planOf("h", ["behavior"]), diffHash: "h" },
      ),
    ).toBeNull();
    expect(
      checkVerifierResults([{ lens: "general", level: "clean" }], {
        plan: planOf("h", ["general"]),
        diffHash: "h",
      }),
    ).toBeNull();
  });

  test("計画なし・diff 指紋の不一致・未充足・計画外 id を拒否し、計画どおりなら通る", () => {
    const plan = planOf("h1", ["agreement", "wiring"]);
    const ok = [
      { lens: "agreement", level: "clean" },
      { lens: "wiring", level: "clean" },
    ] as Parameters<typeof checkVerifierResults>[0];
    expect(checkVerifierResults(ok, {})).toMatch(/計画がありません/);
    expect(checkVerifierResults(ok, { plan, diffHash: "h2" })).toMatch(/今の diff と違います/);
    expect(checkVerifierResults(ok!.slice(0, 1), { plan, diffHash: "h1" })).toMatch(/wiring/);
    expect(
      checkVerifierResults([...ok!, { lens: "other", level: "clean" }], { plan, diffHash: "h1" }),
    ).toMatch(/計画に無い/);
    expect(checkVerifierResults(ok, { plan, diffHash: "h1" })).toBeNull();
  });

  test("計画外の siblings は受け付ける。無くても通る", () => {
    const plan = planOf("h1", ["agreement"]);
    expect(
      checkVerifierResults(
        [
          { lens: "agreement", level: "clean" },
          { lens: "siblings", level: "clean" },
        ],
        { plan, diffHash: "h1" },
      ),
    ).toBeNull();
    expect(
      checkVerifierResults([{ lens: "agreement", level: "clean" }], { plan, diffHash: "h1" }),
    ).toBeNull();
  });
});

describe("stuck信号: 同一ファイル再編集", () => {
  test("同一連続で発火・別ファイルでリセット（純粋）", () => {
    let s = { file: null as string | null, streak: 0 };
    s = nextEditStreak(s, "src/a.ts");
    expect(s).toEqual({ file: "src/a.ts", streak: 1 });
    s = nextEditStreak(s, "src/a.ts");
    expect(s.streak).toBe(2);
    s = nextEditStreak(s, "src/b.ts");
    expect(s).toEqual({ file: "src/b.ts", streak: 1 });
  });

  test("noteEditで蓄積しcheckStuckが発火する", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    for (let i = 0; i < 4; i++) noteEdit(root, "src/a.ts");
    expect(checkStuck(root).escalate).toBe(false);
    noteEdit(root, "src/a.ts");
    const s = checkStuck(root);
    expect(s.escalate).toBe(true);
    expect(s.reasons.join(",")).toContain("edit_repeat(src/a.ts×5)");
  });

  test("eval pass（ok）でリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteEdit(root, "src/a.ts");
    noteEdit(root, "src/a.ts");
    recordAttempt(root, true, "");
    const st = readState(root);
    expect(st.edit_streak).toBe(0);
    expect(st.edit_file).toBeNull();
  });
});

describe("stuck信号: diff停滞", () => {
  test("同一行数で発火・変化でリセット（純粋）", () => {
    let s = { lines: null as number | null, stall: 0 };
    s = nextDiffStall(s, 10);
    expect(s).toEqual({ lines: 10, stall: 0 });
    s = nextDiffStall(s, 10);
    s = nextDiffStall(s, 10);
    expect(s.stall).toBe(2);
    s = nextDiffStall(s, 12);
    expect(s).toEqual({ lines: 12, stall: 0 });
    s = nextDiffStall(s, null);
    expect(s.stall).toBe(0);
  });

  test("noteDiffLinesで蓄積しcheckStuckが発火する", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteDiffLines(root, 100);
    for (let i = 0; i < 2; i++) noteDiffLines(root, 100);
    expect(checkStuck(root).escalate).toBe(false); // stall=2
    noteDiffLines(root, 100);
    expect(checkStuck(root).escalate).toBe(false); // stall=3
    noteDiffLines(root, 100);
    const s = checkStuck(root); // stall=4
    expect(s.escalate).toBe(true);
    expect(s.reasons.join(",")).toContain("diff_stall×4");
  });
});

describe("stuck集約と通知抑止", () => {
  test("信号なしではescalateしない", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    expect(checkStuck(root)).toEqual({ escalate: false, reasons: [] });
  });

  test("fail_streak単独ではcheckStuckは発火しない（recordAttempt側の責務）", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    // fail_streak=2 でも進捗停滞系が無ければ escalate しない
    expect(checkStuck(root)).toEqual({ escalate: false, reasons: [] });
  });

  test("同一理由の再通知はスキップ・変化で再通知", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    const reasons = ["edit_repeat(src/a.ts×5)"];
    expect(noteStuckNotified(root, reasons)).toBe(true);
    expect(noteStuckNotified(root, reasons)).toBe(false);
    expect(noteStuckNotified(root, [...reasons, "diff_stall×4"])).toBe(true);
  });

  test("historyにstuck_hintが記録される", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteStuckNotified(root, ["fail_streak=3"]);
    const history = readFileSync(
      join(root, ".graphhopper", "history.jsonl"),
      "utf8",
    );
    expect(history).toContain("stuck_hint");
  });

  test("無効時(stuck_edit_repeat<=1)は発火しない", () => {
    for (const v of [0, 1]) {
      const root = tmpRoot();
      mkdirSync(join(root, ".graphhopper"), { recursive: true });
      writeFileSync(
        join(root, ".graphhopper", "config.json"),
        JSON.stringify({ stuck_edit_repeat: v }),
        "utf8",
      );
      startGoal(root, "test goal", "sess1");
      for (let i = 0; i < 10; i++) noteEdit(root, "src/a.ts");
      expect(checkStuck(root).escalate).toBe(false);
    }
  });

  test("無効時(stuck_diff_stall<=1)は発火しない", () => {
    for (const v of [0, 1]) {
      const root = tmpRoot();
      mkdirSync(join(root, ".graphhopper"), { recursive: true });
      writeFileSync(
        join(root, ".graphhopper", "config.json"),
        JSON.stringify({ stuck_diff_stall: v }),
        "utf8",
      );
      startGoal(root, "test goal", "sess1");
      for (let i = 0; i < 10; i++) noteDiffLines(root, 100);
      expect(checkStuck(root).escalate).toBe(false);
    }
  });

  test("複数信号の同時発火でreasonsに両方入る", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    for (let i = 0; i < 5; i++) noteEdit(root, "src/a.ts");
    for (let i = 0; i < 5; i++) noteDiffLines(root, 100);
    const s = checkStuck(root);
    expect(s.escalate).toBe(true);
    expect(s.reasons.length).toBe(2);
  });

  test("測定不能時はlines保持・stallリセット", () => {
    expect(nextDiffStall({ lines: 10, stall: 3 }, null)).toEqual({
      lines: 10,
      stall: 0,
    });
  });
});

describe("遷移合法性（program-side flow gate）", () => {
  test("合法遷移表", () => {
    expect(isLegalPhaseTransition("designing", "implementing")).toBe(true);
    expect(isLegalPhaseTransition("implementing", "polish")).toBe(true);
    expect(isLegalPhaseTransition("polish", "implementing")).toBe(true);
    expect(isLegalPhaseTransition("polish", "done")).toBe(true);
    expect(isLegalPhaseTransition("designing", "designing")).toBe(true);
  });

  test("非法遷移（*→done直指定・逆行）は拒否", () => {
    expect(isLegalPhaseTransition("designing", "done")).toBe(false);
    expect(isLegalPhaseTransition("implementing", "done")).toBe(false);
    expect(isLegalPhaseTransition("done", "implementing")).toBe(false);
    expect(isLegalPhaseTransition("done", "designing")).toBe(false);
    // implementing/polish→designingはB→A昇格専用経路として許可（濫用はhistory監査）
    expect(isLegalPhaseTransition("implementing", "designing")).toBe(true);
    expect(isLegalPhaseTransition("polish", "designing")).toBe(true);
  });

  test("setPhaseは非法遷移を拒否する（done抜け穴封じ）", () => {
    const root = tmpRoot();
    startGoal(root, "t", "s");
    expect(setPhase(root, "done")).toBeNull();
    expect(setPhase(root, "polish")).toBeNull();
    expect(setPhase(root, "implementing")?.state.phase).toBe("implementing");
    expect(setPhase(root, "polish")?.state.phase).toBe("polish");
    expect(setPhase(root, "implementing")?.state.phase).toBe("implementing");
  });
});

describe("outbox（durable通知）", () => {
  test("curated種別のみ投下・高頻度は対象外", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    recordEvent(root, { type: "attempt", goal: g.id, ok: false, fail_streak: 1, note: "x" });
    recordEvent(root, { type: "goal_complete", goal: g.id });
    const files = readdirSync(join(root, ".graphhopper", "outbox"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("goal_complete");
  });

  test("readHistoryで読める", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    recordEvent(root, { type: "goal_complete", goal: g.id });
    const h = readHistory(root);
    expect(h.some((e) => e.type === "goal_complete")).toBe(true);
  });
});

describe("discover goal紐付け", () => {
  test("開始時点のactive goalが載る・lineageに載る", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const d = startDiscover(root, "t", "s");
    expect(d.goal_id).toBeNull();
    const d2 = startDiscover(root, "t2", "s2", g.id);
    expect(d2.goal_id).toBe(g.id);
    expect(readDiscover(root)?.goal_id).toBe(g.id);
    const { buildLineage } = await import("./state");
    expect(buildLineage(root).discover?.goal_id).toBe(g.id);
  });
});

describe("design scaffold＋構造ゲート", () => {
  test("startGoalで骨格が自動生成され、冪等（既存を壊さない）", async () => {
    const { scaffoldDesignDoc } = await import("./state");
    const { planPath } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "scaffold test", "s").goal;
    const p = planPath(root, g.id);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf8");
    expect(raw).toContain("## 決めたこと");
    expect(raw).toContain("## やらないこと");
    expect(raw).toContain("## 完了の確かめ方");
    writeFileSync(p, "# custom\n");
    expect(scaffoldDesignDoc(root, g.id, "t")).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("# custom\n");
  });

  test("checkPhaseMove: scaffold は止まり、埋めれば通り、見出しを削ると止まる", async () => {
    const { checkPhaseMove } = await import("./gate");
    const { planPath } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const scaffoldErr = checkPhaseMove(root, "implementing");
    expect(scaffoldErr).toContain("決定記録");
    fillCompliantDesign(root);
    expect(checkPhaseMove(root, "implementing")).toBeNull();
    writeFileSync(planPath(root, g.id), "# empty\n");
    expect(checkPhaseMove(root, "implementing")).toContain("見出しが無い");
  });

  test("旧形式の state（entry_route・critic_review など）が残っていても落ちない", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    const sp = join(root, ".graphhopper", "state.json");
    const st = JSON.parse(readFileSync(sp, "utf8"));
    Object.assign(st, {
      entry_route: "advised",
      escalated_at: "2026-01-01T00:00:00.000Z",
      critic_review: { level: "drift", reason: "x", at: "t" },
      advisor_consult: { summary: "x", at: "t" },
    });
    writeFileSync(sp, JSON.stringify(st));
    writeFileSync(join(root, ".graphhopper", "config.json"), JSON.stringify({ require_critic: true }));
    fillCompliantDesign(root);
    expect(s.getActive(root)).not.toBeNull();
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });

});

describe("評価機能（state層）", () => {
  test("verdict未指定modelはconfig既定で補完される", async () => {
    const { setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ agents: { "graphhopper-verifier": "m/v" } }),
    );
    const v = setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"] });
    expect(v.last_verifier?.model).toBe("m/v");
    const v2 = setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"], model: "x/y" });
    expect(v2.last_verifier?.model).toBe("x/y");
  });

  test("computeGoalScore式: 巻き戻し・fail・gate・追加roundで減点", async () => {
    const { computeGoalScore, setPhase, setVerifierVerdict, completeGoal } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    setPhase(root, "implementing");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    setPhase(root, "polish");
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"] });
    setPhase(root, "implementing");
    // rewinds=1, maxFail=2, gate=0, rounds=1 → 100-15-10-0-0=75
    expect(computeGoalScore(root, g.id)).toEqual({
      value: 75,
      breakdown: { rewinds: 1, maxFailStreak: 2, gateBlocks: 0, verifierRounds: 1 },
    });
    const done = completeGoal(root);
    expect(done?.goal.score?.value).toBe(75);
  });

  test("buildScoreboard集計（旧 lens 名の履歴も読める）", async () => {
    const { buildScoreboard, setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"], model: "m/a" });
    const sb = buildScoreboard(root);
    expect(sb.models).toContainEqual({ model: "m/a", role: "verifier", verdicts: 2, clean: 1, drift: 1, mixed: 0 });
    expect(sb.goals.length).toBe(1);
  });
});

describe("scoreboard hints（提案のみ・ガード付き）", () => {
  test("サンプル不足は判断保留・低scoreと多巻き戻しを指摘", async () => {
    const { buildScoreboard, setVerifierVerdict, completeGoal, setPhase, startGoal } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    let sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("データ不足"))).toBe(true);
    for (let i = 0; i < 5; i++) {
      setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    }
    sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("drift検出率"))).toBe(true);
    expect(sb.hints.some((h) => h.includes("データ不足"))).toBe(false);
    // 低score goal: rewind2 + fail2でscore<70を作る（100-30-10=60）
    setPhase(root, "implementing");
    setPhase(root, "polish");
    setPhase(root, "implementing");
    setPhase(root, "polish");
    setPhase(root, "implementing");
    setPhase(root, "polish");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    const done = completeGoal(root);
    expect(done?.goal.score?.value).toBeLessThan(70);
    sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("要振り返り"))).toBe(true);
    expect(sb.hints.some((h) => h.includes("巻き戻し2回"))).toBe(true);
    void g;
  });
});

describe("deep検知（RISK_PATHS×自goal差分）", () => {
  // bun $ 形の最小fake（template呼び→cwd→nothrow→quiet）。jj/gitで応答を分ける
  const fakeShell = (
    jj: { code: number; out: string },
    git: { code: number; out: string },
  ) =>
    ((strings: TemplateStringsArray) => {
      const cmd = strings.join(" ");
      const r = cmd.includes("jj diff")
        ? jj
        : cmd.includes("rev-parse --show-prefix")
          ? { code: 0, out: "" }
          : git;
      return {
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: r.code,
                stdout: { toString: () => r.out },
              }),
          }),
        }),
      };
    }) as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];

  test("detectDeepRisk: 自goalのrisk接触のみtrue", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    expect(s.detectDeepRisk(root, ["src/state.ts"], [])).toEqual({
      deep: true,
      reason: "risk files touched: src/state.ts",
    });
    // 初期脏れは除外
    expect(
      s.detectDeepRisk(root, ["src/state.ts"], ["src/state.ts"]),
    ).toEqual({ deep: false, reason: null });
    expect(s.detectDeepRisk(root, ["README.md"], [])).toEqual({
      deep: false,
      reason: null,
    });
    // legacy（初期集合null）はfalse
    expect(s.detectDeepRisk(root, ["src/state.ts"], null)).toEqual({
      deep: false,
      reason: null,
    });
    expect(s.detectDeepRisk(root, ["src/state.ts"], undefined)).toEqual({
      deep: false,
      reason: null,
    });
    // 正規化: 絶対パス・./prefix
    expect(s.detectDeepRisk(root, [join(root, "src/gate.ts")], []).deep).toBe(
      true,
    );
    expect(s.detectDeepRisk(root, ["./src/gate.ts"], []).deep).toBe(true);
  });

  test("measureChangedFiles: jj→git→空", async () => {
    const s = await import("./state");
    const noShell = undefined as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];
    expect(await s.measureChangedFiles(noShell, tmpRoot(), null)).toEqual([]);
    expect(await s.measureChangedFiles(noShell, tmpRoot(), "zzz")).toEqual([]);
    const jjOk = fakeShell(
      { code: 0, out: "src/state.ts\nREADME.md\n" },
      { code: 0, out: "" },
    );
    expect(await s.measureChangedFiles(jjOk, "/r", "abc123")).toEqual([
      "src/state.ts",
      "README.md",
    ]);
    const jjFail = fakeShell({ code: 1, out: "" }, { code: 0, out: "src/gate.ts\n" });
    expect(await s.measureChangedFiles(jjFail, "/r", "abc123")).toEqual([
      "src/gate.ts",
    ]);
    const both = fakeShell({ code: 1, out: "" }, { code: 1, out: "" });
    expect(await s.measureChangedFiles(both, "/r", "abc123")).toEqual([]);
  });

  test("snapshotInitialDiffFiles: 設定・null無視・pause/resume保持", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    const g1 = s.startGoal(root, "first", "s1").goal;
    expect(s.getActive(root)!.state.initial_diff_files).toBeNull();
    s.snapshotInitialDiffFiles(root, ["src/state.ts"]);
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
    s.snapshotInitialDiffFiles(root, null);
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
    s.pauseGoal(root);
    s.startGoal(root, "second", "s2");
    expect(s.getActive(root)!.state.initial_diff_files).toBeNull();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(root, ".graphhopper", "goals.json");
    const gj = JSON.parse(readFileSync(p, "utf8"));
    gj.active = g1.id;
    writeFileSync(p, JSON.stringify(gj));
    s.resumeGoal(root, "s1");
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
  });

  test("recordRouterCheckWithRisk: deep反映とhistory記録", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, []);
    const shell = fakeShell({ code: 0, out: "src/gate.ts\n" }, { code: 0, out: "" });
    const st = await s.recordRouterCheckWithRisk(shell, root, "abc123", 10, "advisor");
    expect(st.router.deep).toBe(true);
    expect(st.router.deep_reason).toContain("src/gate.ts");
    const ev = s
      .readHistory(root)
      .find((h) => h.type === "router_check");
    expect(ev?.deep).toBe(true);
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.snapshotInitialDiffFiles(root2, []);
    const shell2 = fakeShell({ code: 0, out: "README.md\n" }, { code: 0, out: "" });
    const st2 = await s.recordRouterCheckWithRisk(shell2, root2, "abc123", 5, "advisor");
    expect(st2.router.deep).toBe(false);
    expect(st2.router.deep_reason).toBeNull();
  });

  test("shell例外時はfail-open（deepなし）", async () => {
    const s = await import("./state");
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];
    expect(await s.measureChangedFiles(throwing, "/r", "abc123")).toEqual([]);
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, []);
    const st = await s.recordRouterCheckWithRisk(throwing, root, "abc123", 10, "advisor");
    expect(st.router.deep).toBe(false);
    expect(st.router.deep_reason).toBeNull();
  });
});

describe("混成帰属（per-lens model）", () => {
  test("checkVerifierResultsはmodelの型を検証する", async () => {
    const { checkVerifierResults } = await import("./state");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: 123 as unknown as string }]),
    ).toContain("model");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: "  " }]),
    ).toContain("model");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: "m/a" }], {
        plan: planOf("h", ["general"]),
        diffHash: "h",
      }),
    ).toBeNull();
  });

  test("setVerifierVerdictはmodelsをlens長に揃える", async () => {
    const { setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    const v = setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a"],
    });
    expect(v.last_verifier?.models).toEqual(["m/a", "m/a"]);
    const v2 = setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a", "m/b", "m/c"],
    });
    expect(v2.last_verifier?.models).toEqual(["m/a", "m/b"]);
  });

  test("混成runはdistinct modelに行bump＋hints注記", async () => {
    const { buildScoreboard, setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a", "m/b"],
    });
    const sb = buildScoreboard(root);
    expect(sb.models).toContainEqual({
      model: "m/a",
      role: "verifier",
      verdicts: 1,
      clean: 1,
      drift: 0,
      mixed: 1,
    });
    expect(sb.models).toContainEqual({
      model: "m/b",
      role: "verifier",
      verdicts: 1,
      clean: 1,
      drift: 0,
      mixed: 1,
    });
    expect(sb.hints.some((h) => h.includes("混成"))).toBe(true);
  });

  test("formatLensModelsは差分のみ表示", async () => {
    const { formatLensModels } = await import("./state");
    expect(
      formatLensModels(["behavior", "requirement"], ["m/b", "m/a"], "m/a"),
    ).toBe("behavior@m/b");
    expect(formatLensModels(["general"], ["m/a"], "m/a")).toBe("");
    expect(formatLensModels(["general"], undefined, "m/a")).toBe("");
  });
});

describe("pause/resumeスナップショット（goal切替の文脈漏れ対策）", () => {
  test("pauseで文脈保存→別goal走行→resumeで復帰", async () => {
    const { pauseGoal, resumeGoal, startGoal, setPhase, setEvalCmd, getActive } = await import("./state");
    const root = tmpRoot();
    const g1 = startGoal(root, "first", "s1").goal;
    setPhase(root, "implementing");
    setEvalCmd(root, "make test");
    pauseGoal(root);
    // 別goalが走る（stateは上書きされる）
    startGoal(root, "second", "s2");
    setPhase(root, "polish");
    // g1に戻す
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(root, ".graphhopper", "goals.json");
    const gj = JSON.parse(readFileSync(p, "utf8"));
    gj.active = g1.id;
    writeFileSync(p, JSON.stringify(gj));
    const r = resumeGoal(root, "s1");
    expect(r?.goal.id).toBe(g1.id);
    const a = getActive(root)!;
    expect(a.state.goal_id).toBe(g1.id);
    expect(a.state.phase).toBe("implementing");
    expect(a.state.eval_cmd).toBe("make test");
    expect(a.state.session_id).toBe("s1");
  });

  test("snapshot無しのresumeは現状維持（後方互換）", async () => {
    const { resumeGoal, startGoal, getActive } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    const r = resumeGoal(root, "s2");
    expect(r?.state.phase).toBe("designing");
    expect(getActive(root)?.state.session_id).toBe("s2");
  });
});

describe("stashDiff（verifier用diff退避）", () => {
  test("不正baselineはshellを呼ばずnull", async () => {
    const noShell = undefined as unknown as Parameters<
      typeof import("./state").stashDiff
    >[0];
    const { stashDiff } = await import("./state");
    await expect(stashDiff(noShell, tmpRoot(), "x; rm", "g-abc")).resolves.toBeNull();
    await expect(stashDiff(noShell, tmpRoot(), null, "g-abc")).resolves.toBeNull();
    await expect(stashDiff(noShell, tmpRoot(), "abc123", "bad id")).resolves.toBeNull();
  });

  test("実git repoで退避できる", async () => {
    const { stashDiff } = await import("./state");
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const rev = (await $`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.write(`${root}/a.txt`, "one\ntwo\n");
    const stashed = await stashDiff($, root, rev, "g-abc123");
    expect(stashed).not.toBeNull();
    expect(stashed!.lines).toBeGreaterThan(0);
    expect(stashed!.path).toContain("g-abc123");
    const { existsSync } = await import("node:fs");
    expect(existsSync(stashed!.path)).toBe(true);
  });

  test("computeDiffHash は全文diffのsha1を返し、変更で変わる（design g-mwd3n5bo）", async () => {
    const { computeDiffHash } = await import("./state");
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const rev = (await $`git -C ${root} rev-parse HEAD`.text()).trim();

    const empty = await computeDiffHash($, root, rev);
    expect(empty).not.toBeNull();
    await Bun.write(`${root}/a.txt`, "one\ntwo\n");
    const changed = await computeDiffHash($, root, rev);
    expect(changed).not.toBeNull();
    expect(changed).not.toBe(empty);
    // 同じ状態なら同じ（決定的）
    expect(await computeDiffHash($, root, rev)).toBe(changed);
    // baseline 不正は null（fail-open）
    expect(await computeDiffHash($, root, "x; rm")).toBeNull();
  });

  test("初期脏れを除外した実効diffだけ退避する", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    // name-only列＋per-file差分＋全文を振る舞い分けるfake
    const stashFake = (files: string[], perFile: Record<string, string>, full: string) =>
      ((strings: TemplateStringsArray, ...vals: unknown[]) => {
        const joined = strings.join("#");
        const ok = (out: string) => ({
          cwd: () => ({
            nothrow: () => ({
              quiet: () =>
                Promise.resolve({
                  exitCode: 0,
                  stdout: { toString: () => out },
                }),
            }),
          }),
        });
        if (joined.includes("rev-parse --show-prefix")) return ok("");
        if (joined.includes("--name-only")) return ok(files.join("\n") + "\n");
        if (vals.length >= 2) {
          // diffOneFile は root 基準の絶対パスを渡す（design g-mwiwxc5a 判断3）
          const f = String(vals[1]).split("/").pop() ?? "";
          return ok(perFile[f] ?? "");
        }
        return ok(full);
      }) as unknown as Shell;
    const shell = stashFake(
      ["old.txt", "new.txt"],
      { "old.txt": "OLD DIFF\n", "new.txt": "NEW DIFF\n" },
      "FULL DIFF\n",
    );
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, ["old.txt"]);
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(stashed!.path, "utf8");
    expect(body).toContain("NEW DIFF");
    expect(body).not.toContain("OLD DIFF");
    expect(body).not.toContain("FULL DIFF");
  });

  test("legacy（初期集合null）は全文退避に倒す", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    const shell = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const joined = strings.join("#");
      const ok = (out: string) => ({
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: 0,
                stdout: { toString: () => out },
              }),
          }),
        }),
      });
      if (joined.includes("--name-only"))
        return ok("old.txt\nnew.txt\n");
      const isFull = JSON.stringify(vals).includes("~cwd:");
      if (isFull) return ok("FULL DIFF\n");
      return ok("PER-FILE\n");
    }) as unknown as Shell;
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    // snapshotなし＝initial_diff_files null
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(stashed!.path, "utf8")).toContain("FULL DIFF");
  });

  test("自goal変更なし（全除外）は空退避", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    const shell = ((strings: TemplateStringsArray) => {
      const joined = strings.join("#");
      const ok = (out: string) => ({
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: 0,
                stdout: { toString: () => out },
              }),
          }),
        }),
      });
      if (joined.includes("--name-only")) return ok("old.txt\n");
      return ok("SHOULD NOT APPEAR\n");
    }) as unknown as Shell;
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, ["old.txt"]);
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    expect(stashed!.lines).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(stashed!.path, "utf8")).toBe("");
  });
});

describe("差分測定の .graphhopper/ 除外（design g-mwiu6lcj）", () => {
  /** .graphhopper/ を gitignore せず commit した repo（不具合の再現条件） */
  async function trackedGitRoot(): Promise<string> {
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".graphhopper", "plans"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "x\n");
    writeFileSync(join(root, ".graphhopper/history.jsonl"), "");
    writeFileSync(join(root, ".graphhopper/state.json"), "{}\n");
    writeFileSync(join(root, ".graphhopper/config.example.json"), "{}\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    return root;
  }

  async function headRev(root: string): Promise<string> {
    const { $ } = await import("bun");
    return (await $`git -C ${root} rev-parse HEAD`.text()).trim();
  }

  test("ghFileset / pathspec は .graphhopper を除き設定2つを残す", async () => {
    const s = await import("./state");
    expect(s.ghFileset()).toBe(
      '~cwd:".graphhopper" | cwd:".graphhopper/config.json" | cwd:".graphhopper/config.example.json"',
    );
    expect(s.ghAllSpec()).toEqual([":/", ":(exclude).graphhopper"]);
    expect(s.ghKeepSpec()).toEqual([
      ".graphhopper/config.json",
      ".graphhopper/config.example.json",
    ]);
  });

  test("computeDiffHash: 作業ファイルでは変わらず、ソースと設定では変わる", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const root = await trackedGitRoot();
    const rev = await headRev(root);
    writeFileSync(join(root, "src/a.ts"), "x\ny\n");
    const base = await s.computeDiffHash($, root, rev);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(root, ".graphhopper/history.jsonl"), "e1\n");
    writeFileSync(join(root, ".graphhopper/state.json"), '{"a":1}\n');
    writeFileSync(join(root, ".graphhopper/plans/g-1.log.md"), "note\n");
    expect(await s.computeDiffHash($, root, rev)).toBe(base);
    writeFileSync(join(root, ".graphhopper/config.example.json"), '{"m":1}\n');
    expect(await s.computeDiffHash($, root, rev)).not.toBe(base);
  });

  test("measureChangedFiles / measureDiffLines: 作業ファイルを数えない", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const root = await trackedGitRoot();
    const rev = await headRev(root);
    writeFileSync(join(root, "src/a.ts"), "x\ny\n");
    writeFileSync(join(root, ".graphhopper/config.example.json"), '{"m":1}\n');
    writeFileSync(join(root, ".graphhopper/history.jsonl"), "e1\n");
    writeFileSync(join(root, ".graphhopper/plans/g-1.log.md"), "note\n");
    const files = await s.measureChangedFiles($, root, rev);
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".graphhopper/config.example.json");
    expect(files.some((f) => f.includes("history.jsonl"))).toBe(false);
    expect(files.some((f) => f.includes("state.json"))).toBe(false);
    expect(files.some((f) => f.includes("plans/"))).toBe(false);
    const lines = await s.measureDiffLines($, root, rev);
    writeFileSync(join(root, ".graphhopper/history.jsonl"), Array(80).fill("x").join("\n") + "\n");
    expect(await s.measureDiffLines($, root, rev)).toBe(lines);
  });

  test("measureWorkingCopyLines: 作業ファイルの伸びを数えない", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const root = await trackedGitRoot();
    writeFileSync(join(root, "src/a.ts"), "x\ny\n");
    const before = await s.measureWorkingCopyLines($, root);
    expect(before).toBeGreaterThan(0);
    writeFileSync(join(root, ".graphhopper/history.jsonl"), Array(80).fill("y").join("\n") + "\n");
    expect(await s.measureWorkingCopyLines($, root)).toBe(before);
  });

  test("stashDiff を2回続けても退避に作業ファイルが入らない（全文・実効の両経路）", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const root = await trackedGitRoot();
    const rev = await headRev(root);
    s.startGoal(root, "t", "s1");
    writeFileSync(join(root, "src/a.ts"), "x\ny\n");
    writeFileSync(join(root, ".graphhopper/history.jsonl"), "e1\n");
    // 初期集合なし（legacy）→ 全文退避の経路
    const first = await s.stashDiff($, root, rev, "g-abc123");
    const b1 = readFileSync(first!.path, "utf8");
    expect(b1).toContain("src/a.ts");
    expect(b1).not.toContain("history.jsonl");
    const second = await s.stashDiff($, root, rev, "g-abc123");
    expect(readFileSync(second!.path, "utf8")).not.toContain("gh-verify-");
    // 初期集合あり（空）→ 実効diff（per-file）の経路
    s.snapshotInitialDiffFiles(root, []);
    const third = await s.stashDiff($, root, rev, "g-abc123");
    const b3 = readFileSync(third!.path, "utf8");
    expect(b3).toContain("src/a.ts");
    expect(b3).not.toContain("history.jsonl");
    expect(b3).not.toContain("gh-verify-");
  });

  test("fake: jj には fileset、git には全体と設定の2回を渡す", async () => {
    const s = await import("./state");
    const seen: unknown[][] = [];
    const shell = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const joined = strings.join(" ");
      const isJj = joined.includes("jj diff");
      const spec = vals[1];
      seen.push([joined.trim(), spec]);
      const out = isJj
        ? ""
        : Array.isArray(spec) && String(spec[0]).startsWith(":")
          ? "src/a.ts\n"
          : Array.isArray(spec)
            ? ".graphhopper/config.example.json\n"
            : "";
      return {
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: isJj ? 1 : 0,
                stdout: { toString: () => out },
              }),
          }),
        }),
      };
    }) as unknown as Parameters<typeof s.measureChangedFiles>[0];
    const files = await s.measureChangedFiles(shell, "/r", "abc123");
    expect(files).toEqual(["src/a.ts", ".graphhopper/config.example.json"]);
    const jjCall = seen.find(([cmd]) => String(cmd).includes("jj diff"));
    expect(JSON.stringify(jjCall?.[1])).toContain("~cwd:");
    expect(seen.some(([, spec]) => JSON.stringify(spec) === JSON.stringify(s.ghAllSpec()))).toBe(true);
    expect(seen.some(([, spec]) => JSON.stringify(spec) === JSON.stringify(s.ghKeepSpec()))).toBe(true);
  });
});

describe("差分測定の root がサブディレクトリ（design g-mwiwxc5a 判断3）", () => {
  async function subdirGitRoot(): Promise<{ repo: string; root: string; rev: string }> {
    const { $ } = await import("bun");
    const repo = mkdtempSync(join(tmpdir(), "gh-subdir-"));
    await $`git init -q ${repo}`.quiet();
    await $`git -C ${repo} config user.email t@t`.quiet();
    await $`git -C ${repo} config user.name t`.quiet();
    const root = join(repo, "proj");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/state.ts"), "x\n");
    writeFileSync(join(repo, "other.txt"), "o\n");
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -qm init`.quiet();
    const rev = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    return { repo, root, rev };
  }

  test("名前は root 相対で返り、deep 検出と diffOneFile が効く", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const { root, rev } = await subdirGitRoot();
    writeFileSync(join(root, "src/state.ts"), "x\ny\n");
    const files = await s.measureChangedFiles($, root, rev);
    expect(files).toEqual(["src/state.ts"]);
    expect(s.detectDeepRisk(root, files, []).deep).toBe(true);
    expect(await s.diffOneFile($, root, rev, "src/state.ts")).toContain("y");
  });

  test("stashDiff の実効 diff にサブディレクトリ root の変更が入る", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const { root, rev } = await subdirGitRoot();
    s.startGoal(root, "t", "s1");
    writeFileSync(join(root, "src/state.ts"), "x\ny\n");
    s.snapshotInitialDiffFiles(root, []);
    const st = await s.stashDiff($, root, rev, "g-abc123");
    expect(st).not.toBeNull();
    expect(readFileSync(st!.path, "utf8")).toContain("src/state.ts");
  });

  test("root 外の変更は ../ 付きで返り、diffOneFile が拾える", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const { repo, root, rev } = await subdirGitRoot();
    writeFileSync(join(repo, "other.txt"), "o\np\n");
    const files = await s.measureChangedFiles($, root, rev);
    expect(files).toContain("../other.txt");
    expect(await s.diffOneFile($, root, rev, "../other.txt")).toContain("p");
  });
});

const jjAvailable = (() => {
  try {
    return Bun.spawnSync(["jj", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

describe("差分測定の .graphhopper/ 除外（実 jj repo）", () => {
  test.skipIf(!jjAvailable)("作業ファイルを数えず、ソースの変更だけを拾う", async () => {
    const s = await import("./state");
    const { $ } = await import("bun");
    const root = mkdtempSync(join(tmpdir(), "gh-jj-test-"));
    await $`jj git init ${root}`.quiet();
    await $`jj config set --repo user.email t@t`.cwd(root).quiet();
    await $`jj config set --repo user.name t`.cwd(root).quiet();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "x\n");
    writeFileSync(join(root, ".graphhopper/history.jsonl"), "");
    await $`jj commit -m init`.cwd(root).quiet();
    const rev = (await $`jj log -r @- -T commit_id --no-graph`.cwd(root).text()).trim();
    writeFileSync(join(root, "src/a.ts"), "x\ny\n");
    const base = await s.computeDiffHash($, root, rev);
    writeFileSync(join(root, ".graphhopper/history.jsonl"), Array(50).fill("x").join("\n") + "\n");
    expect(await s.computeDiffHash($, root, rev)).toBe(base);
    const files = await s.measureChangedFiles($, root, rev);
    expect(files).toContain("src/a.ts");
    expect(files.some((f) => f.includes("history.jsonl"))).toBe(false);
  });
});

describe("退避diff掃除（complete/clear）", () => {
  test("completeGoal/clearActiveGoalでgh-verifyファイルが消える", async () => {
    const { removeStashedDiff, stashedDiffPath } = await import("./state");
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const place = (root: string, gid: string): string => {
      const p = stashedDiffPath(root, gid);
      // .graphhopper/tmp配下に配置されること（子権限で読めるrepo内）
      expect(p).toContain(join(".graphhopper", "tmp"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "diff\n", "utf8");
      return p;
    };
    const gid = `g-${Date.now().toString(36)}test`;
    // 不正idは無視（例外なし）
    expect(() => removeStashedDiff(tmpRoot(), "bad id")).not.toThrow();
    // 存在しないgoalの掃除も成功扱い
    expect(() => removeStashedDiff(tmpRoot(), gid)).not.toThrow();
    // 実ファイルが消えること
    const root = mkdtempSync(join(tmpdir(), "gh-clean-"));
    const { startGoal, completeGoal, clearActiveGoal } = await import("./state");
    startGoal(root, "t", "sClean");
    const { getActive } = await import("./state");
    const activeId = getActive(root)!.goal.id;
    const p1 = place(root, activeId);
    expect(existsSync(p1)).toBe(true);
    completeGoal(root);
    expect(existsSync(p1)).toBe(false);
    // clear側
    startGoal(root, "t2", "sClean2");
    const activeId2 = getActive(root)!.goal.id;
    const p2 = place(root, activeId2);
    clearActiveGoal(root);
    expect(existsSync(p2)).toBe(false);
  });
});

describe("初期脏れsnapshot（baseline誤認防止）", () => {
  test("同じミリ秒に 2 つ startGoal しても goal ID が衝突しない（design g-mwu1q953）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const a = s.startGoal(root, "a", "s1");
      const b = s.startGoal(root, "b", "s2");
      expect(a.goal.id).not.toBe(b.goal.id);
      const goals = s.readGoals(root);
      expect(goals.goals.map((g) => g.id).sort()).toEqual(
        [a.goal.id, b.goal.id].sort(),
      );
      expect(goals.active).toBe(b.goal.id);
    } finally {
      Date.now = realNow;
    }
  });

  test("effectiveDiffLines: 減算・floor・legacy", async () => {
    const s = await import("./state");
    expect(s.effectiveDiffLines(10, 3)).toBe(7);
    expect(s.effectiveDiffLines(2, 5)).toBe(0);
    expect(s.effectiveDiffLines(10, null)).toBe(10);
    expect(s.effectiveDiffLines(10, undefined)).toBe(10);
  });

  test("snapshotInitialDirt: 設定・不正値無視", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(s.getActive(root)!.state.initial_diff_lines).toBeNull();
    s.snapshotInitialDirt(root, 1349);
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(1349);
    s.snapshotInitialDirt(root, null);
    s.snapshotInitialDirt(root, -1);
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(1349);
  });

  test("pause/resumeで初期脏れが維持される", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDirt(root, 100);
    s.pauseGoal(root);
    s.startGoal(root, "other", "s2");
    s.pauseGoal(root);
    const goals = s.readGoals(root);
    const first = goals.goals.find((g) => g.title === "t")!;
    goals.active = first.id;
    first.status = "active";
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(
      join(root, ".graphhopper", "goals.json"),
      JSON.stringify(goals),
    );
    s.resumeGoal(root, "s1");
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(100);
  });
});

describe("goal_summary telemetry", () => {
  test("集計規則: last-write・rewinds・2round", () => {
    const root = tmpRoot();
    const gid = "g-test";
    recordEvent(root, { type: "goal_start", goal: gid, title: "t" });
    /* 旧形式の行（entry_route / escalated / critic_review_set）は読み飛ばされる */
    recordEvent(root, { type: "entry_route", goal: gid, route: "light", reason: "x" } as never);
    recordEvent(root, { type: "router_check", goal: gid, diff_lines: 100, route: "advisor" });
    recordEvent(root, { type: "router_check", goal: gid, diff_lines: 500, route: "polish" });
    recordEvent(root, {
      type: "verifier_verdict", goal: gid, level: "drift", target: "implementing", lens: ["requirement"],
    });
    recordEvent(root, {
      type: "verifier_verdict", goal: gid, level: "clean", target: null,
      lens: ["requirement", "behavior", "progress"],
    });
    recordEvent(root, { type: "phase", goal: gid, from: "polish", to: "implementing" });
    recordEvent(root, { type: "phase", goal: gid, from: "polish", to: "implementing" });
    recordEvent(root, { type: "escalated", goal: gid, from: "light", at: "now" } as never);
    recordEvent(root, { type: "critic_review_set", goal: gid, level: "clean" } as never);
    recordEvent(root, { type: "attempt", goal: gid, ok: false, fail_streak: 2, note: "x" });
    recordEvent(root, { type: "eval_run", goal: gid, ok: true, fail_streak: 3 });
    const s = buildGoalSummary(root, gid, {
      score: 80,
      now: new Date(Date.parse(new Date().toISOString()) + 61000).toISOString(),
    });
    expect(s.router_route).toBe("polish");
    expect(s.diff_lines).toBe(500);
    expect(s.lenses).toEqual(["requirement", "behavior", "progress"]);
    expect(s.verdict_level).toBe("clean");
    expect(s.rewinds).toBe(2);
    expect(s.verifier_rounds).toBe(2);
    expect(s.max_fail_streak).toBe(3);
    expect(s.score).toBe(80);
    expect(s.duration_s).toBeGreaterThanOrEqual(0);
  });

  test("欠測はnull・goal_start無しはduration null", () => {
    const root = tmpRoot();
    const gid = "g-missing";
    recordEvent(root, { type: "goal_complete", goal: gid, score: 100 });
    const s = buildGoalSummary(root, gid, { score: 100 });
    expect(s.router_route).toBeNull();
    expect(s.verdict_level).toBeNull();
    expect(s.lenses).toEqual([]);
    expect(s.duration_s).toBeNull();
    expect(s.title).toBe("(unknown)");
  });

  test("2行1append＋buildTelemetryのbackfill再合成", () => {
    const root = tmpRoot();
    const gid = "g-batch";
    recordEvent(root, { type: "goal_start", goal: gid, title: "t" });
    recordEventBatch(root, [
      { type: "goal_complete", goal: gid, score: 90 },
      buildGoalSummary(root, gid, { score: 90 }),
    ]);
    // history末尾2行がgoal_complete＋goal_summary
    const lines = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines[lines.length - 2]!).type).toBe("goal_complete");
    expect(JSON.parse(lines[lines.length - 1]!).type).toBe("goal_summary");
    expect(buildTelemetry(root).map((t) => t.goal)).toEqual([gid]);
    // summary欠落の既存completeは再合成される
    const root2 = tmpRoot();
    recordEvent(root2, { type: "goal_start", goal: "g-old", title: "old" });
    recordEvent(root2, { type: "goal_complete", goal: "g-old", score: 70 });
    const tele = buildTelemetry(root2);
    expect(tele.length).toBe(1);
    expect(tele[0]!.goal).toBe("g-old");
    expect(tele[0]!.score).toBe(70);
    expect(tele[0]!.title).toBe("old");
  });

  test("backfillのdurationはgoal_completeのts基準（クエリ時刻に依存しない）", () => {
    const root = tmpRoot();
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-01T01:00:00.000Z"; // +3600s
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "history.jsonl"),
      [
        JSON.stringify({ ts: t0, type: "goal_start", goal: "g-fixed", title: "f" }),
        JSON.stringify({ ts: t1, type: "goal_complete", goal: "g-fixed", score: 50 }),
      ].join("\n") + "\n",
    );
    const tele = buildTelemetry(root);
    expect(tele.length).toBe(1);
    // 修正前はクエリ時刻now基準で巨大値になった
    expect(tele[0]!.duration_s).toBe(3600);
  });

  test("goal_summaryはoutboxに投下される（watcherのreflect素材）", async () => {
    const { completeGoal } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    completeGoal(root);
    const files = readdirSync(join(root, ".graphhopper", "outbox"));
    expect(files.some((f) => f.includes("goal_complete"))).toBe(true);
    expect(files.some((f) => f.includes("goal_summary"))).toBe(true);
    void g;
  });
});

import { mkdtempSync as _mk } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _join } from "node:path";
import { readLastDecisionId, writeLastDecisionId } from "./state";
import { logDecision } from "./decision";

describe("last_decision id（decide→goal の橋渡し）", () => {
  test("書いた id を読める・無ければ null", () => {
    const root = _mk(_join(_tmp(), "gh-ld-"));
    expect(readLastDecisionId(root)).toBeNull();
    writeLastDecisionId(root, "abc12345");
    expect(readLastDecisionId(root)).toBe("abc12345");
  });
});

describe("goal の decision_id（セッション限定）", () => {
  const decide = (id: string, sessionID: string, fallback = false) => ({
    id,
    kind: "decide" as const,
    request: "依頼",
    result: "full",
    confidence: 0.9,
    latencyMs: 1,
    fallback,
    reason: "t",
    sessionID,
  });

  test("同じセッションの成功 decide に紐付く（他セッションは拾わない）", async () => {
    const root = _mk(_join(_tmp(), "gh-sess-dec-"));
    await logDecision(root, decide("aaaa1111", "sess-A"));
    await logDecision(root, decide("bbbb2222", "sess-B"));
    const a = startGoal(root, "goal A", "sess-A");
    expect(a.state.decision_id).toBe("aaaa1111");
    /* goal_start の履歴にも同じ id を残す（判定と結果の突き合わせ用） */
    const ev = readHistory(root).find((h) => h.type === "goal_start") as
      | { decision_id?: string | null }
      | undefined;
    expect(ev?.decision_id).toBe("aaaa1111");
  });

  test("fallback 行は採らない（誤結合より未紐付けを選ぶ）", async () => {
    const root = _mk(_join(_tmp(), "gh-sess-dec-fb-"));
    await logDecision(root, decide("cccc3333", "sess-C", true));
    const c = startGoal(root, "goal C", "sess-C");
    expect(c.state.decision_id).toBeNull();
    const ev = readHistory(root).find((h) => h.type === "goal_start") as
      | { decision_id?: string | null }
      | undefined;
    expect(ev?.decision_id).toBeNull();
  });
});

describe("baseline の一元解決（design g-mwfltxyt）", () => {
  test("start > router > capture の順で解決する", async () => {
    const s = await import("./state");
    const noShell = undefined as unknown as Parameters<typeof s.resolveBaseline>[0];
    const root = tmpRoot();
    expect(
      await s.resolveBaseline(noShell, root, {
        start_baseline_rev: "a",
        router: { baseline_rev: "b" },
      }),
    ).toBe("a");
    expect(
      await s.resolveBaseline(noShell, root, {
        start_baseline_rev: null,
        router: { baseline_rev: "b" },
      }),
    ).toBe("b");
    expect(await s.resolveBaseline(noShell, root, null)).toBeNull();
  });
});

describe("captureStartBaseline / captureBaselineRev（design g-mwkgfssi 判断1・2）", () => {
  /** sh -c のコマンド文字列を見て結果を返す fake shell。発行されたコマンドも記録する */
  const fakeShell = (replies: Array<{ match: (cmd: string) => boolean; out: string }>) => {
    const issued: string[] = [];
    const shell = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
      const cmd = String(vals[0] ?? "");
      issued.push(cmd);
      const hit = replies.find((r) => r.match(cmd));
      const out = hit?.out ?? "";
      const exitCode = hit ? 0 : 1;
      return {
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode,
                stdout: { toString: () => out },
              }),
          }),
        }),
      };
    }) as unknown as Parameters<typeof import("./state").captureStartBaseline>[0];
    return { shell, issued };
  };

  test("jj は @ の commit id を返す（heads() を使わない）", async () => {
    const s = await import("./state");
    const { shell, issued } = fakeShell([
      { match: (c) => c.startsWith("jj log"), out: "abc123\n" },
    ]);
    const r = await s.captureStartBaseline(shell, tmpRoot());
    expect(r).toEqual({ rev: "abc123", source: "jj@" });
    expect(issued[0]).toContain("-r @");
    expect(issued.join("\n")).not.toContain("heads()");
  });

  test("jj が失敗したら git の一時 index で作業コピーの commit を作る", async () => {
    const s = await import("./state");
    const { shell, issued } = fakeShell([
      { match: (c) => c.startsWith("jj log"), out: "" },
      { match: (c) => c.includes("commit-tree"), out: "def456\n" },
    ]);
    const r = await s.captureStartBaseline(shell, tmpRoot());
    expect(r).toEqual({ rev: "def456", source: "git-worktree" });
    const worktreeCmd = issued.find((c) => c.includes("commit-tree")) ?? "";
    /* 実 index を汚さない（GIT_INDEX_FILE を分ける）・未追跡も含める（add -A） */
    expect(worktreeCmd).toContain("GIT_INDEX_FILE");
    expect(worktreeCmd).toContain("add -A");
  });

  test("jj も一時 index も失敗したら stash create → HEAD の順に落ちる", async () => {
    const s = await import("./state");
    const stashOnly = fakeShell([
      { match: (c) => c.startsWith("jj log"), out: "" },
      { match: (c) => c.includes("commit-tree"), out: "" },
      { match: (c) => c.startsWith("git stash create"), out: "ccc777\n" },
    ]);
    expect(await s.captureStartBaseline(stashOnly.shell, tmpRoot())).toEqual({
      rev: "ccc777",
      source: "git-stash",
    });

    const headOnly = fakeShell([
      { match: (c) => c.startsWith("jj log"), out: "" },
      { match: (c) => c.includes("commit-tree"), out: "" },
      { match: (c) => c.startsWith("git rev-parse HEAD"), out: "ddd888\n" },
    ]);
    expect(await s.captureStartBaseline(headOnly.shell, tmpRoot())).toEqual({
      rev: "ddd888",
      source: "git-HEAD",
    });
  });

  test("どれも取れなければ null（fail-open）", async () => {
    const s = await import("./state");
    const { shell } = fakeShell([]);
    expect(await s.captureStartBaseline(shell, tmpRoot())).toBeNull();
    expect(await s.captureBaselineRev(shell, tmpRoot())).toBeNull();
  });

  test("captureBaselineRev は最後に commit された rev（jj @- / git HEAD）", async () => {
    const s = await import("./state");
    const jj = fakeShell([{ match: (c) => c.startsWith("jj log"), out: "eee999\n" }]);
    expect(await s.captureBaselineRev(jj.shell, tmpRoot())).toBe("eee999");
    expect(jj.issued[0]).toContain("-r '@-'");

    const git = fakeShell([
      { match: (c) => c.startsWith("jj log"), out: "" },
      { match: (c) => c.startsWith("git rev-parse HEAD"), out: "fff000\n" },
    ]);
    expect(await s.captureBaselineRev(git.shell, tmpRoot())).toBe("fff000");
  });
});

describe("意図ログの state 連携（design g-mwebh9vl）", () => {
  test("pause→resume で intent_path が復元される", () => {
    const root = tmpRoot();
    startGoal(root, "t", "s1");
    setIntentPath(root, "/x/intent.md");
    pauseGoal(root);
    const r = resumeGoal(root, "s1");
    expect(r?.state.intent_path).toBe("/x/intent.md");
  });

  test("pause→resume で usability_review と start_baseline_rev が復元される", () => {
    const root = tmpRoot();
    startGoal(root, "t", "s1");
    setStartBaselineRev(root, "abc123");
    setUsabilityVerdict(root, {
      level: "clean",
      reason: "ok",
      files: ["AGENTS.md"],
      doc_hash: "h1",
      model: null,
    });
    pauseGoal(root);
    const r = resumeGoal(root, "s1");
    expect(r?.state.usability_review?.level).toBe("clean");
    expect(r?.state.usability_review?.files).toEqual(["AGENTS.md"]);
    expect(r?.state.start_baseline_rev).toBe("abc123");
  });

  test("archiveGoalFiles は .rubric.json も archive へ移す（g-mwmqmg6b 判断6）", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s1").goal;
    const p = join(root, ".graphhopper", "plans", `${g.id}.rubric.json`);
    writeFileSync(p, "{}\n", "utf8");
    archiveGoalFiles(root, g.id);
    expect(existsSync(p)).toBe(false);
    expect(
      existsSync(join(root, ".graphhopper", "plans", "archive", `${g.id}.rubric.json`)),
    ).toBe(true);
  });

  test("archiveGoalFiles は .intent.md も archive へ移す", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s1").goal;
    const p = join(root, ".graphhopper", "plans", `${g.id}.intent.md`);
    writeFileSync(p, "me: x\n", "utf8");
    archiveGoalFiles(root, g.id);
    expect(existsSync(p)).toBe(false);
    expect(
      existsSync(join(root, ".graphhopper", "plans", "archive", `${g.id}.intent.md`)),
    ).toBe(true);
  });
});

describe("同じ詰まりの resume を 1 ターンに限る（design g-mwokteud）", () => {
  test("stuck_key を渡すと残り、停止回数が増える", () => {
    const root = tmpRoot();
    startGoal(root, "t", "sess1");
    stopLoopByPause(root, { stuckKey: "diff:H|eval:-" });
    const s = readState(root);
    expect(s.guard.stuck_key).toBe("diff:H|eval:-");
    expect(s.loop_stop_count).toBe(1);
  });

  test("silent 指定では loop_stopped を記録しない", () => {
    const root = tmpRoot();
    startGoal(root, "t", "sess1");
    stopLoopByPause(root, { stuckKey: "k", silent: true });
    const types = readHistory(root).map((h) => h.type);
    expect(types).not.toContain("loop_stopped");
    expect(readState(root).loop_stop_count).toBe(1); // 数えること自体は同じ
  });

  test("resume は stuck_key を引き継ぎ、他の数は 0 に戻す", () => {
    const root = tmpRoot();
    startGoal(root, "t", "sess1");
    noteGuard(root, { stalls: 2, rounds: 5, progress_key: "k" });
    stopLoopByPause(root, { stuckKey: "k" });
    noteGuard(root, { stalls: 2, rounds: 5 });
    const r = resumeGoal(root, "sess1");
    expect(r).not.toBeNull();
    const g = readState(root).guard;
    expect(g.stuck_key).toBe("k");
    expect(g.stalls).toBe(0);
    expect(g.rounds).toBe(0);
    expect(g.progress_key).toBeNull();
  });

  test("force の resume は stuck_key を消す（人の判断で解除）", () => {
    const root = tmpRoot();
    startGoal(root, "t", "sess1");
    stopLoopByPause(root, { stuckKey: "k" });
    resumeGoal(root, "sess1", true);
    expect(readState(root).guard.stuck_key).toBeNull();
  });

  test("注意文は stuck_key があるときだけ出る", async () => {
    const { stuckResumeNote } = await import("./state");
    expect(stuckResumeNote(null)).toBeNull();
    expect(stuckResumeNote({ stuck_key: null } as never)).toBeNull();
    expect(stuckResumeNote({ stuck_key: "diff:abcdef1234567890|eval:-" } as never)).toContain("同じ状態のまま resume");
  });
});
