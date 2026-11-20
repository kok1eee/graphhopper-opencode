/** graphhopper_invoke の unit test（実opencode runはT1の1回のみ・ここではseam差替え）。 */
import { describe, expect, test, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ANGLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEPTH_ENV,
  FIRST_OUTPUT_JUDGEMENT_MS,
  FIRST_OUTPUT_MS,
  MAX_DEPTH,
  MAX_TIMEOUT_MS,
  PROMPT_MAX_CHARS,
  SALVAGE_PROMPT,
  SALVAGE_TIMEOUT_MS,
  SIMPLIFY_TIMEOUT_MS,
  STDOUT_MAX_CHARS,
  alternativeModel,
  buildArgs,
  defaultFirstOutputMs,
  defaultTimeoutMs,
  invoke,
  newSessionID,
  resolveModel,
  runChild,
  runWithRecovery,
  withTimeBudget,
  type InvokeResult,
  type RunOnceOpts,
  type SpawnFn,
} from "./invoke";
import { readConfig, setCascade, startGoal } from "./state";

interface FakeProc extends EventEmitter {
  pid: number;
  killCalled: string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeSpawn(behavior: (p: FakeProc) => void): SpawnFn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    const p = new EventEmitter() as FakeProc;
    p.pid = 424242;
    p.killCalled = [];
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => behavior(p), 0);
    return p as unknown as ChildProcess;
  }) as SpawnFn;
}

const okSpawn: SpawnFn = fakeSpawn((p) => {
  p.stdout.emit("data", Buffer.from("hello", "utf8"));
  p.emit("exit", 0);
});

/** GRAPHHOPPER_CONFIG を一時ファイルへ向ける（実ユーザー設定を読まない） */
function withGlobal(json: object, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.GRAPHHOPPER_CONFIG;
  const path = join(mkdtempSync(join(tmpdir(), "gh-invoke-cfg-")), "global.json");
  writeFileSync(path, JSON.stringify(json), "utf8");
  process.env.GRAPHHOPPER_CONFIG = path;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
    else process.env.GRAPHHOPPER_CONFIG = prev;
  });
}

/** 呼ばれた順に結果を返す偽の run（回復ループの単体テスト用） */
function fakeRun(results: InvokeResult[]): { run: (o: RunOnceOpts) => Promise<InvokeResult>; calls: RunOnceOpts[] } {
  const calls: RunOnceOpts[] = [];
  const run = (o: RunOnceOpts): Promise<InvokeResult> => {
    calls.push(o);
    const r = results[Math.min(calls.length - 1, results.length - 1)];
    if (!r) throw new Error("fakeRun: 結果が足りない");
    return Promise.resolve(r);
  };
  return { run, calls };
}

const ok = (output: string, extra: Partial<InvokeResult> = {}): InvokeResult => ({
  output,
  timedOut: false,
  elapsedMs: 1000,
  fallbackWarning: false,
  cancelled: false,
  ...extra,
});

afterEach(() => {
  delete process.env[DEPTH_ENV];
});

describe("時間の上限と持ち時間の明示", () => {
  test("invoke の上限は 600 秒・角度は 300 秒・既定は変えない", () => {
    expect(MAX_TIMEOUT_MS).toBe(600000);
    expect(ANGLE_TIMEOUT_MS).toBe(300000);
    expect(DEFAULT_TIMEOUT_MS).toBe(120000);
    expect(defaultTimeoutMs("graphhopper-advisor")).toBe(240000);
    expect(defaultTimeoutMs("graphhopper-verifier")).toBe(DEFAULT_TIMEOUT_MS);
  });
  test("withTimeBudget は先頭に持ち時間を足し、本文は変えない", () => {
    const got = withTimeBudget("本文です", 90_000);
    expect(got.startsWith("[invoke] 持ち時間: 最大 90 秒")).toBe(true);
    expect(got.endsWith("\n\n本文です")).toBe(true);
    expect(withTimeBudget("x", 300)).toContain("最大 1 秒");
  });
});

