/**
 * agent 静的宣言の生成器。単一源泉は src/agents.ts の GRAPHHOPPER_AGENTS。
 * v2 の AgentEditor に add は無く、update() も .md 発見より先に走るため当たらない
 * (実測)。割当の適用は本 script の bake が本命（task() のモデルはここで焼かれる）。
 * model_allow / model_deny の検査もここが唯一の実効ゲート（design g-mw8rlbjr）。
 * 使い方:
 *   bun scripts/gen-agents.ts                       # project (.opencode/agents, global＋project表)
 *   bun scripts/gen-agents.ts --out ~/.config/opencode/agents --global-only
 *                                                   # global (global表のみ)
 *   bun scripts/gen-agents.ts --check               # 焼き直さず、config と既存 .md のズレだけ検査
 * 割当表を変えたら再実行＋opencode再起動が必要。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeAgents, formatBakeViolation } from "../src/bake";
import type { ModelPolicy } from "../src/model-policy";
import { globalConfigPath, readConfig } from "../src/state";

const here = dirname(fileURLToPath(import.meta.url));
const projRoot = join(here, "..");

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outValue = outIdx >= 0 ? (argv[outIdx + 1] ?? "") : "";
const outDir = resolve(outIdx >= 0 ? outValue : join(projRoot, ".opencode", "agents"));
const globalOnly = argv.includes("--global-only");
const checkOnly = argv.includes("--check");
if (outIdx >= 0 && (!outValue || outValue.startsWith("--"))) {
  console.error("error: --out requires a directory");
  process.exit(1);
}

/* 割当表の実効値を bake する。--global-only では global 表のみ
 * (~/.config/opencode/graphhopper.json の agents) を使う。 */
let agents: Record<string, string>;
let policy: ModelPolicy;
if (globalOnly) {
  const path = globalConfigPath();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      agents?: Record<string, string>;
      model_allow?: string[];
      model_deny?: string[];
    };
    agents = raw.agents ?? {};
    policy = { allow: raw.model_allow, deny: raw.model_deny };
  } catch (err) {
    // 破損 JSON を「割当なし」にすると検査の抜け道になるため失敗させる
    console.error(`error: cannot read ${path}: ${String(err)}`);
    process.exit(1);
  }
} else {
  const cfg = readConfig(projRoot);
  agents = cfg.agents;
  policy = { allow: cfg.model_allow, deny: cfg.model_deny };
}

const result = bakeAgents({ outDir, agents, policy, checkOnly });

if (result.violations.length > 0) {
  for (const v of result.violations) console.error(`error: ${formatBakeViolation(v)}`);
  console.error(
    "fix: ~/.config/opencode/graphhopper.json か .graphhopper/config.json の model_allow/model_deny / agents を直す",
  );
  process.exit(1);
}

if (checkOnly) {
  if (result.stale.length > 0) {
    for (const s of result.stale) {
      console.error(
        `stale: ${s.agent} expected "${s.expected}" actual ${s.actual === null ? "(missing)" : `"${s.actual}"`}`,
      );
    }
    console.error("fix: bun scripts/gen-agents.ts で焼き直す");
    process.exit(1);
  }
  console.log(`ok: ${result.written.length} agents match config`);
  process.exit(0);
}

for (const name of result.written) console.log(`wrote ${name}.md -> ${outDir}`);
