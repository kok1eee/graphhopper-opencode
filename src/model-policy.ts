/**
 * モデルの許可/拒否ポリシー（design g-mw8qwiy6 / g-mw8rlbjr）。
 * invoke（spawn 前）と catalog bake の両方が同じ判定を使う。
 * 依存を持たない純関数だけを置く（src/agents.ts と src/invoke.ts の循環回避）。
 */

/** モデル許可/拒否ポリシー（config の model_allow / model_deny） */
export interface ModelPolicy {
  allow?: string[];
  deny?: string[];
}

/** 判定結果。拒否理由を説明できるよう判別共用体で返す */
export type ModelCheck =
  | { ok: true }
  | { ok: false; kind: "deny"; rule: string }
  | { ok: false; kind: "allow" }
  | { ok: false; kind: "unresolved" };

/** 違反の種類。invalid=形式不正、unknown=未知の agent 名（bake 用） */
export type ModelViolationKind = "deny" | "allow" | "invalid" | "unknown" | "missing";

/** 拒否された agent/モデルの組（bake の違反と実行時警告で共用） */
export interface ModelViolation {
  agent: string;
  model: string;
  kind: ModelViolationKind;
  rule?: string;
}

/** ModelCheck を違反へ写像する（ok / unresolved は null） */
export function toViolation(
  agent: string,
  model: string,
  check: ModelCheck,
): ModelViolation | null {
  if (check.ok || check.kind === "unresolved") return null;
  return {
    agent,
    model,
    kind: check.kind,
    ...(check.kind === "deny" ? { rule: check.rule } : {}),
  };
}

/** 拒否理由を人間向けの1行にする（plugin / CLI の表示で共用） */
export function describeModelDenial(v: ModelViolation): string {
  switch (v.kind) {
    case "deny":
      return `model_deny (rule: ${v.rule})`;
    case "allow":
      return "model_allow 外";
    case "invalid":
      return "provider/model 形式不正";
    case "unknown":
      return "未知の agent 名";
    case "missing":
      return "catalog 未生成";
  }
}

/** glob（`*` のみ）を全体一致で照合する。大小文字は区別する */
function globMatch(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) return pattern === model;
  const body = pattern
    .split("*")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`).test(model);
}

/** モデルの許可判定。deny 優先・allow 非空なら一致必須・未解決は制限有効時のみ拒否 */
export function checkModelAllowed(
  model: string | undefined,
  policy: ModelPolicy,
): ModelCheck {
  const allow = policy.allow ?? [];
  const deny = policy.deny ?? [];
  if (model === undefined) {
    return allow.length === 0 && deny.length === 0
      ? { ok: true }
      : { ok: false, kind: "unresolved" };
  }
  const denied = deny.find((p) => globMatch(p, model));
  if (denied !== undefined) return { ok: false, kind: "deny", rule: denied };
  if (allow.length > 0 && !allow.some((p) => globMatch(p, model))) {
    return { ok: false, kind: "allow" };
  }
  return { ok: true };
}