describe("invoke 引数検証", () => {
  test("未知agent→エラー文字列", async () => {
    const out = await invoke({ agent: "nope", prompt: "hi", root: "/tmp" }, okSpawn);
    expect(out).toMatch("unknown agent");
  });
  test("不正model→エラー文字列", async () => {
    const out = await invoke(
      { agent: "graphhopper-librarian", model: "no-slash here", prompt: "hi", root: "/tmp" },
      okSpawn,
    );
    expect(out).toMatch("invalid model");
  });
  test("prompt超過→エラー文字列", async () => {
    const out = await invoke(
      { agent: "graphhopper-librarian", prompt: "x".repeat(PROMPT_MAX_CHARS + 1), root: "/tmp" },
      okSpawn,
    );
    expect(out).toMatch("prompt too long");
  });
  test("depth>=1→再帰拒否", async () => {
    process.env[DEPTH_ENV] = String(MAX_DEPTH);
    const out = await invoke({ agent: "graphhopper-librarian", prompt: "hi", root: "/tmp" }, okSpawn);
    expect(out).toMatch("nested");
  });
});

describe("buildArgs", () => {
  test("基本形（-- 境界・shell非経由の配列）", () => {
    const a = buildArgs({ agent: "graphhopper-librarian", model: "p/m", dir: "/r", title: "t", prompt: "hi" });
    expect(a).toEqual(["run", "--standalone", "--model", "p/m", "--agent", "graphhopper-librarian", "--title", "t", "--", "hi"]);
  });
  test("model省略時はflag自体付けない", () => {
    const a = buildArgs({ agent: "graphhopper-librarian", dir: "/r", title: "t", prompt: "hi" });
    expect(a.includes("--model")).toBe(false);
  });
  test("variant 付き model はそのまま --model に渡す", () => {
    const a = buildArgs({
      agent: "graphhopper-advisor",
      model: "claude-oauth/claude-opus-5-5#xhigh",
      dir: "/r",
      title: "t",
      prompt: "hi",
    });
    expect(a[a.indexOf("--model") + 1]).toBe("claude-oauth/claude-opus-5-5#xhigh");
  });
  test("先に決めたセッションIDを --session で渡す（無ければ flag を付けない）", () => {
    const a = buildArgs({ agent: "graphhopper-simplify", dir: "/r", title: "t", prompt: "hi", sessionID: "ses_x1" });
    expect(a[a.indexOf("--session") + 1]).toBe("ses_x1");
    expect(a.slice(a.indexOf("--"), a.indexOf("--") + 1)).toEqual(["--"]);
    const b = buildArgs({ agent: "graphhopper-simplify", dir: "/r", title: "t", prompt: "hi" });
    expect(b.includes("--session")).toBe(false);
  });
  test("先頭--modelのpromptもflag化されない", () => {
    const a = buildArgs({ agent: "graphhopper-librarian", dir: "/r", title: "t", prompt: "--model evil" });
    const sep = a.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(a.slice(sep + 1)).toEqual(["--model evil"]);
  });
});

describe("defaultTimeoutMs", () => {
  test("advisor / oracle だけ 240 秒（xhigh で 120 秒を超えうる）", () => {
    expect(defaultTimeoutMs("graphhopper-advisor")).toBe(240000);
    expect(defaultTimeoutMs("graphhopper-oracle")).toBe(240000);
    expect(defaultTimeoutMs("graphhopper-librarian")).toBe(120000);
    expect(defaultTimeoutMs("graphhopper-verifier")).toBe(120000);
  });
  test("simplify だけ 300 秒（成功 10 回の最長が 273 秒）", () => {
    expect(defaultTimeoutMs("graphhopper-simplify")).toBe(SIMPLIFY_TIMEOUT_MS);
    expect(defaultTimeoutMs("graphhopper-simplify")).toBe(300000);
  });
  test("最初の出力を待つ上限は判断ノードだけ 90 秒", () => {
    expect(defaultFirstOutputMs("graphhopper-librarian")).toBe(FIRST_OUTPUT_MS);
    expect(defaultFirstOutputMs("graphhopper-simplify")).toBe(FIRST_OUTPUT_MS);
    expect(defaultFirstOutputMs("graphhopper-advisor")).toBe(FIRST_OUTPUT_JUDGEMENT_MS);
    expect(defaultFirstOutputMs("graphhopper-oracle")).toBe(FIRST_OUTPUT_JUDGEMENT_MS);
    expect(FIRST_OUTPUT_MS).toBe(45000);
    expect(FIRST_OUTPUT_JUDGEMENT_MS).toBe(90000);
  });
  test("回収の持ち時間は 90 秒", () => {
    expect(SALVAGE_TIMEOUT_MS).toBe(90000);
  });
  test("セッションIDは ses_ で始まる 27 文字・毎回違う", () => {
    const a = newSessionID();
    expect(a).toMatch(/^ses_[0-9a-f]{24}$/);
    expect(newSessionID()).not.toBe(a);
  });
});

