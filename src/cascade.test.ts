/**
 * モデルカスケードの判断・適用・復元・子セッション切替の単体テスト。
 * bun test で実行する: `bun test src/cascade.test.ts`
 */
import { describe, expect, test } from "bun:test";
import {
  type CascadeHost,
  type ChildHost,
  type ModelRef,
  endCascade,
  escalateChildSession,
  formatModel,
  parseCascadeModel,
  resolveChildModel,
  resolveLevel,
  shouldFlushOrphan,
  shouldSwitchChild,
  applyCascade,
} from "./cascade";
import type { CascadeConfig } from "./state";

const config: CascadeConfig = {
  enabled: true,
  baseline: "minimax/MiniMax-M3.1-Flash",
  escalate: "claude-oauth/claude-sonnet-5-5",
  escalate_on: ["hard"],
  fail_threshold: 2,
  agents: { apply: "always", quality: { "graphhopper-verifier": "claude-oauth/claude-sonnet-5-5" } },
};

function fakeHost(initial: ModelRef | null = { providerID: "me", id: "original" }) {
  const calls = { switched: [] as ModelRef[] };
  const host: CascadeHost = {
    getModel: async () => initial,
    switchModel: async (_sessionID, model) => {
      calls.switched.push(model);
    },
  };
  return { host, calls };
}

function fakeChildHost(current: ModelRef | null) {
  const calls = { switched: [] as ModelRef[] };
  let model = current;
  const host: ChildHost = {
    switchModel: async (_sessionID, m) => {
      calls.switched.push(m);
      model = m;
    },
    getModel: async () => model,
  };
  return { host, calls };
}

describe("parseCascadeModel", () => {
  test("provider/model と #variant を割る", () => {
    expect(parseCascadeModel("opencode-go/minimax-m3.1-flash-free")).toEqual({
      providerID: "opencode-go",
      id: "minimax-m3.1-flash-free",
    });
    expect(parseCascadeModel("claude-oauth/claude-sonnet-5-5#high")).toEqual({
      providerID: "claude-oauth",
      id: "claude-sonnet-5-5",
      variant: "high",
    });
  });

  test("不正値は null（例外にしない）", () => {
    expect(parseCascadeModel("")).toBeNull();
    expect(parseCascadeModel(null)).toBeNull();
    expect(parseCascadeModel("no-slash")).toBeNull();
    expect(parseCascadeModel("/leading")).toBeNull();
    expect(parseCascadeModel("trailing/")).toBeNull();
  });

  test("formatModel は variant 込みの正規表記", () => {
    expect(formatModel({ providerID: "a", id: "b" })).toBe("a/b");
    expect(formatModel({ providerID: "a", id: "b", variant: "high" })).toBe("a/b#high");
    expect(formatModel(null)).toBeNull();
  });
});

describe("resolveLevel", () => {
  test("無効なら baseline", () => {
    expect(
      resolveLevel({
        difficulty: "hard",
        failStreak: 9,
        currentLevel: "escalated",
        config: { ...config, enabled: false },
      }).level,
    ).toBe("baseline");
  });

  test("一度 escalated になったら fail_streak が 0 でも維持（ラチェット）", () => {
    const r = resolveLevel({ difficulty: "easy", failStreak: 0, currentLevel: "escalated", config });
    expect(r.level).toBe("escalated");
    expect(r.reason).toContain("ラチェット");
  });

  test("連続失敗が閾値以上なら昇格", () => {
    expect(resolveLevel({ difficulty: null, failStreak: 2, currentLevel: null, config }).level).toBe("escalated");
    expect(resolveLevel({ difficulty: null, failStreak: 1, currentLevel: null, config }).level).toBe("baseline");
  });

  test("難易度が escalate_on なら昇格、それ以外は baseline", () => {
    expect(resolveLevel({ difficulty: "hard", failStreak: 0, currentLevel: null, config }).level).toBe("escalated");
    expect(resolveLevel({ difficulty: "normal", failStreak: 0, currentLevel: null, config }).level).toBe("baseline");
    expect(resolveLevel({ difficulty: null, failStreak: 0, currentLevel: null, config }).level).toBe("baseline");
  });

  test("閾値0以下なら fail では昇格しない", () => {
    const r = resolveLevel({
      difficulty: "normal",
      failStreak: 99,
      currentLevel: null,
      config: { ...config, fail_threshold: 0 },
    });
    expect(r.level).toBe("baseline");
  });
});

