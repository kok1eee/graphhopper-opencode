/**
 * entry-decide のテスト（入口d1判定の hook 自動化）。
 * 純粋関数（除外判定・注入文・内部prompt識別）と記録・保険を固定する。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideEntry,
  ensureEntryDecision,
  formatEntryVerdict,
  hasRecentEntryDecision,
  INTERNAL_PROMPT_METADATA_KEY,
  isInternalPrompt,
  recordEntrySkip,
  shouldRunEntryDecide,
  type EntryDecideInput,
} from "./entry-decide";
import { mapDecisionAnswer } from "./decision";

const mkRoot = () => mkdtempSync(join(tmpdir(), "gh-entry-decide-"));

/** LIQUID_API_KEY を差し替えて実行し、後で必ず戻す */
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

/** LIQUID_API_KEY を外した状態で実行し、後で必ず戻す */
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

const readRows = (root: string) => {
  const raw = readFileSync(join(root, ".graphhopper", "decisions.jsonl"), "utf-8");
  return raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
};

/** d1 の応答を模した fetch */
const fakeFetch = (answers: Record<string, unknown>) =>
  (async () => ({
    ok: true,
    json: async () => ({ answers }),
  })) as unknown as typeof fetch;

const baseInput: EntryDecideInput = {
  text: "複数ファイルにまたがる変更を実装して",
  isInternal: false,
  isChildSession: false,
  hasActiveGoal: false,
  hasApiKey: true,
};

describe("shouldRunEntryDecide（判定の除外条件）", () => {
  test("通常のユーザー入力は判定する", () => {
    expect(shouldRunEntryDecide(baseInput)).toEqual({ run: true });
  });

  test("内部prompt・子セッション・goal進行中・key無し・空本文は判定しない", () => {
    expect(shouldRunEntryDecide({ ...baseInput, isInternal: true })).toEqual({
      run: false,
      reason: "internal",
    });
    expect(shouldRunEntryDecide({ ...baseInput, isChildSession: true })).toEqual({
      run: false,
      reason: "child_session",
    });
    expect(shouldRunEntryDecide({ ...baseInput, hasActiveGoal: true })).toEqual({
      run: false,
      reason: "active_goal",
    });
    expect(shouldRunEntryDecide({ ...baseInput, hasApiKey: false })).toEqual({
      run: false,
      reason: "no_api_key",
    });
    expect(shouldRunEntryDecide({ ...baseInput, text: "   " })).toEqual({
      run: false,
      reason: "empty",
    });
  });

  test("内部promptを最優先で落とす（自動継続が最頻出のため）", () => {
    const r = shouldRunEntryDecide({
      ...baseInput,
      isInternal: true,
      isChildSession: true,
      hasActiveGoal: true,
      hasApiKey: false,
      text: "",
    });
    expect(r).toEqual({ run: false, reason: "internal" });
  });
});

describe("isInternalPrompt（plugin 内部 prompt の識別）", () => {
  test("metadata の印で内部と判定する", () => {
    expect(isInternalPrompt({ [INTERNAL_PROMPT_METADATA_KEY]: true }, "任意の文")).toBe(true);
  });

  test("本文マーカーでも内部と判定する（metadata が届かない場合の保険）", () => {
    expect(isInternalPrompt(undefined, "[graphhopper-continuation] 続き")).toBe(true);
    expect(isInternalPrompt({}, "  [graphhopper] 自動継続")).toBe(true);
  });

  test("ユーザーの入力は内部ではない", () => {
    expect(isInternalPrompt(undefined, "jj diff を確認して")).toBe(false);
    expect(isInternalPrompt({}, "graphhopper について")).toBe(false);
  });
});

describe("formatEntryVerdict（モデルへ渡す注入文）", () => {
  const verdict = (over: Partial<ReturnType<typeof mapDecisionAnswer>>) => ({
    route: "full" as const,
    rawChoice: "light",
    rawRoute: "light" as const,
    confidence: 0.55,
    reason: "d1判定(light)",
    fallback: false,
    difficulty: "easy" as const,
    difficultyConfidence: 0.9,
    ...over,
  });

  test("raw=direct は注入しない（ループを作らない）", () => {
    expect(formatEntryVerdict(verdict({ rawRoute: "direct", rawChoice: "direct" }))).toBeNull();
  });

  test("fallback（d1失敗）は注入しない", () => {
    expect(formatEntryVerdict(verdict({ fallback: true, rawRoute: null, rawChoice: null }))).toBeNull();
  });

  test("不正choice（rawRoute=null）は注入しない", () => {
    expect(formatEntryVerdict(verdict({ rawRoute: null, rawChoice: "bogus" }))).toBeNull();
  });

  test("raw route を route_set に渡す指示を含む", () => {
    const text = formatEntryVerdict(verdict({})) ?? "";
    expect(text).toContain("route: 'light'");
    expect(text).toContain("difficulty: 'easy'");
    expect(text).toContain("graphhopper_goal(action: 'start'");
    expect(text).toContain("graphhopper 入口判定");
  });

  test("difficulty が無ければ difficulty 引数を付けない", () => {
    const text = formatEntryVerdict(verdict({ difficulty: null })) ?? "";
    expect(text).not.toContain("difficulty: '");
    expect(text).toContain("route: 'light'");
  });

  test("confidence を表示する", () => {
    const text = formatEntryVerdict(verdict({ confidence: 0.42 })) ?? "";
    expect(text).toContain("confidence 0.42");
  });
});

