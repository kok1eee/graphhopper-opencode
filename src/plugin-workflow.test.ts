/** workflow host の createChild ポリシー拒否テスト（design g-mw8xvsg8 判断5）。 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("makeHost.repoHash の .graphhopper/ 除外（design g-mwiwxc5a 判断1）", () => {
  const gitRepo = async (): Promise<string> => {
    const root = tmpRoot();
    await $`git init -q`.cwd(root).quiet();
    await $`git config user.email a@b.c`.cwd(root).quiet();
    await $`git config user.name a`.cwd(root).quiet();
    return root;
  };
  const commitAll = async (root: string): Promise<void> => {
    await $`git add -A`.cwd(root).quiet();
    await $`git commit -qm init`.cwd(root).quiet();
  };
  const host = (root: string) => makeHost({ root, ctx: {} } as never, "parent1");

  test("追跡した作業ファイルの変更では変わらず、設定と source の変更では変わる", async () => {
    const root = await gitRepo();
    writeFileSync(join(root, "src.ts"), "a", "utf8");
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(join(root, ".graphhopper", "state.json"), "1", "utf8");
    writeFileSync(join(root, ".graphhopper", "config.json"), "{}", "utf8");
    await commitAll(root);

    const before = await host(root).repoHash();
    writeFileSync(join(root, ".graphhopper", "state.json"), "2", "utf8");
    expect(await host(root).repoHash()).toBe(before);

    writeFileSync(join(root, ".graphhopper", "config.json"), '{"agents":{}}', "utf8");
    const configChanged = await host(root).repoHash();
    expect(configChanged).not.toBe(before);

    writeFileSync(join(root, "src.ts"), "b", "utf8");
    expect(await host(root).repoHash()).not.toBe(configChanged);
  });

  test("未追跡でも作業ファイルは無視し、設定 2 つだけは含める", async () => {
    const root = await gitRepo();
    writeFileSync(join(root, "src.ts"), "a", "utf8");
    await commitAll(root);

    const before = await host(root).repoHash();
    mkdirSync(join(root, ".graphhopper", "tmp"), { recursive: true });
    writeFileSync(join(root, ".graphhopper", "tmp", "x.txt"), "cache", "utf8");
    expect(await host(root).repoHash()).toBe(before);

    writeFileSync(join(root, ".graphhopper", "config.json"), "{}", "utf8");
    expect(await host(root).repoHash()).not.toBe(before);
  });
});