describe("applyCascade", () => {
  test("escalated は昇格モデルへ切り替える", async () => {
    const { host, calls } = fakeHost();
    const state = await applyCascade(host, {
      sessionID: "ses_1",
      level: "escalated",
      reason: "difficulty hard",
      config,
      previous: null,
    });
    expect(calls.switched).toEqual([{ providerID: "claude-oauth", id: "claude-sonnet-5-5" }]);
    expect(state?.model).toBe("claude-oauth/claude-sonnet-5-5");
    expect(state?.restore).toEqual({ providerID: "me", id: "original" });
    expect(state?.children).toEqual([]);
  });

  test("baseline は通常モデルへ戻す", async () => {
    const { host, calls } = fakeHost();
    const state = await applyCascade(host, {
      sessionID: "ses_1",
      level: "baseline",
      reason: "difficulty easy",
      config,
      previous: null,
    });
    expect(calls.switched).toEqual([{ providerID: "minimax", id: "MiniMax-M3.1-Flash" }]);
    expect(state?.level).toBe("baseline");
  });

  test("復元先のモデルが取れないなら切り替えない", async () => {
    const { host, calls } = fakeHost(null);
    const state = await applyCascade(host, {
      sessionID: "ses_1",
      level: "escalated",
      reason: "x",
      config,
      previous: null,
    });
    expect(state).toBeNull();
    expect(calls.switched).toHaveLength(0);
  });

  test("2回目の適用では restore と children を引き継ぐ", async () => {
    const { host } = fakeHost();
    const child = { sessionID: "ses_c", agent: "graphhopper-verifier", model: "a/b", readback_match: true, at: "t" };
    const first = await applyCascade(host, {
      sessionID: "ses_1",
      level: "baseline",
      reason: "a",
      config,
      previous: null,
    });
    const second = await applyCascade(host, {
      sessionID: "ses_1",
      level: "escalated",
      reason: "b",
      config,
      previous: first ? { ...first, children: [child] } : null,
    });
    expect(second?.restore).toEqual(first?.restore);
    expect(second?.children).toEqual([child]);
  });
});

describe("endCascade", () => {
  const state = {
    level: "escalated" as const,
    reason: "x",
    model: "claude-oauth/claude-sonnet-5-5",
    restore: { providerID: "me", id: "original" },
    children: [],
    at: "2026-10-20T00:00:00.000Z",
  };

  test("元モデルへ戻す", async () => {
    const { host, calls } = fakeHost();
    expect(await endCascade(host, "ses_1", state)).toBe(true);
    expect(calls.switched).toEqual([{ providerID: "me", id: "original" }]);
  });

  test("session か restore が無ければ何もしない", async () => {
    const { host, calls } = fakeHost();
    expect(await endCascade(host, null, state)).toBe(false);
    expect(await endCascade(host, "ses_1", null)).toBe(false);
    expect(calls.switched).toHaveLength(0);
  });

  test("切替が失敗しても throw しない", async () => {
    const host: CascadeHost = {
      getModel: async () => null,
      switchModel: async () => {
        throw new Error("session gone");
      },
    };
    expect(await endCascade(host, "ses_1", state)).toBe(false);
  });
});

describe("shouldFlushOrphan", () => {
  const cascade = {
    level: "escalated" as const,
    reason: "x",
    model: "a/b",
    restore: { providerID: "me", id: "original" },
    children: [],
    at: "2026-10-20T00:00:00.000Z",
  };

  test("cascade が無ければ false", () => {
    expect(shouldFlushOrphan({ status: "done" }, null)).toBe(false);
  });

  test("active な goal があれば false", () => {
    expect(shouldFlushOrphan({ status: "active" }, cascade)).toBe(false);
  });

  test("goal が無い・done・paused なら true（complete は active を null にしないため）", () => {
    expect(shouldFlushOrphan(null, cascade)).toBe(true);
    expect(shouldFlushOrphan({ status: "done" }, cascade)).toBe(true);
    expect(shouldFlushOrphan({ status: "paused" }, cascade)).toBe(true);
  });
});

describe("resolveChildModel", () => {
  test("quality マップにあればそのモデル", () => {
    expect(resolveChildModel({ childAgent: "graphhopper-verifier", quality: config.agents.quality })).toBe(
      "claude-oauth/claude-sonnet-5-5",
    );
  });

  test("マップ外・agent 未指定は null", () => {
    expect(resolveChildModel({ childAgent: "graphhopper-researcher", quality: config.agents.quality })).toBeNull();
    expect(resolveChildModel({ childAgent: undefined, quality: config.agents.quality })).toBeNull();
    expect(resolveChildModel({ childAgent: "  ", quality: config.agents.quality })).toBeNull();
  });

  test("完全一致のみ（前方一致は拾わない）", () => {
    expect(
      resolveChildModel({ childAgent: "graphhopper-verifier-requirement", quality: config.agents.quality }),
    ).toBeNull();
  });
});

