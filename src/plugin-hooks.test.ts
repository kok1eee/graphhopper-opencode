/**
 * plugin の hook 配線テスト（.opencode/plugins/graphhopper/hooks.ts）。
 *
 * ファイルは src/ に置いている。`.opencode/` は dot-dir で `bun test` の既定走査対象外のため。
 *
 * なぜ必要か: 入口d1判定の除外条件（内部prompt・子セッション・goal進行中・キー無し）は
 * 純関数テストだけでは「prompt hook が実際にその条件を見ている」ことを保証できない。
 * hook 登録 → 呼び出し → decisions.jsonl の記録までを fake ctx で固定する。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks, tailLikes } from "../.opencode/plugins/graphhopper/hooks";
import { writeHandoff } from "./handoff";
import { readState, setEvalCmd, setPhase as stateSetPhase, startGoal } from "./state";
import { clearAllWaitTimers } from "../.opencode/plugins/graphhopper/shared";

type HookCb = (event: unknown) => void | Promise<void>;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-plugin-hooks-"));
}

function readRows(root: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(root, ".graphhopper", "decisions.jsonl"), "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** fake ctx。hook のコールバックを捕まえて、テストから直接叩けるようにする。
 * synthetic と instructions.entry は呼ばれた内容を記録する（design g-mwj6481n）。 */
function fakeCtx(opts: {
  parentID?: string | null;
  entryThrows?: boolean;
  /** session.get の挙動。throws=即失敗、hangs=応答しない（prompt hook の期限切れ） */
  get?: "ok" | "throws" | "hangs";
} = {}) {
  const hooks = new Map<string, HookCb[]>();
  const add = (name: string, cb: HookCb) => {
    const list = hooks.get(name) ?? [];
    list.push(cb);
    hooks.set(name, list);
  };
  const synthetic: Array<{ sessionID: string; text: string; description?: string; resume?: boolean }> = [];
  const entries = new Map<string, Map<string, string>>();
  const entryCalls: string[] = [];
  const sessionEntries = (sessionID: string) => {
    const m = entries.get(sessionID) ?? new Map<string, string>();
    entries.set(sessionID, m);
    return m;
  };
  const ctx = {
    tool: { hook: async (name: string, cb: HookCb) => add(name, cb) },
    session: {
      hook: async (name: string, cb: HookCb) => add(name, cb),
      get: async (
        { sessionID }: { sessionID: string },
        getOpts?: { signal?: AbortSignal },
      ) => {
        if (opts.get === "throws") throw new Error("session get failed");
        if (opts.get === "hangs") {
          /* 実 API と同じく signal で打ち切られる（design g-mwkgfssi 判断4） */
          await new Promise((_resolve, reject) => {
            const signal = getOpts?.signal;
            if (!signal) return;
            if (signal.aborted) reject(new Error("aborted"));
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return {
          id: sessionID,
          parentID: opts.parentID ?? null,
        };
      },
      context: async () => [],
      prompt: async () => undefined,
      synthetic: async (input: {
        sessionID: string;
        text: string;
        description?: string;
        resume?: boolean;
      }) => {
        synthetic.push(input);
        return { id: `msg-syn-${synthetic.length}`, sessionID: input.sessionID };
      },
      instructions: {
        entry: {
          list: async ({ sessionID }: { sessionID: string }) => {
            entryCalls.push(`list:${sessionID}`);
            return [...sessionEntries(sessionID).entries()].map(([key, value]) => ({ key, value }));
          },
          put: async ({
            sessionID,
            key,
            value,
          }: {
            sessionID: string;
            key: string;
            value: unknown;
          }) => {
            if (opts.entryThrows) throw new Error("entry unavailable");
            entryCalls.push(`put:${sessionID}:${key}`);
            sessionEntries(sessionID).set(key, String(value));
          },
          remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
            if (opts.entryThrows) throw new Error("entry unavailable");
            entryCalls.push(`remove:${sessionID}:${key}`);
            sessionEntries(sessionID).delete(key);
          },
        },
      },
    },
    event: {
      // イベントを1つも流さない（無限に待たない）
      subscribe: async function* () {
        return;
      },
    },
  };
  const entryValue = (sessionID: string, key = "graphhopper-phase") =>
    sessionEntries(sessionID).get(key) ?? null;
  return { ctx, hooks, synthetic, entryCalls, entryValue, entries };
}

/** d1 の応答を模した fetch（一時的にグローバルを差し替える） */
const patchFetch = (route: "light" | "direct" = "light") => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      answers: {
        route: { choice: route, confidence: 0.3 },
        difficulty: { choice: "normal", confidence: 0.9 },
      },
    }),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

const withKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.LIQUID_API_KEY;
  process.env.LIQUID_API_KEY = "liquid_test";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = saved;
  }
};

const withoutKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.LIQUID_API_KEY;
  delete process.env.LIQUID_API_KEY;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = saved;
  }
};

/** prompt hook を1回叩く */
const runPromptHook = async (
  root: string,
  ctx: unknown,
  hooks: Map<string, HookCb[]>,
  event: { sessionID: string; text: string; metadata?: Record<string, unknown> },
) => {
  await registerHooks({ ctx: ctx as never, root });
  const cb = hooks.get("prompt")?.[0];
  if (!cb) throw new Error("prompt hook が登録されていない");
  await cb({
    sessionID: event.sessionID,
    prompt: { text: event.text },
    metadata: event.metadata,
  });
};

describe("plugin hook: 入口d1判定の prompt hook", () => {
  test("通常の入力では decide 行が残る", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx();
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-main",
          text: "複数ファイルを変更する重い依頼",
        });
        /* 記録は非同期（decideEntry の promise 解決を待つ） */
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(true);
        expect(rows.find((r) => r.kind === "decide")).toMatchObject({
          rawChoice: "light",
          sessionID: "s-main",
        });
      });
    } finally {
      restore();
    }
  });

  test("内部prompt（metadata付き）は decide しない（skip 行のみ）", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx();
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-main",
          text: "[graphhopper-continuation] 続き",
          metadata: { graphhopper_internal: true },
        });
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "internal" });
      });
    } finally {
      restore();
    }
  });

  test("子セッション（parentID あり）は decide しない", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx({ parentID: "s-parent" });
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-child",
          text: "subagent の依頼",
        });
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "child_session" });
      });
    } finally {
      restore();
    }
  });

  test("子セッションか確認できない（取得失敗）ときは decide しない（child_unknown）", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx({ get: "throws" });
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-main",
          text: "複数ファイルを変更する重い依頼",
        });
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "child_unknown" });
      });
    } finally {
      restore();
    }
  });

  test("子セッションかの確認が時間切れでも decide も handoff 案内もしない", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks, synthetic } = fakeCtx({ get: "hangs" });
        await registerHooks({ ctx: ctx as never, root });
        const promptHook = hooks.get("prompt")?.[0];
        if (!promptHook) throw new Error("hook が登録されていない");
        startGoal(root, "手切れのテスト", "ses_a");
        writeHandoff(root, { sessionID: "ses_a" });
        const startedAt = Date.now();
        await promptHook({ sessionID: "s-new", prompt: { text: "続きをやる" } });
        /* 待ちは 400ms（design g-mwkgfssi 判断4）。hook 予算 1500ms まで待たない */
        expect(Date.now() - startedAt).toBeLessThan(600);
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "child_unknown" });
        expect(synthetic).toHaveLength(0);
      });
    } finally {
      restore();
    }
  });

  test("active goal 中は decide しない", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        startGoal(root, "goal 中のテスト", "s-main");
        const { ctx, hooks } = fakeCtx();
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-main",
          text: "goal 中の依頼",
        });
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "active_goal" });
      });
    } finally {
      restore();
    }
  });

  test("APIキー無しの環境では decide 行を残さない", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withoutKey(async () => {
        const { ctx, hooks } = fakeCtx();
        await runPromptHook(root, ctx, hooks, {
          sessionID: "s-main",
          text: "依頼",
        });
        await new Promise((r) => setTimeout(r, 50));
        const rows = readRows(root);
        expect(rows.some((r) => r.kind === "decide")).toBe(false);
        expect(rows[0]).toMatchObject({ kind: "decide-skip", result: "no_api_key" });
      });
    } finally {
      restore();
    }
  });
});