describe("resolveModel", () => {
  test("引数優先", () => {
    expect(resolveModel("/tmp/gh-nope", "graphhopper-librarian", "p/m")).toBe("p/m");
  });
  test("config既定を読む", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-invoke-"));
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ agents: { "graphhopper-librarian": "z/x" } }),
      "utf8",
    );
    expect(resolveModel(root, "graphhopper-librarian")).toBe("z/x");
  });
});

describe("invoke のモデル制限（config 駆動）", () => {
  test("引数の deny 一致を拒否（source: arg）", async () => {
    const { invokeStructured } = await import("./invoke");
    await withGlobal({ model_deny: ["opencode-go/gpt-*"] }, async () => {
      const r = await invokeStructured(
        { agent: "graphhopper-librarian", model: "opencode-go/gpt-6-luna", prompt: "hi", root: "/tmp" },
        okSpawn,
      );
      expect(r.output).toContain("denied by model_deny");
      expect(r.output).toContain("source: arg");
      expect(r.output).toContain("model_deny");
    });
  });

  test("config 由来の拒否も止まる（source: config）", async () => {
    const { invokeStructured } = await import("./invoke");
    await withGlobal(
      {
        agents: { "graphhopper-librarian": "opencode-go/kimi-k3.1-pro" },
        model_deny: ["opencode-go/kimi-*"],
      },
      async () => {
        const r = await invokeStructured(
          { agent: "graphhopper-librarian", prompt: "hi", root: "/tmp" },
          okSpawn,
        );
        expect(r.output).toContain("denied by model_deny");
        expect(r.output).toContain("source: config");
      },
    );
  });

  test("allow 非空でモデル未解決なら拒否", async () => {
    const { invokeStructured } = await import("./invoke");
    await withGlobal({ model_allow: ["bedrock/*"] }, async () => {
      const r = await invokeStructured(
        { agent: "graphhopper-librarian", prompt: "hi", root: "/tmp" },
        okSpawn,
      );
      expect(r.output).toContain("model unresolved");
      expect(r.output).toContain("model_allow");
    });
  });

  test("許可されたモデルは通る", async () => {
    const { invokeStructured } = await import("./invoke");
    await withGlobal({ model_allow: ["opencode-go/*"] }, async () => {
      const r = await invokeStructured(
        { agent: "graphhopper-librarian", model: "opencode-go/deepseek-v4.1-flash", prompt: "hi", root: "/tmp" },
        okSpawn,
      );
      expect(r.output).toContain("hello");
    });
  });
});

describe("resolveModel の昇格時の表（cascade.agents.quality）", () => {
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), "gh-invoke-cascade-"));
  const cfg = (apply: "always" | "escalated") => ({
    agents: { "graphhopper-simplify": "opencode-go/deepseek-v4.1-flash" },
    cascade: {
      enabled: true,
      escalate: "claude-oauth/claude-sonnet-5-5",
      agents: { apply, quality: { "graphhopper-simplify": "claude-oauth/claude-sonnet-5-5" } },
    },
  });

  test("進行中の goal が無ければ昇格時の表を使わない（引数 > config の割当）", async () => {
    const root = tmpRoot();
    await withGlobal(cfg("always"), async () => {
      expect(resolveModel(root, "graphhopper-simplify")).toBe("opencode-go/deepseek-v4.1-flash");
      expect(resolveModel(root, "graphhopper-simplify", "p/m")).toBe("p/m");
    });
  });

  test("apply=always なら goal の段に関係なく表のモデル", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "ses_x");
    await withGlobal(cfg("always"), async () => {
      expect(resolveModel(root, "graphhopper-simplify")).toBe("claude-oauth/claude-sonnet-5-5");
    });
  });

  test("apply=escalated は goal が昇格済みのときだけ表のモデル", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "ses_x");
    await withGlobal(cfg("escalated"), async () => {
      expect(resolveModel(root, "graphhopper-simplify")).toBe("opencode-go/deepseek-v4.1-flash");
      setCascade(root, { level: "escalated", reason: "hard", model: null, restore: null, children: [], at: new Date().toISOString() });
      expect(resolveModel(root, "graphhopper-simplify")).toBe("claude-oauth/claude-sonnet-5-5");
    });
  });

  test("表に無い役は config の割当のまま", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "ses_x");
    await withGlobal(cfg("always"), async () => {
      expect(resolveModel(root, "graphhopper-librarian")).toBeUndefined();
    });
  });
});

