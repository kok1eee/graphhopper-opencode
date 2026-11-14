/**
 * agent catalog（.opencode/agents/*.md）の bake（design g-mw8rlbjr）。
 * task() のモデルはここで焼かれた値で決まるため、model_allow / model_deny の
 * 唯一の実効ゲートはこの検査になる（実行時の agent.transform は no-op 実測済み）。
 * 違反が1件でもあれば何も書かない（all-or-nothing）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRAPHHOPPER_AGENTS,
  buildPermissions,
  parseModelRef,
  type V2AgentDef,
} from "./agents";
import {
  checkModelAllowed,
  toViolation,
  type ModelPolicy,
  type ModelViolation,
} from "./model-policy";

export type BakeViolation = ModelViolation;

export interface BakeInput {
  outDir: string;
  /** config の agents 上書き（name → "provider/model"） */
  agents: Record<string, string>;
  policy: ModelPolicy;
  /** true なら書き込まず、既存 .md との差分だけ返す */
  checkOnly?: boolean;
}

export interface BakeStale {
  agent: string;
  expected: string;
  actual: string | null;
}

export interface BakeResult {
  ok: boolean;
  /** 書いた（checkOnly では一致した）agent 名 */
  written: string[];
  violations: BakeViolation[];
  /** checkOnly で config と既存 .md がズレている agent */
  stale: BakeStale[];
}

const q = (s: string) => JSON.stringify(s);

/** agent 1件分の .md 全文を組み立てる */
function renderAgent(name: string, def: V2AgentDef, modelStr: string): string {
  const perms = buildPermissions(def, name)
    .map(
      (r) =>
        `  - { action: ${q(r.action)}, resource: ${q(r.resource)}, effect: ${q(r.effect)} }`,
    )
    .join("\n");
  const front = [
    "---",
    `description: ${q(def.description)}`,
    `mode: ${def.mode}`,
    `model: ${q(modelStr)}`,
    "permissions:",
    perms,
    "---",
    "",
  ].join("\n");
  return front + def.system + "\n";
}

/** 既存 .md の frontmatter から model: の値を読む（無ければ null。表示用） */
function readBakedModel(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^model:\s*"([^"]+)"/m.exec(raw);
  return m?.[1] ?? null;
}

/** 全 agent のモデルを解決して検査し、問題が無ければ書き込む */
export function bakeAgents(input: BakeInput): BakeResult {
  const violations: BakeViolation[] = [];
  const rendered: { name: string; modelStr: string; text: string }[] = [];

  // 未知の agent 名は typo を黙って無視しない（焼いたつもりで素通りするのを防ぐ）
  for (const [name, override] of Object.entries(input.agents)) {
    if (!(name in GRAPHHOPPER_AGENTS)) {
      violations.push({ agent: name, model: override, kind: "unknown" });
    }
  }

  for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
    const override = input.agents[name];
    let modelStr: string;
    if (override) {
      try {
        const m = parseModelRef(override);
        modelStr = `${m.providerID}/${m.model}`;
      } catch {
        violations.push({ agent: name, model: override, kind: "invalid" });
        continue;
      }
    } else {
      modelStr = `${def.model.providerID}/${def.model.model}`;
    }
    const v = toViolation(name, modelStr, checkModelAllowed(modelStr, input.policy));
    if (v) {
      violations.push(v);
      continue;
    }
    rendered.push({ name, modelStr, text: renderAgent(name, def, modelStr) });
  }

  // all-or-nothing: 1件でも違反があれば何も書かない
  if (violations.length > 0) {
    return { ok: false, written: [], violations, stale: [] };
  }

  if (input.checkOnly) {
    const stale: BakeStale[] = [];
    const matched: string[] = [];
    for (const r of rendered) {
      const path = join(input.outDir, `${r.name}.md`);
      const actualText = existsSync(path) ? readFileSync(path, "utf8") : null;
      // 全文比較（description / permissions / mode のドリフトも検出する）
      if (actualText !== r.text) {
        stale.push({ agent: r.name, expected: r.modelStr, actual: readBakedModel(actualText) });
      } else {
        matched.push(r.name);
      }
    }
    return { ok: stale.length === 0, written: matched, violations: [], stale };
  }

  mkdirSync(input.outDir, { recursive: true });
  for (const r of rendered) {
    const path = join(input.outDir, `${r.name}.md`);
    const tmp = `${path}.tmp`;
    // 途中クラッシュで frontmatter の無い .md を残さない（atomic write）
    writeFileSync(tmp, r.text, "utf8");
    renameSync(tmp, path);
  }
  return { ok: true, written: rendered.map((r) => r.name), violations: [], stale: [] };
}

