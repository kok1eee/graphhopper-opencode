/** catalog bake の単体テスト（design g-mw8rlbjr）。 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bakeAgents,
  catalogPolicyViolations,
  catalogPolicyWarning,
  checkCatalogPolicy,
  formatBakeViolation,
} from "./bake";

const tmpOut = () => join(mkdtempSync(join(tmpdir(), "gh-bake-")), "agents");
const tmpCfg = (json: object | string) => {
  const path = join(mkdtempSync(join(tmpdir(), "gh-bake-cfg-")), "global.json");
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json), "utf8");
  return path;
};
const runCli = (args: string[], cfgPath: string, home?: string) =>
  spawnSync(process.execPath, ["scripts/gen-agents.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      GRAPHHOPPER_CONFIG: cfgPath,
      // global catalog の検査が実ユーザー環境に依存しないよう HOME を隔離する
      HOME: home ?? mkdtempSync(join(tmpdir(), "gh-home-")),
    },
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

  test("割当表の #variant を .md に焼く（design g-mwjsd3om 判断2）", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-bake-root-"));
    const outDir = join(root, ".opencode", "agents");
    const r = bakeAgents({
      outDir,
      agents: {
        "graphhopper-advisor": "claude-oauth/claude-opus-5-5#xhigh",
        "graphhopper-oracle": "claude-oauth/claude-fable-5-2#xhigh",
      },
      policy: {},
    });
    expect(r.ok).toBe(true);
    const advisor = readFileSync(join(outDir, "graphhopper-advisor.md"), "utf8");
    expect(advisor).toContain('model: "claude-oauth/claude-opus-5-5#xhigh"');
    const oracle = readFileSync(join(outDir, "graphhopper-oracle.md"), "utf8");
    expect(oracle).toContain('model: "claude-oauth/claude-fable-5-2#xhigh"');
    // variant が無い agent は今までどおり
    const critic = readFileSync(join(outDir, "graphhopper-critic.md"), "utf8");
    expect(critic).toContain('model: "claude-oauth/claude-haiku-5-5"');
    // 焼いた catalog を読み直してもポリシー違反にならない（variant は判定に含めない）
    expect(catalogPolicyViolations(root, {})).toEqual([]);
    expect(
      catalogPolicyViolations(root, { model_deny: ["claude-oauth/claude-opus-5-5"] }),
    ).toEqual([
      expect.objectContaining({ agent: "graphhopper-advisor", kind: "deny" }),
    ]);
  });

  test("variant 付きの割当も deny で止まる（bake 時に variant を落として判定）", () => {
    const r = bakeAgents({
      outDir: tmpOut(),
      agents: { "graphhopper-advisor": "claude-oauth/claude-opus-5-5#xhigh" },
      policy: { deny: ["claude-oauth/claude-opus-5-5"] },
    });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      {
        agent: "graphhopper-advisor",
        model: "claude-oauth/claude-opus-5-5#xhigh",
        kind: "deny",
        rule: "claude-oauth/claude-opus-5-5",
      },
    ]);
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

  test("catalogPolicyViolations は焼き込み済みモデルの policy 違反だけを見る", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-catalog-"));
    const outDir = join(root, ".opencode", "agents");
    bakeAgents({ outDir, agents: {}, policy: {} });
    // 既定（minimax / claude-oauth 等）は deny に当たらない
    expect(catalogPolicyViolations(root, { model_deny: ["opencode-go/gpt-*"] })).toEqual([]);

    // catalog に拒否モデルを焼き込んだ状態を作る
    const path = join(outDir, "graphhopper-critic.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/^model: ".*"$/m, 'model: "opencode-go/gpt-6-luna"'),
      "utf8",
    );
    expect(catalogPolicyViolations(root, { model_deny: ["opencode-go/gpt-*"] })).toEqual([
      {
        agent: "graphhopper-critic",
        model: "opencode-go/gpt-6-luna",
        kind: "deny",
        rule: "opencode-go/gpt-*",
      },
    ]);
  });

  test("catalogPolicyWarning は違反が無ければ null、あれば焼き直しを促す", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-catalog-warn-"));
    const outDir = join(root, ".opencode", "agents");
    bakeAgents({ outDir, agents: {}, policy: {} });
    expect(catalogPolicyWarning(root, { model_deny: ["opencode-go/gpt-*"] })).toBeNull();

    const path = join(outDir, "graphhopper-critic.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/^model: ".*"$/m, 'model: "opencode-go/gpt-6-luna"'),
      "utf8",
    );
    const warn = catalogPolicyWarning(root, { model_deny: ["opencode-go/gpt-*"] });
    expect(warn).toContain("graphhopper-critic");
    expect(warn).toContain("gen-agents");
    expect(warn).toContain("resume");
  });

  test("CLI --check-policy は commit 済み example で通る", () => {
    const cfgPath = tmpCfg({});
    // GRAPHHOPPER_CONFIG は --check-policy では使わない（repo の example を読む）
    const r = runCli(["--check-policy"], cfgPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok:");
  });

  test("CLI --check-policy は破損 JSON・配列・欠落・deny で exit 1", () => {
    const cfgPath = tmpCfg({});
    const broken = tmpCfg("{ not json");
    expect(runCli(["--check-policy", "--policy", broken], cfgPath).status).toBe(1);

    const arrayJson = tmpCfg("[]");
    expect(runCli(["--check-policy", "--policy", arrayJson], cfgPath).status).toBe(1);

    // model_deny が配列でない
    const notArray = tmpCfg({ model_deny: "opencode-go/gpt-6-luna" });
    expect(runCli(["--check-policy", "--policy", notArray], cfgPath).status).toBe(1);

    const missing = join(mkdtempSync(join(tmpdir(), "gh-policy-none-")), "nope.json");
    expect(runCli(["--check-policy", "--policy", missing], cfgPath).status).toBe(1);

    // repo catalog のモデル（claude-oauth 等）を deny する
    const denied = tmpCfg({ model_deny: ["claude-oauth/*"] });
    const r = runCli(["--check-policy", "--policy", denied], cfgPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("model_deny");
  });

  test("CLI --check-policy: global catalog があれば検査し、違反は [global] で出る", () => {
    const cfgPath = tmpCfg({});
    const home = mkdtempSync(join(tmpdir(), "gh-home-global-"));
    const dir = join(home, ".config", "opencode", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "graphhopper-critic.md"),
      '---\nmodel: "opencode-go/gpt-6-luna"\n---\nbody\n',
      "utf8",
    );
    const r = runCli(["--check-policy"], cfgPath, home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[global]");
  });

  test("CLI --check-policy: global catalog が無ければ通る", () => {
    const cfgPath = tmpCfg({});
    const home = mkdtempSync(join(tmpdir(), "gh-home-none-"));
    const r = runCli(["--check-policy"], cfgPath, home);
    expect(r.status).toBe(0);
  });

  test("checkCatalogPolicy は欠落・deny・cascade 違反を検出する", () => {
    const outDir = tmpOut();
    const missing = checkCatalogPolicy({ outDir, policy: {} });
    expect(missing.ok).toBe(false);
    expect(missing.violations.every((v) => v.kind === "missing")).toBe(true);

    bakeAgents({ outDir, agents: {}, policy: {} });
    expect(checkCatalogPolicy({ outDir, policy: {} }).ok).toBe(true);

    const denied = checkCatalogPolicy({
      outDir,
      policy: { deny: ["minimax/*"] },
    });
    expect(denied.ok).toBe(false);
    expect(denied.violations.every((v) => v.kind === "deny")).toBe(true);

    const cascade = checkCatalogPolicy({
      outDir,
      policy: { deny: ["opencode-go/kimi-*"] },
      cascade: { escalate: "opencode-go/kimi-k3.1-pro" },
    });
    expect(cascade.violations).toContainEqual({
      agent: "cascade.escalate",
      model: "opencode-go/kimi-k3.1-pro",
      kind: "deny",
      rule: "opencode-go/kimi-*",
    });
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
