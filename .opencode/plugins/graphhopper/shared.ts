/**
 * graphhopper v2 plugin 共有部。
 * Gh (plugin ctx＋root) と JSON Schema 組立・known-sessions (handoff H2 代替) を置く。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";

export interface Gh {
  ctx: Plugin.Context;
  root: string;
}

/* ---------- tool input JSON Schema builders ---------- */
type Schema = Record<string, unknown>;
const str = (description: string): Schema => ({ type: "string", description });
const optStr = (description: string): Schema => ({ type: "string", description });
const num = (description: string): Schema => ({ type: "number", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const enumOf = (values: readonly string[], description?: string): Schema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});
const arrOf = (items: Schema, description?: string): Schema => ({
  type: "array",
  items,
  ...(description ? { description } : {}),
});
const obj = (
  properties: Record<string, Schema>,
  required: readonly string[],
): Schema => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

export const S = { str, optStr, num, bool, enumOf, arrOf, obj };

/* ---------- tool result ---------- */
export function text(content: string): { content: string } {
  return { content };
}

/* ---------- known-sessions (handoff H2 代替) ----------
 * v2 の plugin SessionDomain に `list` は無いため、graphhopper_* tool が
 * 呼ばれた session を sidecar に記録し、handoff の候補列挙に使う。
 * .graphhopper/ 配下＝repo内配置 (子権限で読める配置思想は diff_stash と同じ)。 */
const KNOWN_FILE = "known-sessions.json";
const KNOWN_MAX = 50;

export function noteSession(root: string, sessionID: string): void {
  try {
    const dir = join(root, ".graphhopper");
    const path = join(dir, KNOWN_FILE);
    let list: { id: string; seen: number }[] = [];
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        list = raw.filter(
          (e): e is { id: string; seen: number } =>
            !!e && typeof (e as { id?: unknown }).id === "string",
        );
      }
    }
    const now = Date.now();
    list = [{ id: sessionID, seen: now }, ...list.filter((e) => e.id !== sessionID)].slice(
      0,
      KNOWN_MAX,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(list, null, 2), "utf8");
  } catch {
    // 記録失敗は tool 本体を壊さない
  }
}

export function knownSessions(root: string): { id: string; seen: number }[] {
  try {
    const path = join(root, ".graphhopper", KNOWN_FILE);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is { id: string; seen: number } =>
        !!e && typeof (e as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}
