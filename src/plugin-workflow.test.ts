/** workflow host の createChild ポリシー拒否テスト（design g-mw8xvsg8 判断5）。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHost } from "../.opencode/plugins/graphhopper/workflow";
import { POLICY_DENIED } from "./workflow";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "gh-wf-host-"));

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

describe("makeHost.createChild のポリシー拒否", () => {
  test("拒否されたモデルではセッションを作らず POLICY_DENIED で落ちる", async () => {
    const cfg = withGlobal({ model_deny: ["opencode-go/gpt-*"] });
    try {
      const root = tmpRoot();
      let created = 0;
      const gh = {
        root,
        ctx: {
          session: {
            create: async () => {
              created++;
              return "ses_x";
            },
          },
        },
      } as never;
      const host = makeHost(gh, "parent1");
      await expect(
        host.createChild({
          agent: null,
          model: "opencode-go/gpt-6-luna",
          title: "t",
          metadata: {},
        }),
      ).rejects.toThrow(POLICY_DENIED);
      expect(created).toBe(0);
    } finally {
      cfg.restore();
    }
  });

  test("許可されたモデルはセッションを作る", async () => {
    const cfg = withGlobal({ model_deny: ["opencode-go/gpt-*"] });
    try {
      const root = tmpRoot();
      let created = 0;
      const gh = {
        root,
        ctx: {
          session: {
            create: async () => {
              created++;
              return "ses_x";
            },
          },
        },
      } as never;
      const host = makeHost(gh, "parent1");
      const id = await host.createChild({
        agent: null,
        model: "test/prov",
        title: "t",
        metadata: {},
      });
      expect(id.startsWith("ses_")).toBe(true);
      expect(created).toBe(1);
    } finally {
      cfg.restore();
    }
  });
});