describe("shouldSwitchChild", () => {
  const base = {
    parentID: "ses_main",
    boundSessionID: "ses_main",
    goalStatus: "active",
    childAgent: "graphhopper-verifier",
    currentModel: "minimax/MiniMax-M3",
    target: "claude-oauth/claude-sonnet-5-5",
  };

  test("親が bound と一致し・active・対象あり・モデル相違なら true", () => {
    expect(shouldSwitchChild(base)).toBe(true);
  });

  test("親不一致は false", () => {
    expect(shouldSwitchChild({ ...base, parentID: "ses_other" })).toBe(false);
  });

  test("goal が非 active（done・paused）は false", () => {
    expect(shouldSwitchChild({ ...base, goalStatus: "done" })).toBe(false);
    expect(shouldSwitchChild({ ...base, goalStatus: "paused" })).toBe(false);
  });

  test("bound 未設定・parent 未設定は false", () => {
    expect(shouldSwitchChild({ ...base, boundSessionID: null })).toBe(false);
    expect(shouldSwitchChild({ ...base, parentID: null })).toBe(false);
  });

  test("apply=escalated は level が escalated のときだけ true", () => {
    expect(shouldSwitchChild({ ...base, apply: "escalated", level: "baseline" })).toBe(false);
    expect(shouldSwitchChild({ ...base, apply: "escalated", level: null })).toBe(false);
    expect(shouldSwitchChild({ ...base, apply: "escalated", level: "escalated" })).toBe(true);
    expect(shouldSwitchChild({ ...base, apply: "always", level: "baseline" })).toBe(true);
  });

  test("対象モデルが無い・既に一致なら false", () => {
    expect(shouldSwitchChild({ ...base, target: null })).toBe(false);
    expect(shouldSwitchChild({ ...base, currentModel: "claude-oauth/claude-sonnet-5-5" })).toBe(false);
  });
});

describe("escalateChildSession", () => {
  test("切り替えて読み返し一致を返す", async () => {
    const { host, calls } = fakeChildHost({ providerID: "minimax", id: "MiniMax-M3" });
    const r = await escalateChildSession(host, {
      sessionID: "ses_child",
      agent: "graphhopper-verifier",
      target: "claude-oauth/claude-sonnet-5-5",
    });
    expect(calls.switched).toEqual([{ providerID: "claude-oauth", id: "claude-sonnet-5-5" }]);
    expect(r).toEqual({ model: "claude-oauth/claude-sonnet-5-5", readback_match: true });
  });

  test("不正な target は null", async () => {
    const { host, calls } = fakeChildHost(null);
    const r = await escalateChildSession(host, {
      sessionID: "ses_child",
      agent: "graphhopper-verifier",
      target: "not-a-model",
    });
    expect(r).toBeNull();
    expect(calls.switched).toHaveLength(0);
  });

  test("switch が失敗しても throw しない", async () => {
    const host: ChildHost = {
      switchModel: async () => {
        throw new Error("boom");
      },
      getModel: async () => null,
    };
    const r = await escalateChildSession(host, {
      sessionID: "ses_child",
      agent: "graphhopper-verifier",
      target: "claude-oauth/claude-sonnet-5-5",
    });
    expect(r).toBeNull();
  });

  test("variant 付きで読み返しても一致とみなす", async () => {
    const host: ChildHost = {
      switchModel: async () => {},
      getModel: async () => ({ providerID: "claude-oauth", id: "claude-sonnet-5-5", variant: "default" }),
    };
    const r = await escalateChildSession(host, {
      sessionID: "ses_child",
      agent: "graphhopper-verifier",
      target: "claude-oauth/claude-sonnet-5-5",
    });
    expect(r?.readback_match).toBe(true);
  });

  test("読み返しが違えば readback_match=false", async () => {
    const host: ChildHost = {
      switchModel: async () => {},
      getModel: async () => ({ providerID: "other", id: "model" }),
    };
    const r = await escalateChildSession(host, {
      sessionID: "ses_child",
      agent: "graphhopper-verifier",
      target: "claude-oauth/claude-sonnet-5-5",
    });
    expect(r?.readback_match).toBe(false);
  });
});
