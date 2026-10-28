import { describe, expect, test } from "bun:test";
import {
  assembleLenses,
  callDecision,
  callDecisionWithRetry,
  chooseRecovery,
  chooseWorkflow,
  logDecision,
  DECISION_CONFIDENCE_FLOOR,
  decideRoute,
  decisionAvailable,
  JEV_API_URL,
  JEV_DEFAULT_MODEL,
  JEV_PAID_MODEL,
  pendingShadows,
  primaryProviderName,
  PROVIDERS,
  shadowProviderName,
  mapDecisionAnswer,
  mapDifficultyAnswer,
  SELECTOR_NOUL_THRESHOLD,
  SELECTOR_RETRIES,
  SELECTOR_TIMEOUT_MS,
  selectLenses,
} from "./decision";

/* LIQUID_API_KEY の差し替え／復元（テスト全体で共有。実環境のkeyに依存させない） */
const SAVED_KEY = process.env.LIQUID_API_KEY;
const setKey = (v: string | undefined) => {
  if (v === undefined) delete process.env.LIQUID_API_KEY;
  else process.env.LIQUID_API_KEY = v;
};
const restore = () => setKey(SAVED_KEY);

describe("mapDecisionAnswer（d1 choice写像）", () => {
  test("5択はそのまま通す", () => {
    for (const r of ["full", "light", "direct", "advised", "oracle"]) {
      expect(mapDecisionAnswer(r, 0.99)).toMatchObject({ route: r });
    }
  });
  test("低confidenceはfullに倒す", () => {
    const r = mapDecisionAnswer("light", DECISION_CONFIDENCE_FLOOR - 0.01);
    expect(r.route).toBe("full");
    expect(r.reason).toContain("低confidence");
  });
  test("境界値（==floor）は通す", () => {
    expect(
      mapDecisionAnswer("light", DECISION_CONFIDENCE_FLOOR).route,
    ).toBe("light");
  });
  test("不正choice・5択外・非文字列はfull", () => {
    expect(mapDecisionAnswer("unknown", 0.99).route).toBe("full");
    expect(mapDecisionAnswer(null, 0.99).route).toBe("full");
    expect(mapDecisionAnswer(42, 0.99).route).toBe("full");
  });
  test("confidence欠測は通す（null許容）", () => {
    const r = mapDecisionAnswer("direct", undefined);
    expect(r).toMatchObject({ route: "direct", confidence: null });
  });
});

describe("mapDifficultyAnswer（難易度写像）", () => {
  test("3択はそのまま通す", () => {
    for (const d of ["easy", "normal", "hard"] as const) {
      expect(mapDifficultyAnswer(d, 0.9).difficulty).toBe(d);
    }
  });

  test("低confidence・不正値は null（昇格しない）", () => {
    expect(mapDifficultyAnswer("hard", DECISION_CONFIDENCE_FLOOR - 0.01).difficulty).toBeNull();
    expect(mapDifficultyAnswer("unknown", 0.9).difficulty).toBeNull();
    expect(mapDifficultyAnswer(null, 0.9).difficulty).toBeNull();
  });

  test("confidence欠測は通す", () => {
    expect(mapDifficultyAnswer("hard", undefined)).toMatchObject({ difficulty: "hard", confidence: null });
  });
});

describe("decideRoute（fail-safe）", () => {

  test("key未設定→full", async () => {
    setKey(undefined);
    try {
      const r = await decideRoute("何かやる");
      expect(r.route).toBe("full");
      expect(r.reason).toContain("LIQUID_API_KEY未設定");
    } finally {
      restore();
    }
  });

  test("HTTP失敗→full（fetchは1回のみ）", async () => {
    setKey("liquid_test");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return { ok: false, status: 429 } as Response;
    }) as unknown as typeof fetch;
    try {
      const r = await decideRoute("何かやる", fakeFetch);
      expect(r.route).toBe("full");
      expect(r.reason).toContain("429");
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });

  test("正常応答→choice通り", async () => {
    setKey("liquid_test");
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        answers: {
          route: { choice: "light", confidence: 0.9 },
          difficulty: { choice: "hard", confidence: 0.8 },
        },
      }),
    })) as unknown as typeof fetch;
    try {
      const r = await decideRoute("何かやる", fakeFetch);
      expect(r).toMatchObject({ route: "light", confidence: 0.9, difficulty: "hard" });
    } finally {
      restore();
    }
  });

  test("difficulty が無い応答でも route は返し、difficulty は null", async () => {
    setKey("liquid_test");
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ answers: { route: { choice: "light", confidence: 0.9 } } }),
    })) as unknown as typeof fetch;
    try {
      const r = await decideRoute("何かやる", fakeFetch);
      expect(r).toMatchObject({ route: "light", difficulty: null });
    } finally {
      restore();
    }
  });
});

