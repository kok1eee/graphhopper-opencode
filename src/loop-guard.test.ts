import { describe, expect, test } from "bun:test";
import {
  evaluateGuard,
  isMidRoundRestart,
  progressKeyOf,
  type GuardConfig,
} from "./loop-guard";
import type { LoopGuard } from "./state";

const cfg: GuardConfig = {
  loop_max_rounds: 3,
  loop_max_stalls: 2,
  loop_wait_limit_ms: 1000,
};

const g = (patch: Partial<LoopGuard> = {}): LoopGuard => ({
  rounds: 0,
  stalls: 0,
  progress_key: null,
  wait_since: null,
  pending: false,
  boot: null,
  ...patch,
});

const base = { config: cfg, boot: "boot-a", now: 10_000 };

describe("evaluateGuard", () => {
  test("進捗があれば継続し、rounds と pending を進める", () => {
    const d = evaluateGuard({ ...base, guard: g({ progress_key: "old" }), progressKey: "new", waiting: false });
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.next.rounds).toBe(1);
    expect(d.next.stalls).toBe(0);
    expect(d.next.progress_key).toBe("new");
    expect(d.next.pending).toBe(true);
    expect(d.next.boot).toBe("boot-a");
  });

  test("同じ進捗キーが続くと stalls が増え、上限で pause", () => {
    const first = evaluateGuard({ ...base, guard: g(), progressKey: "same", waiting: false });
    expect(first.action).toBe("continue");
    const second = evaluateGuard({ ...base, guard: first.next, progressKey: "same", waiting: false });
    expect(second.action).toBe("continue");
    const third = evaluateGuard({ ...base, guard: second.next, progressKey: "same", waiting: false });
    expect(third.action).toBe("pause");
    if (third.action === "pause") expect(third.reason).toBe("stalls");
  });

  test("進捗キーが変われば stalls は 0 に戻る", () => {
    const first = evaluateGuard({ ...base, guard: g(), progressKey: "a", waiting: false });
    const moved = evaluateGuard({ ...base, guard: first.next, progressKey: "b", waiting: false });
    expect(moved.action).toBe("continue");
    if (moved.action === "continue") expect(moved.next.stalls).toBe(0);
  });

  test("rounds が上限に達したら pause", () => {
    const d = evaluateGuard({ ...base, guard: g({ rounds: 3 }), progressKey: "x", waiting: false });
    expect(d.action).toBe("pause");
    if (d.action === "pause") expect(d.reason).toBe("rounds");
  });

  test("background 待ちは wait を返し、待ち始めを記録する", () => {
    const d = evaluateGuard({ ...base, guard: g(), progressKey: "x", waiting: true });
    expect(d.action).toBe("wait");
    if (d.action === "wait") expect(d.next.wait_since).toBe(new Date(10_000).toISOString());
  });

  test("待ちが上限を超えたら pause（wait）", () => {
    const started = evaluateGuard({ ...base, guard: g(), progressKey: "x", waiting: true });
    if (started.action !== "wait") throw new Error("expected wait");
    const d = evaluateGuard({
      ...base,
      now: 10_000 + 1_000,
      guard: started.next,
      progressKey: "x",
      waiting: true,
    });
    expect(d.action).toBe("pause");
    if (d.action === "pause") expect(d.reason).toBe("wait");
  });

  test("待ちが解けたら wait_since を戻す", () => {
    const d = evaluateGuard({
      ...base,
      guard: g({ wait_since: new Date(1).toISOString(), progress_key: "p" }),
      progressKey: "p",
      waiting: false,
    });
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.next.wait_since).toBeNull();
  });
});

describe("isMidRoundRestart", () => {
  test("別プロセスの pending は再起動扱い", () => {
    expect(isMidRoundRestart(g({ pending: true, boot: "old" }), "new", true)).toBe(true);
  });
  test("同じプロセス・pending でない・無効化は対象外", () => {
    expect(isMidRoundRestart(g({ pending: true, boot: "same" }), "same", true)).toBe(false);
    expect(isMidRoundRestart(g({ pending: false, boot: "old" }), "new", true)).toBe(false);
    expect(isMidRoundRestart(g({ pending: true, boot: "old" }), "new", false)).toBe(false);
    expect(isMidRoundRestart(null, "new", true)).toBe(false);
  });
});

describe("progressKeyOf", () => {
  test("要素が変わればキーが変わる", () => {
    const a = progressKeyOf({ phase: "implementing", todosDone: 1, evalFingerprint: "x", diffLines: 10, planSize: 100 });
    const b = progressKeyOf({ phase: "implementing", todosDone: 2, evalFingerprint: "x", diffLines: 10, planSize: 100 });
    expect(a).not.toBe(b);
    expect(a).toBe(
      progressKeyOf({ phase: "implementing", todosDone: 1, evalFingerprint: "x", diffLines: 10, planSize: 100 }),
    );
  });
});