describe("plugin hook: 入口判定は裏で記録するだけ・system は固定・phase案内は entry（g-mwn9al7r）", () => {

  test("判定結果は synthetic で積まず、decisions.jsonl に delivered:false で残る", async () => {
    const root = tmpRoot();
    const restore = patchFetch();
    try {
      await withKey(async () => {
        const { ctx, hooks, synthetic } = fakeCtx();
        await registerHooks({ ctx: ctx as never, root });
        const promptHook = hooks.get("prompt")?.[0];
        const contextHook = hooks.get("context")?.[0];
        if (!promptHook || !contextHook) throw new Error("hook が登録されていない");

        await promptHook({
          sessionID: "s-main",
          prompt: { text: "複数ファイルを変更する重い依頼" },
        });

        /* 案内はやめたので、会話には何も積まない */
        expect(synthetic).toHaveLength(0);

        /* 裏の判定が終わるのを待って、記録だけ確認する */
        const waitRows = async (): Promise<Array<Record<string, unknown>>> => {
          /* 遅い CI でも取りこぼさないよう 2 秒まで待つ（条件が満たされれば即抜ける） */
          for (let i = 0; i < 200; i += 1) {
            try {
              const rows = readRows(root);
              if (rows.some((r) => r.kind === "decide")) return rows;
            } catch {
              /* まだ書かれていない */
            }
            await Bun.sleep(10);
          }
          return [];
        };
        const row = (await waitRows()).find((r) => r.kind === "decide");
        expect(row?.delivered).toBe(false);

        /* system は固定文 1 つだけで、入口判定の語も入らない */
        const system: Array<{ type: string; text?: string }> = [];
        await contextHook({ sessionID: "s-main", system });
        expect(system).toHaveLength(1);
        const injected = system.map((x) => x.text ?? "").join("\n");
        expect(injected).not.toContain("## graphhopper 入口判定");
        expect(injected).toContain("graphhopper（常駐）");
        expect(injected).toContain("<context key=\"graphhopper-phase\">");
      });
    } finally {
      restore();
    }
  });

  test("direct でも synthetic を積まない", async () => {
    const root = tmpRoot();
    const restore = patchFetch("direct");
    try {
      await withKey(async () => {
        const { ctx, hooks, synthetic } = fakeCtx();
        await registerHooks({ ctx: ctx as never, root });
        const promptHook = hooks.get("prompt")?.[0];
        if (!promptHook) throw new Error("hook が登録されていない");
        await promptHook({ sessionID: "s-main", prompt: { text: "こんにちは" } });
        expect(synthetic).toHaveLength(0);
      });
    } finally {
      restore();
    }
  });

  test("phase案内は entry に put し、同じ値なら再 put せず、goal 完了で remove する", async () => {
    const root = tmpRoot();
    const { ctx, hooks, entryValue, entryCalls, entries } = fakeCtx();
    await registerHooks({ ctx: ctx as never, root });
    const promptHook = hooks.get("prompt")?.[0];
    if (!promptHook) throw new Error("hook が登録されていない");

    const a = startGoal(root, "entry 同期のテスト", "s-main");
    await promptHook({ sessionID: "s-main", prompt: { text: "続き" } });
    const designing = entryValue("s-main");
    expect(designing).toContain(a.goal.title);
    expect(designing).toContain("phase: designing");
    expect(designing).not.toContain("YAGNI");

    /* 同じ phase のまま別セッションの idle が来ても put しない（値が同じ） */
    const putsAfterFirst = entryCalls.filter((c) => c.startsWith("put:")).length;
    await promptHook({ sessionID: "s-main", prompt: { text: "まだ designing" } });
    expect(entryCalls.filter((c) => c.startsWith("put:")).length).toBe(putsAfterFirst);

    /* implementing に進むと値が変わる（ponytail の全文が付く） */
    stateSetPhase(root, "implementing", "test");
    await promptHook({ sessionID: "s-main", prompt: { text: "実装する" } });
    const implementing = entryValue("s-main");
    expect(implementing).toContain("phase: implementing");
    expect(implementing).toContain("YAGNI");

    /* goal を complete すると案内は消える（古い phase を残さない） */
    const st = await import("./state");
    st.completeGoal(root);
    await promptHook({ sessionID: "s-main", prompt: { text: "完了後" } });
    expect(entryValue("s-main")).toBeNull();
    expect(entries.get("s-main")?.size ?? 0).toBe(0);
  });

  test("entry が使えない環境では system を変えずに続行する（合成もしない）", async () => {
    const root = tmpRoot();
    const { ctx, hooks, entryCalls } = fakeCtx({ entryThrows: true });
    await registerHooks({ ctx: ctx as never, root });
    const promptHook = hooks.get("prompt")?.[0];
    if (!promptHook) throw new Error("hook が登録されていない");
    startGoal(root, "entry 失敗のテスト", "s-main");
    /* 失敗しても例外を投げない（ユーザー入力を止めない） */
    await promptHook({ sessionID: "s-main", prompt: { text: "続き" } });
    expect(entryCalls.length).toBe(0);
  });
});