/* Noul確率 → d1のanswers形式 */
const ans = (p: Partial<Record<"requirement" | "behavior" | "progress", number>>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { noul: v }]));

describe("assembleLenses（Noul確率→lens集合）", () => {
  const T = SELECTOR_NOUL_THRESHOLD;
  test("閾値以上のlensだけ採用（generalは含めない）", () => {
    const r = assembleLenses(ans({ requirement: 0.9, behavior: 0.8, progress: 0.1 }), "設計");
    expect(r.lenses).toEqual(["requirement", "behavior"]);
    expect(r.fallback).toBe(false);
  });
  test("境界（==閾値）は採用、直下は不採用", () => {
    expect(assembleLenses(ans({ requirement: T, behavior: T - 0.01, progress: 0 }), "x").lenses).toEqual(["requirement"]);
  });
  test("全て閾値未満＝該当なし→general（fallbackではない）", () => {
    const r = assembleLenses(ans({ requirement: 0.1, behavior: 0.2, progress: 0.3 }), "x");
    expect(r.lenses).toEqual(["general"]);
    expect(r.fallback).toBe(false);
    expect(r.reason).toContain("該当なし");
  });
  test("全て高い→3件（cap内・generalなし）", () => {
    const r = assembleLenses(ans({ requirement: 0.9, behavior: 0.9, progress: 0.9 }), "x");
    expect(r.lenses).toEqual(["requirement", "behavior", "progress"]);
  });
  test("契約変更系キーワードでrequirement強制（Noulが低くても）", () => {
    for (const kw of ["契約を変更", "migration", "後方互換", "breaking change", "schema変更", "スキーマ"]) {
      const r = assembleLenses(ans({ requirement: 0.1, behavior: 0.1, progress: 0.1 }), kw);
      expect(r.lenses).toContain("requirement");
      expect(r.lenses).not.toContain("general");
      expect(r.reason).toContain("強制");
    }
  });
  test("既にrequirementが採用済みなら強制表記しない", () => {
    const r = assembleLenses(ans({ requirement: 0.9, behavior: 0.1, progress: 0.1 }), "契約");
    expect(r.lenses).toEqual(["requirement"]);
    expect(r.reason).not.toContain("強制");
  });
  test("Noul欠測（有効な確率が0件）＝判定不能→fallback（general倒しなし）", () => {
    for (const a of [{}, { requirement: { noul: "x" } }, { requirement: {} }]) {
      const r = assembleLenses(a as never, "契約");
      expect(r).toMatchObject({ lenses: [], fallback: true });
    }
  });
  test("キーワードはdiff統計ではなくdesign抜粋のみ対象（呼び出し側で保証）", () => {
    const r = assembleLenses(ans({ requirement: 0.1, behavior: 0.1, progress: 0.1 }), "ふつうの修正");
    expect(r.lenses).toEqual(["general"]);
  });
});

