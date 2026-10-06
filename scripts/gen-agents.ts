/**
 * agents/*.md 静的宣言の生成器。単一源泉は src/agents.ts の GRAPHHOPPER_AGENTS。
 * v2 の AgentEditor に add は無いため、7 agent は .opencode/agents/ に静的宣言し、
 * plugin は起動時に ctx.agent.transform(update) で割当表の model＋permissions を適用する。
 * 使い方: bun scripts/gen-agents.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPermissions, GRAPHHOPPER_AGENTS, parseModelRef } from "../src/agents";
import { readConfig } from "../src/state";

const here = dirname(fileURLToPath(import.meta.url));
const projRoot = join(here, "..");
const outDir = join(projRoot, ".opencode", "agents");
mkdirSync(outDir, { recursive: true });

/* 割当表 (global＋project) の実効値を bake する。runtime の transform update が
 * 本命だが、静的既定も割当通りになるよう gen 時点で同期する (二重化・どちらも同値)。 */
const table = readConfig(projRoot).agents;

const q = (s: string) => JSON.stringify(s);

for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
  const override = table[name];
  const model = override ? parseModelRef(override) : def.model;
  // 全文 bake: runtime の transform update は .md 発見より先に走るため当たらない (実測)。
  // 単一源泉は src/agents.ts。割当表を変えたら本 script を再実行する。
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
  console.log(`wrote ${name}.md`);
}
