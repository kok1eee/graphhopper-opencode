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
  MAX_DEPTH,
  MAX_TIMEOUT_MS,
  PROMPT_MAX_CHARS,
  STDOUT_MAX_CHARS,
  buildArgs,
  defaultTimeoutMs,
  invoke,
  resolveModel,
  runChild,
  withTimeBudget,
  type SpawnFn,
} from "./invoke";

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