describe("plugin hook: 子セッションのモデル切替", () => {
  test("拒否された子セッションの切替先は switchModel を呼ばず、警告は1回だけ", async () => {
    const prevCfg = process.env.GRAPHHOPPER_CONFIG;
    const cfgPath = join(tmpRoot(), "global.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        cascade: {
          enabled: true,
          agents: { quality: { "graphhopper-verifier": "opencode-go/gpt-6-luna" } },
        },
        model_deny: ["opencode-go/gpt-6-luna"],
      }),
      "utf8",
    );
    process.env.GRAPHHOPPER_CONFIG = cfgPath;
    const prevWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    try {
      const root = tmpRoot();
      startGoal(root, "t", "s1");
      let switched = 0;
      const event = {
        type: "session.created",
        data: {
          sessionID: "child1",
          parentID: "s1",
          agent: "graphhopper-verifier",
          model: { providerID: "x", id: "y" },
        },
      };
      // bound でない親の子は切替対象外。判定が shouldSwitchChild より前にあると
      // ここでも警告が出る（順序の退行を検出する）
      const unrelated = {
        type: "session.created",
        data: {
          sessionID: "child2",
          parentID: "other",
          agent: "graphhopper-verifier",
          model: { providerID: "x", id: "y" },
        },
      };
      const ctx = {
        tool: { hook: async () => {} },
        session: {
          hook: async () => {},
          get: async () => ({ id: "s1", parentID: null }),
          context: async () => [],
          prompt: async () => undefined,
          switchModel: async () => {
            switched++;
          },
        },
        event: {
          subscribe: async function* () {
            yield event;
            yield event;
            yield unrelated;
          },
        },
      };
      await registerHooks({ ctx: ctx as never, root });
      await new Promise((r) => setTimeout(r, 80));
      expect(switched).toBe(0);
      expect(warns.filter((w) => w.includes("model_deny")).length).toBe(1);
    } finally {
      console.warn = prevWarn;
      if (prevCfg === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prevCfg;
    }
  });
});

describe("plugin hook: tool 実行後の phase案内の同期（design g-mwj6481n 判断4）", () => {
  const runAfter = async (hooks: Map<string, HookCb[]>, tool: string, sessionID: string) => {
    for (const cb of hooks.get("execute.after") ?? []) await cb({ tool, sessionID, input: {} });
  };

  test("graphhopper_ の tool の直後に entry を更新する（次の idle・prompt を待たない）", async () => {
    const root = tmpRoot();
    const { ctx, hooks, entryValue, entryCalls } = fakeCtx();
    await registerHooks({ ctx: ctx as never, root });

    startGoal(root, "tool 後の同期テスト", "s-main");
    await runAfter(hooks, "graphhopper_goal", "s-main");
    expect(entryValue("s-main")).toContain("phase: designing");

    stateSetPhase(root, "implementing", "test");
    await runAfter(hooks, "graphhopper_phase", "s-main");
    expect(entryValue("s-main")).toContain("phase: implementing");

    /* graphhopper 以外の tool では同期しない（毎 tool の RPC を避ける） */
    const before = entryCalls.length;
    stateSetPhase(root, "polish", "test");
    await runAfter(hooks, "read", "s-main");
    expect(entryCalls.length).toBe(before);
    expect(entryValue("s-main")).toContain("phase: implementing");
  });
});

