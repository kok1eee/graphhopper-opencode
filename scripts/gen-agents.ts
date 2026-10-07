/**
 * agent 静的宣言の生成器。単一源泉は src/agents.ts の GRAPHHOPPER_AGENTS。
 * v2 の AgentEditor に add は無く、update() も .md 発見より先に走るため当たらない
 * (実測)。割当の適用は本 script の bake が本命。
 * 使い方:
 *   bun scripts/gen-agents.ts                       # project (.opencode/agents, global＋project表)
 *   bun scripts/gen-agents.ts --out ~/.config/opencode/agents --global-only
 *                                                   # global (global表のみ)
 * 割当表を変えたら再実行＋opencode再起動が必要。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPermissions, GRAPHHOPPER_AGENTS, parseModelRef } from "../src/agents";
import { readConfig } from "../src/state";

const here = dirname(fileURLToPath(import.meta.url));
const projRoot = join(here, "..");

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? (argv[outIdx + 1] ?? "") : join(projRoot, ".opencode", "agents"));
const globalOnly = argv.includes("--global-only");
if (!argv[outIdx + 1] && outIdx >= 0) {
  console.error("error: --out requires a directory");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/* 割当表の実効値を bake する。--global-only では global 表のみ
 * (~/.config/opencode/graphhopper.json の agents) を使う。 */
let table: Record<string, string>;
if (globalOnly) {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "graphhopper.json"), "utf8")) as {
      agents?: Record<string, string>;
    };
    table = raw.agents ?? {};
  } catch {
    table = {};
  }
} else {
  table = readConfig(projRoot).agents;
}

const q = (s: string) => JSON.stringify(s);

for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
  const override = table[name];
  const model = override ? parseModelRef(override) : def.model;
  const perms = buildPermissions(def, name)
    .map((r) => `  - { action: ${q(r.action)}, resource: ${q(r.resource)}, effect: ${q(r.effect)} }`)
    .join("\n");
  const front = [
    "---",
    `description: ${q(def.description)}`,
    `mode: ${def.mode}`,
    `model: ${q(`${model.providerID}/${model.model}`)}`,
    "permissions:",
    perms,
    "---",
    "",
  ].join("\n");
  writeFileSync(join(outDir, `${name}.md`), front + def.system + "\n", "utf8");
  console.log(`wrote ${name}.md -> ${outDir}`);
}
