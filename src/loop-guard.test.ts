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

  /* 進んだ証拠を diff と eval 合否に限る（design g-mwoiwjif） */
  test("差分の指紋があれば、todo 完了数・phase・eval 出力の指紋では変わらない", () => {
    const base = {
      phase: "implementing",
      todosDone: 0,
      evalFingerprint: "false:aaaa",
      diffLines: 10,
      planSize: 100,
      diffHash: "H1",
      evalOk: false,
    };
    const k = progressKeyOf(base);
    expect(
      progressKeyOf({ ...base, todosDone: 3, phase: "polish", diffLines: 99, planSize: 200 }),
    ).toBe(k);
    // eval 出力の末尾が変わっても合否が同じなら同じ
    expect(progressKeyOf({ ...base, evalFingerprint: "false:bbbb" })).toBe(k);
    // 合否が変われば進んだ扱い
    expect(progressKeyOf({ ...base, evalOk: true })).not.toBe(k);
    // 差分が変われば進んだ扱い
    expect(progressKeyOf({ ...base, diffHash: "H2" })).not.toBe(k);
  });

  test("差分を測れないときは従来の材料にフォールバックする", () => {
    const k = progressKeyOf({
      phase: "implementing",
      todosDone: 1,
      evalFingerprint: "true:aaaa",
      diffLines: 10,
      planSize: 100,
      diffHash: null,
      evalOk: true,
    });
    expect(k).not.toContain("diff:");
    expect(k).toBe(
      progressKeyOf({ phase: "implementing", todosDone: 1, evalFingerprint: "true:aaaa", diffLines: 10, planSize: 100 }),
    );
  });

  test("フォールバックでは従来の材料それぞれの変化でキーが変わる", () => {
    const base = {
      phase: "implementing",
      todosDone: 1,
      evalFingerprint: "true:aaaa",
      diffLines: 10,
      planSize: 100,
      diffHash: null,
      evalOk: null,
    };
    const k = progressKeyOf(base);
    expect(progressKeyOf({ ...base, phase: "polish" })).not.toBe(k);
    expect(progressKeyOf({ ...base, todosDone: 2 })).not.toBe(k);
    expect(progressKeyOf({ ...base, evalFingerprint: "false:aaaa" })).not.toBe(k);
    expect(progressKeyOf({ ...base, diffLines: 11 })).not.toBe(k);
    expect(progressKeyOf({ ...base, planSize: 101 })).not.toBe(k);
  });

  test("eval_cmd が無ければ合否は材料に入らない（差分だけ）", () => {
    const k = progressKeyOf({
      phase: "implementing",
      todosDone: 0,
      evalFingerprint: null,
      diffLines: null,
      planSize: null,
      diffHash: "H1",
      evalOk: null,
    });
    expect(k).toBe("diff:H1|eval:-");
  });
});

describe("同じ詰まりの resume を 1 ターンに限る（design g-mwokteud）", () => {
  test("進捗なしで止めるとき、停止時のキーを残す", () => {
    let d = evaluateGuard({ ...base, guard: g(), progressKey: "k1", waiting: false });
    while (d.action === "continue") {
      expect(d.next.stuck_key).toBeNull(); // まだ止まっていないので印は無い
      d = evaluateGuard({ ...base, guard: d.next, progressKey: "k1", waiting: false });
    }
    expect(d.action).toBe("pause");
    if (d.action !== "pause") return;
    expect(d.reason).toBe("stalls");
    expect(d.next.stuck_key).toBe("k1");
  });

  test("resume 後も同じキーなら stuck_again で止まり、キーは残る", () => {
    const d = evaluateGuard({
      ...base,
      guard: g({ stuck_key: "k1", rounds: 0, stalls: 0, progress_key: null, pending: false }),
      progressKey: "k1",
      waiting: false,
    });
    expect(d.action).toBe("pause");
    if (d.action !== "pause") return;
    expect(d.reason).toBe("stuck_again");
    expect(d.next.stuck_key).toBe("k1"); // 次に resume しても同じ扱い
  });

  test("キーが変われば続行し、印を消す", () => {
    const d = evaluateGuard({
      ...base,
      guard: g({ stuck_key: "k1", progress_key: null, pending: false }),
      progressKey: "k2",
      waiting: false,
    });
    expect(d.action).toBe("continue");
    if (d.action !== "continue") return;
    expect(d.next.stuck_key).toBeNull();
  });

  test("進捗があって続行すると、古い印も消える", () => {
    const first = evaluateGuard({ ...base, guard: g(), progressKey: "a", waiting: false });
    if (first.action !== "continue") throw new Error("continue のはず");
    expect(first.next.stuck_key).toBeNull();
  });

  test("background 待ちの間はキーも印も触らない", () => {
    const d = evaluateGuard({
      ...base,
      guard: g({ stuck_key: "k1", progress_key: "k1", pending: false }),
      progressKey: "k1",
      waiting: true,
    });
    expect(d.action).toBe("wait");
    expect(d.next.stuck_key).toBe("k1");
  });

  test("印の無い古い guard は従来どおり（undefined でも壊れない）", () => {
    const legacy = { ...g(), stuck_key: undefined };
    const first = evaluateGuard({ ...base, guard: legacy, progressKey: "k1", waiting: false });
    expect(first.action).toBe("continue");
    if (first.action === "continue") expect(first.next.stalls).toBe(0);
  });
});