describe("alternativeModel（やり直し・回収に使う代替モデル）", () => {
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), "gh-invoke-alt-"));

  test("モデル明示の呼び出しは替えない", async () => {
    const root = tmpRoot();
    await withGlobal({ cascade: { enabled: true, escalate: "claude-oauth/claude-sonnet-5-5" } }, async () => {
      const alt = alternativeModel({ cfg: readConfig(root), agent: "graphhopper-simplify", current: "p/m", explicit: true });
      expect(alt).toBe("p/m");
    });
  });

  test("表のモデル → 無ければ escalate。cascade 無効なら現在のまま", async () => {
    const root = tmpRoot();
    await withGlobal(
      { cascade: { enabled: true, escalate: "claude-oauth/claude-sonnet-5-5" } },
      async () => {
        expect(
          alternativeModel({ cfg: readConfig(root), agent: "graphhopper-simplify", current: "p/m", explicit: false }),
        ).toBe("claude-oauth/claude-sonnet-5-5");
      },
    );
    await withGlobal({ cascade: { enabled: false, escalate: "claude-oauth/claude-sonnet-5-5" } }, async () => {
      expect(
        alternativeModel({ cfg: readConfig(root), agent: "graphhopper-simplify", current: "p/m", explicit: false }),
      ).toBe("p/m");
    });
  });

  test("現在と同じ・model_deny 一致なら替えない", async () => {
    const root = tmpRoot();
    const same = "claude-oauth/claude-sonnet-5-5";
    await withGlobal({ cascade: { enabled: true, escalate: same } }, async () => {
      expect(alternativeModel({ cfg: readConfig(root), agent: "x", current: same, explicit: false })).toBe(same);
    });
    await withGlobal(
      { cascade: { enabled: true, escalate: same }, model_deny: ["claude-oauth/*"] },
      async () => {
        expect(
          alternativeModel({ cfg: readConfig(root), agent: "x", current: "opencode-go/deepseek-v4.1-flash", explicit: false }),
        ).toBe("opencode-go/deepseek-v4.1-flash");
      },
    );
  });
});

describe("runChild", () => {
  test("成功出力", async () => {
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, okSpawn);
    expect(r.output).toBe("hello");
    expect(r.timedOut).toBe(false);
  });
  test("30000文字打切り", async () => {
    const big: SpawnFn = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from("y".repeat(STDOUT_MAX_CHARS + 10), "utf8"));
      p.emit("exit", 0);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, big);
    expect(r.output).toMatch("truncated");
  });
  test("非0終了はstderr末尾付き", async () => {
    const bad: SpawnFn = fakeSpawn((p) => {
      p.stderr.emit("data", Buffer.from("boom happened", "utf8"));
      p.emit("exit", 1);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, bad);
    expect(r.output).toMatch("code 1");
    expect(r.output).toMatch("boom happened");
  });
  test("fallback警告を検出", async () => {
    const fb: SpawnFn = fakeSpawn((p) => {
      p.stderr.emit("data", Buffer.from("Falling back to default agent", "utf8"));
      p.emit("exit", 0);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, cwd: "/tmp", childEnv: {} }, fb);
    expect(r.fallbackWarning).toBe(true);
    expect(r.output).toMatch("warning:");
  });
  test("timeoutでkill", async () => {
    let killed = "";
    const hang: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999999;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        killed = s;
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    // process.kill(-pid)は存在しないpidで失敗→child.killにフォールバックする想定
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 100, cwd: "/tmp", childEnv: {} },
      hang,
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toMatch("timeout");
    expect(killed).toBe("SIGKILL");
  }, 15000);
  test("SIGTERM で子が先に exit しても timeout として報告する（非0終了と取り違えない）", async () => {
    const termExit: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999995;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        // 実プロセスは SIGTERM で exit 143 を返す。SIGKILL までは待たない
        if (s === "SIGTERM") setTimeout(() => p.emit("exit", 143), 5);
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 1000, cwd: "/tmp", childEnv: {}, killGraceMs: 5000 },
      termExit,
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain("timeout after");
    expect(r.output).toContain("limit 1s");
    expect(r.output).not.toContain("exited with code");
    // 経過秒数も返す（上限の見直しと較正のため）
    expect(r.elapsedMs).toBeGreaterThanOrEqual(900);
  }, 15000);
  test("timeout時もstderr末尾が付く・空なら省略", async () => {
    const hangWithErr: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999997;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      // runChildのdataリスナ装着後に届くよう遅延させる（同期emitは取りこぼす）
      setTimeout(() => p.stderr.emit("data", Buffer.from("still working on file X\n", "utf8")), 10);
      (p as unknown as { kill: (s: string) => boolean }).kill = (_s: string) => true;
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 100, cwd: "/tmp", childEnv: {} },
      hangWithErr,
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toMatch("stderr tail:");
    expect(r.output).toMatch("still working on file X");
    const hangSilent: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999996;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (_s: string) => true;
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const r2 = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 100, cwd: "/tmp", childEnv: {} },
      hangSilent,
    );
    expect(r2.timedOut).toBe(true);
    expect(r2.output).not.toMatch("stderr tail:");
  }, 15000);
});

