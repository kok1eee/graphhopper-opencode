/** plugin cascade のポリシー拒否テスト（design g-mw8xvsg8 判断3）。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCascadeResult } from "../.opencode/plugins/graphhopper/cascade";
import { startGoal } from "./state";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "gh-plugin-cascade-"));

function withGlobal(json: object): { restore: () => void } {
  const prev = process.env.GRAPHHOPPER_CONFIG;
  const path = join(tmpRoot(), "global.json");
  writeFileSync(path, JSON.stringify(json), "utf8");
  process.env.GRAPHHOPPER_CONFIG = path;
  return {
    restore: () => {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    },
  };
}

describe("syncCascadeResult のポリシー拒否", () => {
  test("拒否された切替先は switchModel を呼ばず、2回目は note なし・failed のまま", async () => {
    const cfg = withGlobal({
      cascade: { enabled: true, baseline: "opencode-go/gpt-6-luna" },
      model_deny: ["opencode-go/gpt-6-luna"],
    });
    try {
      const root = tmpRoot();
      startGoal(root, "t", "s1");
      let switched = 0;
      const gh = {
        root,
        ctx: {
          session: {
            get: async () => ({ model: { providerID: "x", id: "y" } }),
            switchModel: async () => {
              switched++;
            },
          },
        },
      } as never;

      const first = await syncCascadeResult(gh);
      expect(first.failed).toBe(true);
      expect(first.note).toContain("model_deny");
      expect(switched).toBe(0);

      // 同じ拒否は再報告しない（failed の意味は保つ）
      const second = await syncCascadeResult(gh);
      expect(second.failed).toBe(true);
      expect(second.note).toBeNull();
      expect(switched).toBe(0);
    } finally {
      cfg.restore();
    }
  });

  test("許可された切替先は switchModel を呼ぶ", async () => {
    const cfg = withGlobal({
      cascade: { enabled: true, baseline: "test/prov" },
    });
    try {
      const root = tmpRoot();
      startGoal(root, "t", "s1");
      let switched = 0;
      const gh = {
        root,
        ctx: {
          session: {
            get: async () => ({ model: { providerID: "x", id: "y" } }),
            switchModel: async () => {
              switched++;
            },
          },
        },
      } as never;
      const r = await syncCascadeResult(gh);
      expect(r.failed).toBe(false);
      expect(switched).toBe(1);
    } finally {
      cfg.restore();
    }
  });
});