describe("callDecision／selectLenses（fail-safe）", () => {
  const okFetch = (answers: unknown) =>
    (async () => ({ ok: true, json: async () => ({ answers }) })) as unknown as typeof fetch;

  test("callDecision: key未設定→ok:false", async () => {
    setKey(undefined);
    try {
      const r = await callDecision("s", { q: { type: "noul", instructions: "?" } });
      expect(r).toEqual({ ok: false, reason: "LIQUID_API_KEY未設定", retryable: false });
    } finally {
      restore();
    }
  });

  test("decideRouteのAPI失敗ログはfallback:true", async () => {
    const root = await mkRoot();
    setKey(undefined);
    try {
      const r = await decideRoute("何か", fetch, { root });
      expect(r.route).toBe("full");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const [line] = readFileSync(join(root, ".graphhopper", "decisions.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(line).toMatchObject({ kind: "decide", result: "full", fallback: true });
    } finally {
      restore();
    }
  });

  test("callDecision: answersなし→ok:false", async () => {
    setKey("liquid_test");
    try {
      const r = await callDecision("s", { q: { type: "noul", instructions: "?" } }, okFetch(undefined));
      expect(r.ok).toBe(false);
    } finally {
      restore();
    }
  });

  test("callDecision: fetch例外→ok:false（throwしない）", async () => {
    setKey("liquid_test");
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      const r = await callDecision("s", { q: { type: "noul", instructions: "?" } }, boom);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("network down");
    } finally {
      restore();
    }
  });

  test("callDecision: timeout超過でabort→ok:false（signalで中断される）", async () => {
    setKey("liquid_test");
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    try {
      const t = performance.now();
      const r = await callDecision("s", { q: { type: "noul", instructions: "?" } }, hang, 50);
      expect(r.ok).toBe(false);
      expect(performance.now() - t).toBeLessThan(1000);
    } finally {
      restore();
    }
  });

  const Q = { q: { type: "noul", instructions: "?" } } as const;
  const seq = (...steps: Array<"timeout" | number | "ok">) => {
    let i = 0;
    const fn = (async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step === "timeout") throw new Error("aborted");
      if (step === "ok") return { ok: true, json: async () => ({ answers: { q: { noul: 0.9 } } }) };
      return { ok: false, status: step };
    }) as unknown as typeof fetch;
    return { fn, calls: () => i };
  };

  test("リトライ: timeout→timeout→okで3試行目に成功（初回がコールドスタート）", async () => {
    setKey("liquid_test");
    try {
      const f = seq("timeout", "timeout", "ok");
      const r = await callDecisionWithRetry("s", Q, f.fn, 50, SELECTOR_RETRIES);
      expect(r.ok).toBe(true);
      expect(f.calls()).toBe(3);
    } finally {
      restore();
    }
  });

  test("リトライ: 全て失敗なら試行回数を理由に残してok:false（最大3回）", async () => {
    setKey("liquid_test");
    try {
      const f = seq("timeout");
      const r = await callDecisionWithRetry("s", Q, f.fn, 50, SELECTOR_RETRIES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("3回試行");
      expect(f.calls()).toBe(3);
    } finally {
      restore();
    }
  });

  test("リトライ: 429/503は再試行、401/403は即諦め（無駄に待たない）", async () => {
    setKey("liquid_test");
    try {
      const a = seq(503, "ok");
      expect((await callDecisionWithRetry("s", Q, a.fn, 50, 2)).ok).toBe(true);
      expect(a.calls()).toBe(2);
      for (const code of [401, 403]) {
        const b = seq(code, "ok");
        const r = await callDecisionWithRetry("s", Q, b.fn, 50, 2);
        expect(r.ok).toBe(false);
        expect(b.calls()).toBe(1);
      }
    } finally {
      restore();
    }
  });

  test("リトライ: key未設定は即諦め（fetchを呼ばない）", async () => {
    setKey(undefined);
    try {
      const f = seq("ok");
      const r = await callDecisionWithRetry("s", Q, f.fn, 50, 2);
      expect(r.ok).toBe(false);
      expect(f.calls()).toBe(0);
    } finally {
      restore();
    }
  });

  test("retries=0（入口routeの既定）は1回だけ試行する", async () => {
    setKey("liquid_test");
    try {
      const f = seq("timeout");
      await callDecisionWithRetry("s", Q, f.fn, 50, 0);
      expect(f.calls()).toBe(1);
    } finally {
      restore();
    }
  });

  test("selectLenses: 初回timeout→リトライで拾ってlens組立", async () => {
    setKey("liquid_test");
    let n = 0;
    const flaky = (async () => {
      if (n++ === 0) throw new Error("aborted");
      return {
        ok: true,
        json: async () => ({
          answers: { requirement: { noul: 0.9 }, behavior: { noul: 0.1 }, progress: { noul: 0.1 } },
        }),
      };
    }) as unknown as typeof fetch;
    try {
      const r = await selectLenses("ふつう", "1 file", flaky);
      expect(r).toMatchObject({ lenses: ["requirement"], fallback: false });
      expect(n).toBe(2);
    } finally {
      restore();
    }
  });

  test("selector既定timeoutは入口route(15s)より短い", () => {
    expect(SELECTOR_TIMEOUT_MS).toBeLessThan(15_000);
  });

  test("selectLenses: 正常応答→lens組立", async () => {
    setKey("liquid_test");
    try {
      const r = await selectLenses(
        "ふつうの修正",
        "1 file +3 -1",
        okFetch({
          requirement: { noul: 0.05 },
          behavior: { noul: 0.9 },
          progress: { noul: 0.1 },
        }),
      );
      expect(r).toMatchObject({ lenses: ["behavior"], fallback: false });
    } finally {
      restore();
    }
  });

  test("selectLenses: key無し/HTTP失敗/Noul欠測→fallback=true（general倒しなし）", async () => {
    setKey(undefined);
    try {
      expect(await selectLenses("x", "y")).toMatchObject({ lenses: [], fallback: true });
      setKey("liquid_test");
      const http = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
      expect(await selectLenses("x", "y", http)).toMatchObject({ lenses: [], fallback: true });
      expect(await selectLenses("x", "y", okFetch({}))).toMatchObject({ lenses: [], fallback: true });
    } finally {
      restore();
    }
  });
});