describe("invoke 並列安全（中断・heartbeat・ずらし）", () => {
  function hangProc(onKill?: (s: string) => void): SpawnFn {
    return ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999998;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        onKill?.(s);
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
  }

  test("abortでkillしcancelledで返す", async () => {
    const kills: string[] = [];
    const ac = new AbortController();
    const p = runChild(
      "opencode",
      ["run"],
      { timeoutMs: 5000, cwd: "/tmp", childEnv: {}, signal: ac.signal, killGraceMs: 20 },
      hangProc((s) => kills.push(s)),
    );
    setTimeout(() => ac.abort(), 30);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toMatch("cancelled");
    expect(kills).toContain("SIGTERM");
  });

  test("abort 後に子が SIGTERM で exit しても cancelled として報告する（非0終了と取り違えない）", async () => {
    const ac = new AbortController();
    const termExit: SpawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 999994;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        if (s === "SIGTERM") setTimeout(() => p.emit("exit", 143), 5);
        return true;
      };
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const running = runChild(
      "opencode",
      ["run"],
      { timeoutMs: 5000, cwd: "/tmp", childEnv: {}, signal: ac.signal, killGraceMs: 5000 },
      termExit,
    );
    setTimeout(() => ac.abort(), 20);
    const r = await running;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("cancelled");
    expect(r.output).not.toContain("exited with code");
  }, 15000);

  test("heartbeat tickが呼ばれる", async () => {
    const ticks: number[] = [];
    const ac = new AbortController();
    const p = runChild(
      "opencode",
      ["run"],
      {
        timeoutMs: 5000,
        cwd: "/tmp",
        childEnv: {},
        signal: ac.signal,
        killGraceMs: 20,
        heartbeatMs: 20,
        onTick: (ms) => ticks.push(ms),
      },
      hangProc(),
    );
    setTimeout(() => ac.abort(), 70);
    await p;
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  test("delayMsで起動がずれる", async () => {
    const { invokeStructured } = await import("./invoke");
    const t0 = Date.now();
    const r = await invokeStructured(
      { agent: "graphhopper-librarian", prompt: "hi", root: "/tmp", delayMs: 80 },
      okSpawn,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
    expect(r.cancelled).toBe(false);
    expect(r.output).toMatch("hello");
  });

  test("spawn前abortはspawnせずcancelled", async () => {
    const { invokeStructured } = await import("./invoke");
    const ac = new AbortController();
    ac.abort();
    let spawned = false;
    const spy: SpawnFn = ((_c: string, _a: string[], _o: unknown) => {
      spawned = true;
      const p = new EventEmitter() as FakeProc;
      p.pid = 1;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    const r = await invokeStructured(
      { agent: "graphhopper-librarian", prompt: "hi", root: "/tmp" },
      spy,
      { signal: ac.signal },
    );
    expect(spawned).toBe(false);
    expect(r.cancelled).toBe(true);
  });
});

describe("invoke 子envのbearer除去", () => {
  test("壊れたAWS_BEARER_TOKEN_BEDROCKは子に渡さない", async () => {
    process.env["AWS_BEARER_TOKEN_BEDROCK"] = "ABSK-stale-test-value";
    let seen: Record<string, string | undefined> | null = null;
    const capture: SpawnFn = ((_cmd: string, _args: string[], opts: unknown) => {
      seen = (opts as { env: Record<string, string | undefined> }).env;
      const p = new EventEmitter() as unknown as FakeProc;
      p.pid = 424243;
      p.killCalled = [];
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      setTimeout(() => {
        p.stdout.emit("data", Buffer.from("ok", "utf8"));
        p.emit("exit", 0);
      }, 0);
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    try {
      const root = mkdtempSync(join(tmpdir(), "gh-invoke-bearer-"));
      await invoke({ agent: "graphhopper-librarian", prompt: "hi", root }, capture);
      expect(seen).not.toBeNull();
      expect(seen!["AWS_BEARER_TOKEN_BEDROCK"]).toBeUndefined();
    } finally {
      delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    }
  });
});

describe("runChild: 最初の出力を待つ上限（無応答の打ち切り）", () => {
  /** SIGTERM で exit を返す偽プロセス（group kill の代わり） */
  function killableSpawn(onStart?: (p: FakeProc) => void): SpawnFn {
    return ((_cmd: string, _args: string[], _opts: unknown) => {
      const p = new EventEmitter() as FakeProc;
      p.pid = 888888;
      p.killCalled = [];
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (s: string) => {
        p.killCalled.push(s);
        setTimeout(() => p.emit("exit", null), 0);
        return true;
      };
      onStart?.(p);
      return p as unknown as ChildProcess;
    }) as SpawnFn;
  }

  test("出力が来ないまま上限を超えると idleTimedOut で打ち切る", async () => {
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 5000, firstOutputMs: 100, cwd: "/tmp", childEnv: {} },
      killableSpawn(),
    );
    expect(r.idleTimedOut).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toMatch("no output for 0s");
    expect(r.failed).toBe(true);
  }, 15000);

  test("持ち時間が先に切れたら timedOut だけが立つ（無応答の印と重ならない）", async () => {
    const r = await runChild(
      "opencode",
      ["run"],
      { timeoutMs: 50, firstOutputMs: 60, killGraceMs: 200, cwd: "/tmp", childEnv: {} },
      killableSpawn(),
    );
    expect(r.timedOut).toBe(true);
    expect(r.idleTimedOut).toBe(false);
  }, 15000);

  test("stderr の1行目でも打ち切らない（応答が始まっていれば待つ）", async () => {
    const spawn = killableSpawn((p) => {
      setTimeout(() => {
        p.stderr.emit("data", Buffer.from("> graphhopper-simplify · deepseek-v4.1-flash\n", "utf8"));
        setTimeout(() => {
          p.stdout.emit("data", Buffer.from("answer", "utf8"));
          p.emit("exit", 0);
        }, 600);
      }, 20);
    });
    const r = await runChild("opencode", ["run"], { timeoutMs: 5000, firstOutputMs: 400, cwd: "/tmp", childEnv: {} }, spawn);
    expect(r.idleTimedOut).toBe(false);
    expect(r.output).toBe("answer");
  }, 15000);
});

describe("runWithRecovery: 無応答のやり直しと時間切れの回収", () => {
  const base = {
    sessionID: "ses_first",
    timeoutMs: 120000,
    altModel: "claude-oauth/claude-sonnet-5-5",
    salvage: true,
    salvageTimeoutMs: SALVAGE_TIMEOUT_MS,
    nextSessionID: () => "ses_second",
  };

  test("無応答なら新しいセッションで別モデルに1回だけやり直す（残りの持ち時間）", async () => {
    const { run, calls } = fakeRun([
      ok("error: invoke gave no output for 45s (killed; no first output)", { idleTimedOut: true, elapsedMs: 45000 }),
      ok("second answer", { elapsedMs: 20000 }),
    ]);
    const r = await runWithRecovery({ ...base, run, model: "opencode-go/deepseek-v4.1-flash" });
    expect(calls.length).toBe(2);
    expect(calls[1].sessionID).toBe("ses_second");
    expect(calls[1].model).toBe("claude-oauth/claude-sonnet-5-5");
    expect(calls[1].timeoutMs).toBe(75000);
    expect(r.restarted).toBe(true);
    expect(r.salvaged).toBeFalsy();
    expect(r.output).toBe("second answer");
  });

  test("やり直しも無応答なら、回収に進まずエラーで返す（セッションIDつき）", async () => {
    const { run, calls } = fakeRun([
      ok("no output", { idleTimedOut: true, elapsedMs: 45000 }),
      ok("no output again", { idleTimedOut: true, elapsedMs: 10000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(calls.length).toBe(2);
    expect(r.output).toContain("no output again");
    expect(r.output).toContain("session: ses_second");
    expect(r.salvaged).toBeFalsy();
  });

  test("時間切れなら同じセッションに続きを頼み、答えを回収して印を付ける", async () => {
    const { run, calls } = fakeRun([
      ok("partial\nerror: invoke timeout after 120.0s (limit 120s; killed)", { timedOut: true, elapsedMs: 120000 }),
      ok("回収した答え", { elapsedMs: 30000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(calls.length).toBe(2);
    expect(calls[1].sessionID).toBe("ses_first");
    expect(calls[1].model).toBe("claude-oauth/claude-sonnet-5-5");
    expect(calls[1].timeoutMs).toBe(SALVAGE_TIMEOUT_MS);
    expect(calls[1].prompt).toBe(SALVAGE_PROMPT);
    expect(r.salvaged).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.elapsedMs).toBe(150000);
    expect(r.output).toContain("回収した答え");
    expect(r.output).toContain("[invoke: 時間切れのあと、同じセッションから回収した");
    expect(r.output).toContain("session: ses_first");
  });

  test("回収した答えの本文に error: 行があっても失敗にしない（機械値で判定）", async () => {
    const { run } = fakeRun([
      ok("error: invoke timeout after 120.0s", { timedOut: true, failed: true, elapsedMs: 120000 }),
      ok("指摘:\nerror: を握り潰している src/a.ts:1", { elapsedMs: 30000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(r.salvaged).toBe(true);
    expect(r.output).toContain("握り潰している");
  });

  test("回収が非0終了なら失敗（答えとして使わせない）", async () => {
    const { run } = fakeRun([
      ok("error: invoke timeout after 120.0s", { timedOut: true, failed: true, elapsedMs: 120000 }),
      ok("途中\nerror: opencode run exited with code 1", { failed: true, elapsedMs: 5000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(r.salvaged).toBeFalsy();
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain("回収も失敗した");
  });

  test("回収も時間切れなら「回収も失敗した」と出す（答えとしては使わせない）", async () => {
    const { run } = fakeRun([
      ok("error: invoke timeout after 120.0s", { timedOut: true, elapsedMs: 120000 }),
      ok("error: invoke timeout after 90.0s", { timedOut: true, elapsedMs: 90000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(r.salvaged).toBeFalsy();
    expect(r.output).toContain("回収も失敗した");
    expect(r.output).not.toContain("error: invoke timeout after 90.0s");
  });

  test("回収を切っていれば spawn は 1 回だけ（verify の角度）", async () => {
    const { run, calls } = fakeRun([ok("error: invoke timeout after 120.0s", { timedOut: true, elapsedMs: 120000 })]);
    const r = await runWithRecovery({ ...base, run, salvage: false });
    expect(calls.length).toBe(1);
    expect(r.salvaged).toBeFalsy();
    expect(r.output).toContain("session: ses_first");
  });

  test("やり直しのあと時間切れなら、やり直したセッションから回収する", async () => {
    const { run, calls } = fakeRun([
      ok("no output", { idleTimedOut: true, failed: true, elapsedMs: 45000 }),
      ok("error: invoke timeout after 75.0s", { timedOut: true, failed: true, elapsedMs: 75000 }),
      ok("回収した答え", { elapsedMs: 20000 }),
    ]);
    const r = await runWithRecovery({ ...base, run, model: "opencode-go/deepseek-v4.1-flash" });
    expect(calls.length).toBe(3);
    expect(calls[2].sessionID).toBe("ses_second");
    expect(calls[2].prompt).toBe(SALVAGE_PROMPT);
    expect(r.restarted).toBe(true);
    expect(r.salvaged).toBe(true);
    expect(r.elapsedMs).toBe(140000);
  });

  test("やり直しのあとの回収も失敗したら、やり直した印を残して時間切れで返す", async () => {
    const { run, calls } = fakeRun([
      ok("no output", { idleTimedOut: true, failed: true, elapsedMs: 45000 }),
      ok("error: invoke timeout after 75.0s", { timedOut: true, failed: true, elapsedMs: 75000 }),
      ok("", { failed: true, elapsedMs: 1000 }),
    ]);
    const r = await runWithRecovery({ ...base, run });
    expect(calls.length).toBe(3);
    expect(r.restarted).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.salvaged).toBeFalsy();
    expect(r.output).toContain("回収も失敗した");
  });

  test("キャンセルではやり直しも回収もしない", async () => {
    const { run, calls } = fakeRun([ok("error: invoke cancelled by client", { cancelled: true, elapsedMs: 3000 })]);
    const r = await runWithRecovery({ ...base, run });
    expect(calls.length).toBe(1);
    expect(r.cancelled).toBe(true);
  });

  test("時間切れでなければ回収しない", async () => {
    const { run, calls } = fakeRun([ok("fine")]);
    const r = await runWithRecovery({ ...base, run });
    expect(calls.length).toBe(1);
    expect(r.salvaged).toBeFalsy();
  });
});

describe("invokeStructured: 無応答のやり直しの配線", () => {
  /** 呼ばれるたびに argv を記録する。silent 回は黙ったまま kill を待ち、それ以外は答えて終わる */
  function scriptedSpawn(silentCalls: number): { spawn: SpawnFn; argv: string[][] } {
    const argv: string[][] = [];
    const spawn = ((_cmd: string, args: string[], _opts: unknown) => {
      argv.push(args);
      const p = new EventEmitter() as FakeProc;
      p.pid = 777777;
      p.killCalled = [];
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      (p as unknown as { kill: (s: string) => boolean }).kill = (sig: string) => {
        p.killCalled.push(sig);
        setTimeout(() => p.emit("exit", null), 0);
        return true;
      };
      if (argv.length > silentCalls) {
        setTimeout(() => {
          p.stdout.emit("data", Buffer.from("answer", "utf8"));
          p.emit("exit", 0);
        }, 0);
      }
      return p as unknown as ChildProcess;
    }) as SpawnFn;
    return { spawn, argv };
  }
  const flag = (a: string[], name: string): string | undefined =>
    a.includes(name) ? a[a.indexOf(name) + 1] : undefined;
  const cfg = {
    agents: { "graphhopper-simplify": "opencode-go/deepseek-v4.1-flash" },
    cascade: { enabled: true, escalate: "claude-oauth/claude-sonnet-5-5" },
  };
  const root = (): string => mkdtempSync(join(tmpdir(), "gh-invoke-restart-"));

  test("最初の出力が来なければ打ち切り、新しいセッション・代替モデルで 1 回やり直す", async () => {
    const { invokeStructured } = await import("./invoke");
    const { spawn, argv } = scriptedSpawn(1);
    await withGlobal(cfg, async () => {
      const r = await invokeStructured({ agent: "graphhopper-simplify", prompt: "hi", root: root() }, spawn, {
        firstOutputMs: 60,
      });
      expect(argv.length).toBe(2);
      expect(flag(argv[0], "--model")).toBe("opencode-go/deepseek-v4.1-flash");
      expect(flag(argv[1], "--model")).toBe("claude-oauth/claude-sonnet-5-5");
      expect(flag(argv[0], "--session")).toMatch(/^ses_[0-9a-f]{24}$/);
      expect(flag(argv[1], "--session")).not.toBe(flag(argv[0], "--session"));
      expect(r.restarted).toBe(true);
      expect(r.output).toBe("answer");
    });
  }, 15000);

  test("モデルを明示した呼び出しは、やり直しでも同じモデル", async () => {
    const { invokeStructured } = await import("./invoke");
    const { spawn, argv } = scriptedSpawn(1);
    await withGlobal(cfg, async () => {
      await invokeStructured(
        { agent: "graphhopper-simplify", model: "opencode-go/kimi-k3", prompt: "hi", root: root() },
        spawn,
        { firstOutputMs: 60 },
      );
      expect(argv.length).toBe(2);
      expect(flag(argv[1], "--model")).toBe("opencode-go/kimi-k3");
    });
  }, 15000);

  test("やり直しも無応答なら 2 回で止まり、無応答の印とセッションIDを返す", async () => {
    const { invokeStructured } = await import("./invoke");
    const { spawn, argv } = scriptedSpawn(99);
    await withGlobal(cfg, async () => {
      const r = await invokeStructured({ agent: "graphhopper-simplify", prompt: "hi", root: root() }, spawn, {
        firstOutputMs: 60,
      });
      expect(argv.length).toBe(2);
      expect(r.idleTimedOut).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.output).toContain(`session: ${flag(argv[1], "--session")}`);
    });
  }, 15000);

  test("出力が来ていれば 1 回で終わる（見張りは最初の出力まで）", async () => {
    const { invokeStructured } = await import("./invoke");
    const { spawn, argv } = scriptedSpawn(0);
    await withGlobal(cfg, async () => {
      const r = await invokeStructured({ agent: "graphhopper-simplify", prompt: "hi", root: root() }, spawn, {
        firstOutputMs: 60,
      });
      expect(argv.length).toBe(1);
      expect(r.restarted).toBeFalsy();
    });
  }, 15000);
});
