/**
 * dynamic workflow runner — 純粋層。
 * 型・bugfix 定義・tier→モデル解決・テンプレ展開・出力抽出/検証・キー・run 状態の永続化。
 * 実行（子セッションの起動）は workflow-runner.ts。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CascadeConfig } from "./state";

export type Tier = "baseline" | "quality" | "second" | "expert";
export type FieldType = "string" | "number" | "boolean" | "array";

export interface OutputSpec {
  required: string[];
  types?: Record<string, FieldType>;
}

export interface WorkflowNode {
  id: string;
  /** null = 既定 agent（編集が必要なノード用） */
  agent: string | null;
  tier: Tier;
  /** {{outputs.<id>.<field>}} / {{lens}} / {{advice}} を展開する */
  prompt: string;
  output: OutputSpec;
  maxRetry: number;
  /** 指定すると lens ごとに子を並列起動（すべて直接の子） */
  fanout?: string[];
  /** verify が clean 以外のとき再入力する先ノード（1 run につき最大1回） */
  feedbackTo?: string;
}

export interface WorkflowDef {
  name: string;
  nodes: WorkflowNode[];
}

export const RECOVERY_KINDS = ["oracle", "escalate_tier", "second_opinion", "abort"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export const ORACLE_NODE: WorkflowNode = {
  id: "oracle",
  agent: "graphhopper-oracle",
  tier: "expert",
  prompt:
    "以下のノードが失敗した。原因と次に取るべき手を助言せよ。\n失敗ノード: {{failed.id}}\n失敗理由: {{failed.reason}}\n" +
    "末尾に ```json {\"advice\": \"...\"} ``` を出力すること。",
  output: { required: ["advice"], types: { advice: "string" } },
  maxRetry: 1,
};

const JSON_TAIL =
  "\n\n最後に結果を ```json フェンスのブロック1つだけで出力すること（他の JSON ブロックは出さない）。";

export const BUGFIX_WORKFLOW: WorkflowDef = {
  name: "bugfix",
  nodes: [
    {
      id: "repro",
      agent: null,
      tier: "baseline",
      prompt:
        "バグ報告: {{task}}\n失敗する再現テストを書き、実際に実行して失敗を確認せよ。実装コードは触らない。{{advice}}" +
        '出力: {"test_file": string, "command": string, "failing": boolean}' +
        JSON_TAIL,
      output: {
        required: ["test_file", "command", "failing"],
        types: { test_file: "string", command: "string", failing: "boolean" },
      },
      maxRetry: 1,
    },
    {
      id: "fix",
      agent: null,
      tier: "baseline",
      prompt:
        "バグ報告: {{task}}\n再現テスト: {{outputs.repro.test_file}}（実行: {{outputs.repro.command}}）\n" +
        "最小の修正で再現テストを通せ。他のテストを壊さない。{{feedback}}{{advice}}" +
        '出力: {"summary": string, "files": string[], "passing": boolean}' +
        JSON_TAIL,
      output: {
        required: ["summary", "files", "passing"],
        types: { summary: "string", files: "array", passing: "boolean" },
      },
      maxRetry: 1,
    },
    {
      id: "verify",
      agent: "graphhopper-verifier",
      tier: "quality",
      prompt:
        "lens={{lens}} で直近の修正を検証せよ。\nバグ報告: {{task}}\n修正概要: {{outputs.fix.summary}}\n{{advice}}" +
        '出力: {"level": "clean"|"drift", "findings": string[]}' +
        JSON_TAIL,
      output: {
        required: ["level", "findings"],
        types: { level: "string", findings: "array" },
      },
      maxRetry: 1,
      fanout: ["requirement", "behavior", "progress"],
      feedbackTo: "fix",
    },
  ],
};

export function getWorkflow(name: string): WorkflowDef | null {
  return name === "bugfix" ? BUGFIX_WORKFLOW : null;
}

/**
 * tier→モデル。cascade 無効なら null（親セッションのモデルを継承）。
 * - baseline: 初期作業（安いモデル）
 * - quality: 判定・検証（信頼モデル）
 * - second: 別角度での再試行
 * - expert: お手上げ（人が判断すべき段階）
 * tierOverride は failure recovery の表現。escalate_tier=quality（同一手順を信頼モデルで再実行）、
 * second_opinion=second（別角度のモデルで再実行）。
 */
export function resolveNodeModel(
  node: WorkflowNode,
  cascade: CascadeConfig,
  tierOverride?: Tier | null,
): string | null {
  if (!cascade.enabled) return null;
  const tier = tierOverride ?? node.tier;
  if (tier === "quality") {
    return (node.agent ? cascade.agents.quality[node.agent] : undefined) ?? cascade.escalate;
  }
  if (tier === "second") return cascade.second ?? cascade.escalate;
  if (tier === "expert") return cascade.expert ?? cascade.escalate;
  return cascade.baseline;
}

export function expandTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    let cur: unknown = vars;
    for (const seg of path.split(".")) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else return "";
    }
    if (cur === undefined || cur === null) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