describe("plugin hook: handoff メモの案内（design g-mwj6481n 判断5）", () => {
  const HANDOFF_HEADER = "## graphhopper handoff メモ";

  test("入口判定を回さない入力（goal 進行中・キー無し）でも、新セッションに1回だけ積む", async () => {
    const root = tmpRoot();
    await withoutKey(async () => {
      const { ctx, hooks, synthetic } = fakeCtx();
      await registerHooks({ ctx: ctx as never, root });
      const promptHook = hooks.get("prompt")?.[0];
      if (!promptHook) throw new Error("hook が登録されていない");

      startGoal(root, "handoff 案内のテスト", "ses_a");
      expect(writeHandoff(root, { sessionID: "ses_a" })).not.toBeNull();

      await promptHook({ sessionID: "s-new", prompt: { text: "続きをやる" } });
      const notes = synthetic.filter((m) => m.text.startsWith(HANDOFF_HEADER));
      expect(notes).toHaveLength(1);
      expect(notes[0].sessionID).toBe("s-new");
      expect(notes[0].resume).toBe(false);

      /* 2 回目の入力では積まない */
      await promptHook({ sessionID: "s-new", prompt: { text: "もう一度" } });
      expect(synthetic.filter((m) => m.text.startsWith(HANDOFF_HEADER))).toHaveLength(1);

      /* メモを書いた本人のセッションには出さない */
      await promptHook({ sessionID: "ses_a", prompt: { text: "書いた本人" } });
      expect(synthetic.filter((m) => m.sessionID === "ses_a")).toHaveLength(0);
    });
  });

  test("子セッションには出さない", async () => {
    const root = tmpRoot();
    await withoutKey(async () => {
      const { ctx, hooks, synthetic } = fakeCtx({ parentID: "ses_parent" });
      await registerHooks({ ctx: ctx as never, root });
      const promptHook = hooks.get("prompt")?.[0];
      if (!promptHook) throw new Error("hook が登録されていない");
      startGoal(root, "handoff 子セッションのテスト", "ses_a");
      writeHandoff(root, { sessionID: "ses_a" });
      await promptHook({ sessionID: "s-child", prompt: { text: "調査して" } });
      expect(synthetic).toHaveLength(0);
    });
  });
});

describe("plugin hook: idle の phase案内フォールバック（design g-mwj6481n 判断7）", () => {
  const runIdle = async (hooks: Map<string, HookCb[]>, sessionID: string) => {
    const cb = hooks.get("experimental.idle")?.[0];
    if (!cb) throw new Error("idle hook が登録されていない");
    await cb({ sessionID, background: [] });
  };

  test("entry が使えないときは継続メッセージに phase案内の全文を付ける", async () => {
    const root = tmpRoot();
    const { ctx, hooks, synthetic } = fakeCtx({ entryThrows: true });
    await registerHooks({ ctx: ctx as never, root });
    startGoal(root, "idle フォールバックのテスト", "s-main");
    stateSetPhase(root, "implementing");
    await runIdle(hooks, "s-main");
    expect(synthetic.length).toBeGreaterThan(0);
    const cont = synthetic[synthetic.length - 1].text;
    expect(cont).toContain("## graphhopper 次のアクション");
    expect(cont).toContain("phase: implementing");
  });

  test("designing の idle は継続メッセージを積まない（質問して答えを待つ）", async () => {
    const root = tmpRoot();
    const { ctx, hooks, synthetic } = fakeCtx();
    await registerHooks({ ctx: ctx as never, root });
    startGoal(root, "designing の待ち", "s-main");
    await runIdle(hooks, "s-main");
    expect(synthetic.length).toBe(0);
  });

  test("designing の idle はラウンド数・待ちの記録・eval を動かさない（implementing では動く）", async () => {
    const idleWith = async (cb: HookCb | undefined, background: unknown[]) => {
      if (!cb) throw new Error("idle hook が登録されていない");
      await cb({ sessionID: "s-main", background });
    };
    const marker = (root: string) => join(root, "eval-ran.txt");
    const setup = async (phase: "designing" | "implementing") => {
      const root = tmpRoot();
      const { ctx, hooks, synthetic } = fakeCtx();
      await registerHooks({ ctx: ctx as never, root });
      startGoal(root, "idle の比較", "s-main");
      setEvalCmd(root, `touch ${marker(root)}`);
      if (phase === "implementing") stateSetPhase(root, "implementing");
      return { root, cb: hooks.get("experimental.idle")?.[0], synthetic };
    };

    try {
      /* designing: background 待ちでも通常の idle でも、何も動かない */
      const d = await setup("designing");
      const guardBefore = JSON.stringify(readState(d.root).guard);
      await idleWith(d.cb, [{ kind: "subagent" }]);
      await idleWith(d.cb, []);
      expect(JSON.stringify(readState(d.root).guard)).toBe(guardBefore);
      expect(readState(d.root).guard.rounds).toBe(0);
      expect(readState(d.root).guard.wait_since).toBeNull();
      expect(existsSync(marker(d.root))).toBe(false);
      expect(readState(d.root).phase).toBe("designing");
      expect(d.synthetic.length).toBe(0);

      /* implementing: 同じ入力で待ちの記録と eval が動く（上の assert が空振りでないことの対） */
      const w = await setup("implementing");
      await idleWith(w.cb, [{ kind: "subagent" }]);
      expect(readState(w.root).guard.wait_since).not.toBeNull();
      const e = await setup("implementing");
      await idleWith(e.cb, []);
      expect(existsSync(marker(e.root))).toBe(true);
    } finally {
      clearAllWaitTimers();
    }
  });

  test("entry が使えるときは継続メッセージに全文を付けない（entry が運ぶ）", async () => {
    const root = tmpRoot();
    const { ctx, hooks, synthetic, entryValue } = fakeCtx();
    await registerHooks({ ctx: ctx as never, root });
    startGoal(root, "idle 正常系のテスト", "s-main");
    stateSetPhase(root, "implementing");
    await runIdle(hooks, "s-main");
    expect(entryValue("s-main")).toContain("phase: implementing");
    const cont = synthetic[synthetic.length - 1].text;
    expect(cont).not.toContain("## graphhopper 次のアクション");
  });
});