/**
 * 焼き込み済み catalog のモデルがポリシーに違反しているかを返す（design g-mw8xvsg8 判断6）。
 * stale（config との差分）は見ない: 既知の verifier drift で resume 警告が常時発火するため。
 */
export function catalogPolicyViolations(
  root: string,
  cfg: { model_allow?: string[]; model_deny?: string[] },
): ModelViolation[] {
  const outDir = join(root, ".opencode", "agents");
  const policy: ModelPolicy = { allow: cfg.model_allow, deny: cfg.model_deny };
  const violations: ModelViolation[] = [];
  for (const name of Object.keys(GRAPHHOPPER_AGENTS)) {
    const path = join(outDir, `${name}.md`);
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    const model = readBakedModel(raw);
    if (!model) continue; // 未 bake は --check-policy の領分
    const v = toViolation(name, model, checkModelAllowed(model, policy));
    if (v) violations.push(v);
  }
  return violations;
}

/** resume 応答に付ける警告1行（違反が無ければ null） */
export function catalogPolicyWarning(
  root: string,
  cfg: { model_allow?: string[]; model_deny?: string[] },
): string | null {
  const v = catalogPolicyViolations(root, cfg);
  if (v.length === 0) return null;
  return (
    `注意: agent catalog に model_allow/model_deny 違反が ${v.length} 件あります（${v.map((x) => x.agent).join(", ")}）。` +
    "resume はモデルを凍結するため反映されません。bun scripts/gen-agents.ts で焼き直し、新規セッションで開始してください。"
  );
}

/**
 * 焼き込み済み catalog と cascade 設定を、commit 済みポリシーで検査する（CI 用。判断7, 8）。
 * 個人 global 設定は読まない（CI に存在しないため）。
 */
export function checkCatalogPolicy(input: {
  outDir: string;
  policy: ModelPolicy;
  cascade?: {
    baseline?: string;
    escalate?: string;
    second?: string;
    expert?: string;
    strong?: string;
    main_fallback?: string;
    phase_models?: Record<string, string>;
    /** legacy の escalate も readConfig が quality へマージするため検査する */
    agents?: { quality?: Record<string, string>; escalate?: Record<string, string> };
  };
}): { ok: boolean; violations: ModelViolation[] } {
  const violations: ModelViolation[] = [];
  for (const name of Object.keys(GRAPHHOPPER_AGENTS)) {
    const path = join(input.outDir, `${name}.md`);
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    const model = readBakedModel(raw);
    if (!model) {
      violations.push({ agent: name, model: "(missing)", kind: "missing" });
      continue;
    }
    const v = toViolation(name, model, checkModelAllowed(model, input.policy));
    if (v) violations.push(v);
  }
  const c = input.cascade;
  if (c) {
    const entries: [string, string | undefined][] = [
      ["cascade.baseline", c.baseline],
      ["cascade.escalate", c.escalate],
      ["cascade.second", c.second],
      ["cascade.expert", c.expert],
      ["cascade.strong", c.strong],
      ["cascade.main_fallback", c.main_fallback],
      ...Object.entries(c.phase_models ?? {}).map(
        ([k, v]) => [`cascade.phase_models.${k}`, v] as [string, string],
      ),
      ...Object.entries(c.agents?.quality ?? {}).map(
        ([k, v]) => [`cascade.agents.quality.${k}`, v] as [string, string],
      ),
      ...Object.entries(c.agents?.escalate ?? {}).map(
        ([k, v]) => [`cascade.agents.escalate.${k}`, v] as [string, string],
      ),
    ];
    for (const [label, value] of entries) {
      if (!value || value === "main") continue;
      let model: string;
      try {
        const ref = parseModelRef(value);
        model = `${ref.providerID}/${ref.model}`;
      } catch {
        violations.push({ agent: label, model: value, kind: "invalid" });
        continue;
      }
      const v = toViolation(label, model, checkModelAllowed(model, input.policy));
      if (v) violations.push(v);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** 違反を人間向けの1行にする（CLI の stderr 用） */
export function formatBakeViolation(v: BakeViolation): string {
  switch (v.kind) {
    case "deny":
      return `${v.agent}: model "${v.model}" is denied by model_deny (rule: ${v.rule})`;
    case "allow":
      return `${v.agent}: model "${v.model}" is not in model_allow`;
    case "invalid":
      return `${v.agent}: model "${v.model}" is not a valid provider/model ref`;
    case "unknown":
      return `${v.agent}: unknown agent name in config agents (typo?)`;
    case "missing":
      return `${v.agent}: catalog .md is missing (run bun scripts/gen-agents.ts)`;
  }
}
