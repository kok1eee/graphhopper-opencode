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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "../.opencode/plugins/graphhopper/hooks";
import { startGoal } from "./state";

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

/** fake ctx。hook のコールバックを捕まえて、テストから直接叩けるようにする */
function fakeCtx(opts: { parentID?: string | null } = {}) {
  const hooks = new Map<string, HookCb[]>();
  const add = (name: string, cb: HookCb) => {
    const list = hooks.get(name) ?? [];
    list.push(cb);
    hooks.set(name, list);
  };
  const ctx = {
    tool: { hook: async (name: string, cb: HookCb) => add(name, cb) },
    session: {
      hook: async (name: string, cb: HookCb) => add(name, cb),
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: opts.parentID ?? null,
      }),
      context: async () => [],
      prompt: async () => undefined,
    },
    event: {
      // イベントを1つも流さない（無限に待たない）
      subscribe: async function* () {
        return;
      },
    },
  };
  return { ctx, hooks };
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

describe("plugin hook: 入口d1判定の context hook（注入）", () => {
  /* 注入ヘッダ。SYSTEM_GUIDE にも「graphhopper 入口判定」という語が出るので
   * ヘッダ全文で判定する */
  const INJECT_HEADER = "## graphhopper 入口判定（d1・自動判定済み）";

  test("判定結果を system に注入する（1ターン1回・消費したら入れない）", async () => {
    const root = tmpRoot();
    const restore = patchFetch("light");
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx();
        await registerHooks({ ctx: ctx as never, root });
        const promptHook = hooks.get("prompt")?.[0];
        const contextHook = hooks.get("context")?.[0];
        if (!promptHook || !contextHook) throw new Error("hook が登録されていない");

        await promptHook({
          sessionID: "s-main",
          prompt: { text: "複数ファイルを変更する重い依頼" },
        });

        const system: Array<{ type: string; text?: string }> = [];
        await contextHook({ sessionID: "s-main", system });
        const injected = system.map((s) => s.text ?? "").join("\n");
        expect(injected).toContain(INJECT_HEADER);
        expect(injected).toContain("route: 'light'");

        /* 2回目の context では注入しない（消費済み） */
        const system2: Array<{ type: string; text?: string }> = [];
        await contextHook({ sessionID: "s-main", system: system2 });
        expect(system2.map((s) => s.text ?? "").join("\n")).not.toContain(INJECT_HEADER);
      });
    } finally {
      restore();
    }
  });

  test("raw=direct なら注入しない", async () => {
    const root = tmpRoot();
    const restore = patchFetch("direct");
    try {
      await withKey(async () => {
        const { ctx, hooks } = fakeCtx();
        await registerHooks({ ctx: ctx as never, root });
        const promptHook = hooks.get("prompt")?.[0];
        const contextHook = hooks.get("context")?.[0];
        if (!promptHook || !contextHook) throw new Error("hook が登録されていない");

        await promptHook({
          sessionID: "s-main",
          prompt: { text: "こんにちは" },
        });
        const system: Array<{ type: string; text?: string }> = [];
        await contextHook({ sessionID: "s-main", system });
        expect(system.map((s) => s.text ?? "").join("\n")).not.toContain(INJECT_HEADER);
      });
    } finally {
      restore();
    }
  });
});