/** 最後の ```json フェンスをパース。無い・不正は null */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const re = /```json\s*\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1] ?? null;
  if (last === null) return null;
  try {
    const v = JSON.parse(last) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 欠落・型不一致の一覧（空なら OK） */
export function validateOutput(obj: Record<string, unknown>, spec: OutputSpec): string[] {
  const errs: string[] = [];
  for (const k of spec.required) {
    if (!(k in obj)) errs.push(`${k} が無い`);
  }
  for (const [k, t] of Object.entries(spec.types ?? {})) {
    if (!(k in obj)) continue;
    const v = obj[k];
    const ok = t === "array" ? Array.isArray(v) : typeof v === t;
    if (!ok) errs.push(`${k} は ${t} であること`);
  }
  return errs;
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function defHash(def: WorkflowDef): string {
  return sha1(JSON.stringify(def));
}

/** ノードの入力だけで決まるキー。repo 状態は含めず、NodeRecord.repoAfter で別途照合する */
export function nodeKey(parts: {
  defHash: string;
  nodeId: string;
  prompt: string;
  model: string | null;
}): string {
  return sha1([parts.defHash, parts.nodeId, parts.prompt, parts.model ?? ""].join("\u0000"));
}

/** キャッシュを再利用してよいか: キー一致・完了・出力あり、かつ実行後の repo 状態が現在と一致 */
export function canReuse(cached: NodeRecord | undefined, key: string, repoNow: string): cached is NodeRecord {
  return !!cached && cached.status === "done" && cached.key === key && !!cached.output && cached.repoAfter === repoNow;
}

/** d1 の回復選択を許可リストに通す。外・使用済みは abort */
export function allowRecovery(choice: unknown, inserted: string[]): RecoveryKind {
  if (typeof choice !== "string") return "abort";
  if (!(RECOVERY_KINDS as readonly string[]).includes(choice)) return "abort";
  const k = choice as RecoveryKind;
  if (k !== "abort" && inserted.includes(k)) return "abort";
  return k;
}

/* ---------- run 状態 ---------- */
export interface NodeRecord {
  id: string;
  key: string;
  status: "done" | "failed";
  output: Record<string, unknown> | null;
  models: string[];
  sessions: string[];
  at: string;
  reason?: string;
  /** ノード完了時点の repo ハッシュ。resume での再利用可否の照合に使う */
  repoAfter?: string;
}

export interface RunState {
  goal: string;
  workflow: string;
  task: string;
  status: "running" | "done" | "failed" | "aborted";
  current: string | null;
  nodes: NodeRecord[];
  inserted: string[];
  feedbackUsed: boolean;
  /** 差し戻し指摘・oracle 助言（resume で失わないよう永続化） */
  feedback?: string;
  /** 実行中の子セッション（reload 後の孤児回収用） */
  running?: string[];
  advice?: string;
  /** advice を付けるノード（失敗したノードだけに効かせ、他ノードのキーを変えない） */
  adviceNode?: string;
  started: string;
  updated: string;
  error?: string;
}

export function runPath(root: string, goal: string): string {
  return join(root, ".graphhopper", "workflows", `${goal}.run.json`);
}

export function readRun(root: string, goal: string): RunState | null {
  try {
    const r = JSON.parse(readFileSync(runPath(root, goal), "utf8")) as RunState;
    if (!r || !Array.isArray(r.nodes)) return null;
    return { ...r, inserted: r.inserted ?? [], feedbackUsed: !!r.feedbackUsed, feedback: r.feedback ?? "", advice: r.advice ?? "" };
  } catch {
    return null;
  }
}

export function writeRun(root: string, run: RunState): void {
  const p = runPath(root, run.goal);
  mkdirSync(join(root, ".graphhopper", "workflows"), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...run, updated: new Date().toISOString() }, null, 2));
  renameSync(tmp, p);
}

export function summarizeRun(run: RunState | null): string | null {
  if (!run) return null;
  const done = run.nodes.filter((n) => n.status === "done").length;
  return `workflow ${run.workflow}: ${run.status}${run.current ? `（現在 ${run.current}）` : ""} / 完了ノード ${done}` +
    (run.inserted.length ? ` / 挿入 ${run.inserted.join(",")}` : "") +
    (run.error ? ` / ${run.error}` : "");
}