const mkRoot = async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "gh-decide-log-"));
};
describe("logDecision（較正ログ）", () => {
  const readLines = async (root: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(root, ".graphhopper", "decisions.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  };

  test("decideRouteはroot指定で1行追記する（kind/result/latency）", async () => {
    const root = await mkRoot();
    const saved = process.env.LIQUID_API_KEY;
    process.env.LIQUID_API_KEY = "liquid_test";
    try {
      const fake = (async () => ({
        ok: true,
        json: async () => ({
          answers: { route: { choice: "direct", confidence: 0.9 } },
        }),
      })) as unknown as typeof fetch;
      const r = await decideRoute("typoを直す", fake, { root });
      expect(r.route).toBe("direct");
      const [line] = await readLines(root);
      expect(line).toMatchObject({ kind: "decide", result: "direct" });
      expect(typeof line.latencyMs).toBe("number");
      expect(typeof line.ts).toBe("string");
    } finally {
      if (saved === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = saved;
    }
  });

  test("selectLensesはlenses＋probsを記録する", async () => {
    const root = await mkRoot();
    const saved = process.env.LIQUID_API_KEY;
    process.env.LIQUID_API_KEY = "liquid_test";
    try {
      const fake = (async () => ({
        ok: true,
        json: async () => ({
          answers: {
            requirement: { noul: 0.9 },
            behavior: { noul: 0.1 },
            progress: { noul: 0.1 },
          },
        }),
      })) as unknown as typeof fetch;
      const r = await selectLenses("設計", "1 file", fake, { root });
      expect(r.lenses).toEqual(["requirement"]);
      const [line] = await readLines(root);
      expect(line).toMatchObject({
        kind: "select",
        fallback: false,
      });
      expect(line.result).toEqual(["requirement"]);
      expect(line.probs.requirement).toBe(0.9);
    } finally {
      if (saved === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = saved;
    }
  });

  test("request は先頭200字に切る（単一源泉）", async () => {
    const root = await mkRoot();
    await logDecision(root, {
      kind: "decide",
      request: "あ".repeat(500),
      result: "full",
      confidence: null,
      latencyMs: 1,
      fallback: false,
      reason: "t",
    });
    const [line] = await readLines(root);
    expect((line.request as string).length).toBe(200);
  });

  test("root無指定は記録しない・書込失敗でも結果を返す", async () => {
    const saved = process.env.LIQUID_API_KEY;
    process.env.LIQUID_API_KEY = "liquid_test";
    try {
      const fake = (async () => ({
        ok: true,
        json: async () => ({
          answers: { route: { choice: "light", confidence: 0.8 } },
        }),
      })) as unknown as typeof fetch;
      const r = await decideRoute("何か", fake);
      expect(r.route).toBe("light");
      // 書込先がファイルでmkdir失敗してもthrowせず結果を返す
      const { writeFileSync } = await import("node:fs");
      const notDir = "/tmp/gh-decide-log-notdir";
      writeFileSync(notDir, "x");
      await logDecision(notDir, {
        kind: "decide",
        request: "x",
        result: "full",
        confidence: null,
        latencyMs: 1,
        fallback: false,
        reason: "t",
      });
    } finally {
      if (saved === undefined) delete process.env.LIQUID_API_KEY;
      else process.env.LIQUID_API_KEY = saved;
    }
  });
});

describe("chooseRecovery（fail-safe）", () => {
  const f = { id: "fix", reason: "r", task: "t" };
  const mk = (a: unknown) =>
    (async () => ({ ok: true, json: async () => ({ answers: { recovery: a } }) })) as unknown as typeof fetch;
  test("正常choiceは通す", async () => {
    setKey("liquid_test");
    try {
      expect(await chooseRecovery(f, mk({ choice: "oracle", confidence: 0.9 }))).toBe("oracle");
      expect(await chooseRecovery(f, mk({ choice: "escalate_tier", confidence: 0.9 }))).toBe("escalate_tier");
    } finally {
      restore();
    }
  });
  test("不正choice・低confidence・prototypeキーはabort", async () => {
    setKey("liquid_test");
    try {
      expect(await chooseRecovery(f, mk({ choice: "rm", confidence: 0.9 }))).toBe("abort");
      expect(await chooseRecovery(f, mk({ choice: "oracle", confidence: 0.01 }))).toBe("abort");
      expect(await chooseRecovery(f, mk({ choice: "toString", confidence: 0.9 }))).toBe("abort");
    } finally {
      restore();
    }
  });
  test("key未設定・HTTP失敗はabort", async () => {
    setKey(undefined);
    try {
      expect(await chooseRecovery(f)).toBe("abort");
    } finally {
      restore();
    }
  });
});

describe("chooseWorkflow", () => {
  const mk = (a: unknown) =>
    (async () => ({ ok: true, json: async () => ({ answers: { workflow: a } }) })) as unknown as typeof fetch;
  test("bugfix選択・不正/低confidence/key無しはnone", async () => {
    setKey("liquid_test");
    try {
      expect(await chooseWorkflow("t", mk({ choice: "bugfix", confidence: 0.9 }))).toBe("bugfix");
      expect(await chooseWorkflow("t", mk({ choice: "bugfix", confidence: 0.01 }))).toBe("none");
      expect(await chooseWorkflow("t", mk({ choice: "x", confidence: 0.9 }))).toBe("none");
    } finally {
      restore();
    }
    setKey(undefined);
    try {
      expect(await chooseWorkflow("t")).toBe("none");
    } finally {
      restore();
    }
  });
});

/* ───────── プロバイダ切替（d1 / jev）と shadow ─────────
 * 新 env の既定は preload（src/test-setup.ts）で固定済み。各テストで set → finally で戻す */
describe("プロバイダ選択（d1 / jev）", () => {
  const ENVS = [
    "GRAPHHOPPER_DECISION_PROVIDER",
    "GRAPHHOPPER_DECISION_SHADOW",
    "GRAPHHOPPER_JEV_MODEL",
    "OPENCODE_API_KEY",
  ] as const;
  const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  const setEnv = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const restoreEnvs = () => {
    for (const k of ENVS) setEnv(k, saved[k]);
    process.env.GRAPHHOPPER_DECISION_SHADOW = "off";
  };
  const Q = { q: { type: "noul", instructions: "?" } } as const;

  const seen: { url: string; auth: string | undefined; model: unknown; body: unknown }[] = [];
  const recordingFetch = (respond: (n: number) => Response) =>
    (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model?: unknown };
      seen.push({
        url: String(url),
        auth: (init.headers as Record<string, string> | undefined)?.Authorization,
        model: body.model,
        body,
      });
      return respond(seen.length);
    }) as unknown as typeof fetch;

  test("決定論的な既定: primary=d1 / shadow=jev / キー要否", () => {
    try {
      for (const k of ENVS) setEnv(k, undefined);
      expect(primaryProviderName()).toBe("d1");
      expect(shadowProviderName("d1")).toBe("jev");
      expect(shadowProviderName("jev")).toBeNull();
      setEnv("GRAPHHOPPER_DECISION_SHADOW", "off");
      expect(shadowProviderName("d1")).toBeNull();
      setEnv("GRAPHHOPPER_DECISION_PROVIDER", "OPCODE");
      expect(primaryProviderName()).toBe("d1");
      setEnv("GRAPHHOPPER_DECISION_PROVIDER", "JEV");
      expect(primaryProviderName()).toBe("jev");
      setEnv("LIQUID_API_KEY", undefined);
      expect(decisionAvailable("d1")).toBe(false);
      expect(decisionAvailable("jev")).toBe(true);
    } finally {
      restoreEnvs();
      restore();
    }
  });

  test("jev: キー無しでもヘッダ無しで叩ける（既定モデルは free）", async () => {
    const savedKey = process.env.LIQUID_API_KEY;
    delete process.env.LIQUID_API_KEY;
    seen.length = 0;
    try {
      const r = await callDecision(
        "s",
        Q,
        recordingFetch(() => ({ ok: true, json: async () => ({ answers: { q: { noul: 0.7 } } }) }) as Response),
        1000,
        PROVIDERS.jev,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.provider).toBe("jev");
        expect(r.model).toBe(JEV_DEFAULT_MODEL);
      }
      expect(seen[0]?.url).toBe(JEV_API_URL);
      expect(seen[0]?.auth).toBeUndefined();
      expect(seen[0]?.model).toBe(JEV_DEFAULT_MODEL);
    } finally {
      if (savedKey !== undefined) process.env.LIQUID_API_KEY = savedKey;
    }
  });

  test("jev: free が402→OPENCODE_API_KEY があれば有料モデルへ落ちる", async () => {
    try {
      setEnv("OPENCODE_API_KEY", "zen_test");
      seen.length = 0;
      const r = await callDecision(
        "s",
        Q,
        recordingFetch((n) =>
          n === 1
            ? ({ ok: false, status: 402 } as Response)
            : ({ ok: true, json: async () => ({ answers: { q: { noul: 0.8 } } }) } as Response),
        ),
        2000,
        PROVIDERS.jev,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model).toBe(JEV_PAID_MODEL);
      expect(seen.map((s) => s.model)).toEqual([JEV_DEFAULT_MODEL, JEV_PAID_MODEL]);
      expect(seen[1]?.auth).toBe("Bearer zen_test");
    } finally {
      restoreEnvs();
    }
  });

  test("jev: 402でもキーが無ければ有料は叩かない（課金ゲート）", async () => {
    try {
      setEnv("OPENCODE_API_KEY", undefined);
      seen.length = 0;
      const r = await callDecision("s", Q, recordingFetch(() => ({ ok: false, status: 402 }) as Response), 2000, PROVIDERS.jev);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("402");
      expect(seen).toHaveLength(1);
    } finally {
      restoreEnvs();
    }
  });

  test("jev: 400（リクエスト不正）では有料へ落とさない", async () => {
    try {
      setEnv("OPENCODE_API_KEY", "zen_test");
      seen.length = 0;
      await callDecision("s", Q, recordingFetch(() => ({ ok: false, status: 400 }) as Response), 2000, PROVIDERS.jev);
      expect(seen).toHaveLength(1);
    } finally {
      restoreEnvs();
    }
  });

  test("jev: timeout は次モデルへ落とさない（待ち時間を倍にしない）", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    try {
      setEnv("OPENCODE_API_KEY", "zen_test");
      const t = performance.now();
      const r = await callDecision("s", Q, hang, 60, PROVIDERS.jev);
      expect(r.ok).toBe(false);
      expect(performance.now() - t).toBeLessThan(1000);
    } finally {
      restoreEnvs();
    }
  });

  test("予算はモデル間で共有（free の消費分を差し引いて有料を打つ）", async () => {
    /* 1回目は 60ms かけて 402、2回目は残り予算で打ち切られる。
     * 逐次 timeout(100ms) を2回使う実装なら 200ms 近くかかる＝ここで落ちる */
    const slow402 = ((_u: string, init: RequestInit) =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => res({ ok: false, status: 402 }), 60);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          rej(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    try {
      setEnv("OPENCODE_API_KEY", "zen_test");
      const t = performance.now();
      const r = await callDecision("s", Q, slow402, 100, PROVIDERS.jev);
      expect(r.ok).toBe(false);
      expect(performance.now() - t).toBeLessThan(180);
    } finally {
      restoreEnvs();
    }
  });
});

describe("decideRoute の shadow（並走比較）", () => {
  const ENVS = ["GRAPHHOPPER_DECISION_SHADOW", "GRAPHHOPPER_DECISION_PROVIDER", "LIQUID_API_KEY"] as const;
  const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  const restoreEnvs = () => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.env.GRAPHHOPPER_DECISION_SHADOW = "off";
  };
  const tmpRoot = async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    return mkdtempSync(`${tmpdir()}/gh-shadow-`);
  };
  const lines = async (root: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(root, ".graphhopper", "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  /* url で d1 と jev を撃ち分ける（d1=light, jev=full） */
  const splitFetch = (calls: string[]) =>
    (async (url: string) => {
      const isJev = String(url).includes("opencode.ai");
      calls.push(isJev ? "jev" : "d1");
      return {
        ok: true,
        json: async () => ({
          answers: {
            route: { choice: isJev ? "full" : "light", confidence: isJev ? 0.9 : 0.8 },
            difficulty: { choice: "normal", confidence: 0.7 },
          },
        }),
      };
    }) as unknown as typeof fetch;

  test("shadow行がdecision_idで紐付き、primaryの結果を変えない", async () => {
    const root = await tmpRoot();
    process.env.LIQUID_API_KEY = "liquid_test";
    process.env.GRAPHHOPPER_DECISION_SHADOW = "jev";
    try {
      const calls: string[] = [];
      const r = await decideRoute("typoを直す", splitFetch(calls), { root });
      expect(r.route).toBe("light");
      await Promise.all(pendingShadows());
      const rows = await lines(root);
      const decide = rows.find((x) => x.kind === "decide");
      const shadow = rows.find((x) => x.kind === "shadow");
      expect(decide).toMatchObject({ result: "light", provider: "d1" });
      expect(shadow).toMatchObject({
        provider: "jev",
        result: "full",
        rawChoice: "full",
        fallback: false,
      });
      expect(shadow?.decision_id).toBe(decide?.id);
      expect(calls).toEqual(["d1", "jev"]);
    } finally {
      restoreEnvs();
    }
  });

  test("shadow失敗でもprimaryは成功し、shadow行はfallback:true", async () => {
    const root = await tmpRoot();
    process.env.LIQUID_API_KEY = "liquid_test";
    process.env.GRAPHHOPPER_DECISION_SHADOW = "jev";
    try {
      const fake = (async (url: string) => {
        if (String(url).includes("opencode.ai")) throw new Error("shadow down");
        return {
          ok: true,
          json: async () => ({ answers: { route: { choice: "direct", confidence: 0.9 } } }),
        };
      }) as unknown as typeof fetch;
      const r = await decideRoute("質問", fake, { root });
      expect(r.route).toBe("direct");
      await Promise.all(pendingShadows());
      const rows = await lines(root);
      expect(rows.find((x) => x.kind === "shadow")).toMatchObject({
        result: "error",
        fallback: true,
      });
    } finally {
      restoreEnvs();
    }
  });

  test("shadow=off なら呼ばない（root指定でも1行だけ）", async () => {
    const root = await tmpRoot();
    process.env.LIQUID_API_KEY = "liquid_test";
    process.env.GRAPHHOPPER_DECISION_SHADOW = "off";
    try {
      const calls: string[] = [];
      await decideRoute("何か", splitFetch(calls), { root });
      await Promise.all(pendingShadows());
      const rows = await lines(root);
      expect(rows).toHaveLength(1);
      expect(calls).toEqual(["d1"]);
    } finally {
      restoreEnvs();
    }
  });

  test("root無指定ならshadowも走らない（テスト・単発呼び出しを汚さない）", async () => {
    process.env.LIQUID_API_KEY = "liquid_test";
    process.env.GRAPHHOPPER_DECISION_SHADOW = "jev";
    try {
      const calls: string[] = [];
      await decideRoute("何か", splitFetch(calls));
      await Promise.all(pendingShadows());
      expect(calls).toEqual(["d1"]);
    } finally {
      restoreEnvs();
    }
  });

  test("primary=jev なら shadow は既定で走らない", async () => {
    const root = await tmpRoot();
    const savedProv = process.env.GRAPHHOPPER_DECISION_PROVIDER;
    delete process.env.GRAPHHOPPER_DECISION_SHADOW;
    process.env.GRAPHHOPPER_DECISION_PROVIDER = "jev";
    delete process.env.LIQUID_API_KEY;
    try {
      const calls: string[] = [];
      const r = await decideRoute("何か", splitFetch(calls), { root });
      expect(r.route).toBe("full");
      await Promise.all(pendingShadows());
      expect(calls).toEqual(["jev"]);
    } finally {
      if (savedProv === undefined) delete process.env.GRAPHHOPPER_DECISION_PROVIDER;
      else process.env.GRAPHHOPPER_DECISION_PROVIDER = savedProv;
      delete process.env.LIQUID_API_KEY;
      restoreEnvs();
    }
  });
});
