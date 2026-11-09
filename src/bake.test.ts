/** catalog bake の単体テスト（design g-mw8rlbjr）。 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeAgents, formatBakeViolation } from "./bake";

const tmpOut = () => join(mkdtempSync(join(tmpdir(), "gh-bake-")), "agents");
const tmpCfg = (json: object | string) => {
  const path = join(mkdtempSync(join(tmpdir(), "gh-bake-cfg-")), "global.json");
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json), "utf8");
  return path;
};
const runCli = (args: string[], cfgPath: string) =>
  spawnSync(process.execPath, ["scripts/gen-agents.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, GRAPHHOPPER_CONFIG: cfgPath },
    encoding: "utf8",
  });

describe("bakeAgents", () => {
  test("違反があれば何も書かない（all-or-nothing）", () => {
    const outDir = tmpOut();
    const r = bakeAgents({
      outDir,
      agents: { "graphhopper-critic": "opencode-go/gpt-6-luna" },
      policy: { deny: ["opencode-go/gpt-6-luna"] },
    });
    expect(r.ok).toBe(false);
    expect(r.written).toEqual([]);
    expect(r.violations).toEqual([
      {
        agent: "graphhopper-critic",
        model: "opencode-go/gpt-6-luna",
        kind: "deny",
        rule: "opencode-go/gpt-6-luna",
      },
    ]);
    expect(existsSync(join(outDir, "graphhopper-critic.md"))).toBe(false);
    // 違反が無い agent も書かれない（all-or-nothing）
    expect(existsSync(join(outDir, "graphhopper-verifier.md"))).toBe(false);
    expect(existsSync(join(outDir, "graphhopper-oracle.md"))).toBe(false);
  });

  test("built-in 既定も検査する（上書きが無くても止まる）", () => {
    const r = bakeAgents({
      outDir: tmpOut(),
      agents: {},
      policy: { deny: ["minimax/*"] },
    });
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((v) => v.kind === "deny")).toBe(true);
  });

  test("許可された上書きは焼かれる", () => {
    const outDir = tmpOut();
    const r = bakeAgents({
      outDir,
      agents: { "graphhopper-critic": "test/p" },
      policy: {},
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    const md = readFileSync(join(outDir, "graphhopper-critic.md"), "utf8");
    expect(md).toContain('model: "test/p"');
  });

  test("違反時は既存ファイルを書き換えない", () => {
    const outDir = tmpOut();
    bakeAgents({ outDir, agents: { "graphhopper-critic": "test/p" }, policy: {} });
    const before = readFileSync(join(outDir, "graphhopper-critic.md"), "utf8");
    const r = bakeAgents({
      outDir,
      agents: { "graphhopper-critic": "opencode-go/kimi-k3.1-pro" },
      policy: { deny: ["opencode-go/kimi-*"] },
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(outDir, "graphhopper-critic.md"), "utf8")).toBe(before);
  });

  test("形式不正のモデルと未知の agent 名も違反にする", () => {
    const r = bakeAgents({
      outDir: tmpOut(),
      agents: {
        "graphhopper-critic": "no-slash",
        "graphhopper-verifer": "test/p",
      },
      policy: {},
    });
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      agent: "graphhopper-critic",
      model: "no-slash",
      kind: "invalid",
    });
    expect(r.violations).toContainEqual({
      agent: "graphhopper-verifer",
      model: "test/p",
      kind: "unknown",
    });
  });

  test("checkOnly: 一致なら ok、config 変更後は stale（全文比較）", () => {
    const outDir = tmpOut();
    bakeAgents({ outDir, agents: { "graphhopper-critic": "test/p" }, policy: {} });
    const same = bakeAgents({
      outDir,
      agents: { "graphhopper-critic": "test/p" },
      policy: {},
      checkOnly: true,
    });
    expect(same.ok).toBe(true);
    expect(same.stale).toEqual([]);

    const changed = bakeAgents({
      outDir,
      agents: { "graphhopper-critic": "test/q" },
      policy: {},
      checkOnly: true,
    });
    expect(changed.ok).toBe(false);
    expect(changed.stale).toEqual([
      { agent: "graphhopper-critic", expected: "test/q", actual: "test/p" },
    ]);
  });

  test("checkOnly は model 以外のドリフト（description 変更）も検出する", () => {
    const outDir = tmpOut();
    bakeAgents({ outDir, agents: {}, policy: {} });
    const path = join(outDir, "graphhopper-critic.md");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace(/^description: .*$/m, 'description: "changed"'), "utf8");
    const r = bakeAgents({ outDir, agents: {}, policy: {}, checkOnly: true });
    expect(r.ok).toBe(false);
    expect(r.stale.some((s) => s.agent === "graphhopper-critic")).toBe(true);
  });

  test("CLI: 拒否モデルで exit 1・書き込みなし", () => {
    // model_deny: ["*"] なら project 設定に依存せず必ず違反する
    const cfgPath = tmpCfg({ model_deny: ["*"] });
    const outDir = tmpOut();
    const r = runCli(["--out", outDir], cfgPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("model_deny");
    expect(existsSync(join(outDir, "graphhopper-critic.md"))).toBe(false);
  });

  test("CLI --global-only: global の deny で exit 1、破損 JSON でも exit 1", () => {
    const bad = tmpCfg({
      agents: { "graphhopper-critic": "opencode-go/gpt-6-luna" },
      model_deny: ["opencode-go/gpt-6-luna"],
    });
    const outDir = tmpOut();
    const denied = runCli(["--global-only", "--out", outDir], bad);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("model_deny");

    const broken = tmpCfg("{ not json");
    const r = runCli(["--global-only", "--out", outDir], broken);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read");
  });

  test("CLI --check: 一致で exit 0、config 変更後は stale で exit 1（書き込みなし）", () => {
    const outDir = tmpOut();
    // 成功パス（書き込み）も --global-only で検証する
    const base = tmpCfg({});
    const write = runCli(["--global-only", "--out", outDir], base);
    expect(write.status).toBe(0);
    expect(existsSync(join(outDir, "graphhopper-critic.md"))).toBe(true);

    const ok = runCli(["--global-only", "--check", "--out", outDir], base);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("ok:");

    const changed = tmpCfg({ agents: { "graphhopper-critic": "test/p" } });
    const stale = runCli(["--global-only", "--check", "--out", outDir], changed);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stale: graphhopper-critic");
    // --check は書き込まない
    expect(readFileSync(join(outDir, "graphhopper-critic.md"), "utf8")).not.toContain(
      'model: "test/p"',
    );
  });

  test("formatBakeViolation は agent とルールを含む", () => {
    const v = {
      agent: "graphhopper-verifier",
      model: "opencode-go/gpt-6-luna",
      kind: "deny" as const,
      rule: "opencode-go/gpt-*",
    };
    const line = formatBakeViolation(v);
    expect(line).toContain("graphhopper-verifier");
    expect(line).toContain("opencode-go/gpt-*");
  });
});
