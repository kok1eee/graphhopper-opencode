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
  }
}