describe("decideEntry（判定と記録）", () => {
  test("decide 行に rawChoice と sessionID を残す", async () => {
    const root = mkRoot();
    await withKey(async () => {
      const v = await decideEntry(
        "重い依頼",
        fakeFetch({
          route: { choice: "light", confidence: 0.3 },
          difficulty: { choice: "easy", confidence: 0.9 },
        }),
        { root, sessionID: "sess-x" },
      );
      // confidence 0.3 は floor 未満なので mapped route は full になるが raw は light
      expect(v.route).toBe("full");
      expect(v.rawRoute).toBe("light");
      expect(v.rawChoice).toBe("light");
      const [row] = readRows(root);
      expect(row).toMatchObject({
        kind: "decide",
        result: "full",
        rawChoice: "light",
        sessionID: "sess-x",
        fallback: false,
      });
    });
  });

  test("d1 失敗は fallback として記録し、判定不能を表す", async () => {
    const root = mkRoot();
    await withKey(async () => {
      const failing = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const v = await decideEntry("依頼", failing, { root, sessionID: "sess-y" });
      expect(v.fallback).toBe(true);
      expect(v.rawRoute).toBeNull();
      const [row] = readRows(root);
      expect(row).toMatchObject({ kind: "decide", fallback: true, sessionID: "sess-y" });
    });
  });
});

describe("recordEntrySkip（判定しなかった記録）", () => {
  test("内部promptは記録しない（自動継続でログが埋まるため）", async () => {
    const root = mkRoot();
    await recordEntrySkip(root, "internal", "自動継続", "sess-1");
    expect(() => readRows(root)).toThrow();
  });

  test("それ以外は decide-skip として残す", async () => {
    const root = mkRoot();
    await recordEntrySkip(root, "active_goal", "goal中の入力", "sess-1");
    const [row] = readRows(root);
    expect(row).toMatchObject({
      kind: "decide-skip",
      result: "active_goal",
      sessionID: "sess-1",
    });
  });
});

describe("hasRecentEntryDecision / ensureEntryDecision（goal start 時の保険）", () => {
  test("直近の decide 行があれば true", async () => {
    const root = mkRoot();
    await withKey(async () => {
      await decideEntry("依頼", fakeFetch({ route: { choice: "full", confidence: 0.9 } }), {
        root,
        sessionID: "sess-1",
      });
      expect(hasRecentEntryDecision(root, "sess-1")).toBe(true);
      expect(hasRecentEntryDecision(root, "sess-2")).toBe(false);
    });
  });

  test("直近の decide 行が無ければ title で判定して記録する", async () => {
    const root = mkRoot();
    await withKey(async () => {
      const v = await ensureEntryDecision(
        root,
        "sess-3",
        "goal の題名",
        { fetchFn: fakeFetch({ route: { choice: "light", confidence: 0.9 } }) },
      );
      expect(v).not.toBeNull();
      const rows = readRows(root);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "decide", sessionID: "sess-3" });
    });
  });

  test("直近の decide 行があれば何もしない（二重記録しない）", async () => {
    const root = mkRoot();
    await withKey(async () => {
      await decideEntry("依頼", fakeFetch({ route: { choice: "full", confidence: 0.9 } }), {
        root,
        sessionID: "sess-4",
      });
      const v = await ensureEntryDecision(
        root,
        "sess-4",
        "goal の題名",
        { fetchFn: fakeFetch({ route: { choice: "light", confidence: 0.9 } }) },
      );
      expect(v).toBeNull();
      expect(readRows(root)).toHaveLength(1);
    });
  });

  test("APIキー無しの環境では decide 行を残さない（較正データを汚さない）", async () => {
    const root = mkRoot();
    await withoutKey(async () => {
      const v = await ensureEntryDecision(
        root,
        "sess-5",
        "goal の題名",
        { fetchFn: fakeFetch({ route: { choice: "light", confidence: 0.9 } }) },
      );
      expect(v).toBeNull();
      const rows = readRows(root);
      expect(rows.every((r) => r.kind !== "decide")).toBe(true);
    });
  });

  test("例外を投げない（goal start を止めない）", async () => {
    const root = mkRoot();
    await withKey(async () => {
      const exploding = (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch;
      const v = await ensureEntryDecision(root, "sess-6", "goal の題名", {
        fetchFn: exploding,
      });
      expect(v).not.toBeUndefined();
    });
  });
});