describe("plugin hook: ループ検知の入力（design g-mwj6481n 判断6）", () => {
  test("instructions の通知（system 型）は履歴の入力から外し、synthetic は残す", () => {
    const likes = tailLikes([
      { type: "user", text: "依頼", time: { created: 1 } },
      {
        type: "system",
        text: 'The context under "graphhopper-phase" changed and supersedes the previous value:\n新しい案内',
        time: { created: 2 },
      },
      { type: "synthetic", text: "[graphhopper-continuation] 続き", time: { created: 3 } },
      { type: "assistant", content: [{ type: "text", text: "了解" }], time: { created: 4 } },
    ]);
    if (!likes) throw new Error("tailLikes が null");
    const texts = likes.map((m) => m.parts?.[0]?.text ?? "");
    expect(texts.some((t) => t.includes("supersedes"))).toBe(false);
    expect(texts.some((t) => t.includes("[graphhopper-continuation]"))).toBe(true);
    expect(likes.map((m) => m.info.role)).toEqual(["user", "user", "assistant"]);
  });
});

describe("plugin hook: designing の編集ゲート（execute.before）", () => {
  /** execute.before を1回叩く。拒否は throw で返る */
  const runBefore = async (root: string, tool: string, filePath: string): Promise<unknown> => {
    const { ctx, hooks } = fakeCtx();
    await registerHooks({ ctx: ctx as never, root });
    const cb = hooks.get("execute.before")?.[0];
    if (!cb) throw new Error("execute.before hook が登録されていない");
    return await cb({ tool, input: { filePath } });
  };

  test("designing 中は source 編集を拒否し、plans 配下と intent ログの扱いが分かれる", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "gate", "s1").goal;
    await expect(runBefore(root, "edit", "src/a.ts")).rejects.toThrow(/"designing" phase/);
    // plans 配下は design を書くために通す
    await expect(runBefore(root, "edit", `.graphhopper/plans/${g.id}.md`)).resolves.toBeUndefined();
    // intent ログは phase を問わず不変
    await expect(
      runBefore(root, "edit", `.graphhopper/plans/${g.id}.intent.md`),
    ).rejects.toThrow(/immutable record/);
  });

  test("implementing 移行後は design doc が locked になる", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "gate", "s1").goal;
    writeFileSync(join(root, ".graphhopper", "plans", `${g.id}.md`), "# design\n", "utf8");
    stateSetPhase(root, "implementing");
    await expect(
      runBefore(root, "write", `.graphhopper/plans/${g.id}.md`),
    ).rejects.toThrow(/immutable once the/);
    // source は通る
    await expect(runBefore(root, "edit", "src/a.ts")).resolves.toBeUndefined();
  });
});
