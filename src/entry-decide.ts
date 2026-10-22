/**
 * entry-decide — 入口 route 判定の hook 自動化。
 *
 * 役割:
 * - ユーザー入力ごとに d1 で route を判定し、`.graphhopper/decisions.jsonl` に記録する
 * - 判定結果をモデルに渡すための注入文を作る
 * - 判定しない条件（内部 prompt・子セッション・goal 進行中・key 不在・空）を決める
 *
 * 純粋ロジック（shouldRunEntryDecide / formatEntryVerdict）はここで、IO は decision.ts に任せる。
 * d1 の HTTP 呼び出しは decision.ts の decideRoute を再利用する（HTTP 部分を複製しない）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideRoute,
  logDecision,
  type DecideResult,
} from "./decision";

/** hook 経路の d1 待ち時間上限。モデル呼び出しを止めるので短めに切る */
export const ENTRY_DECIDE_TIMEOUT_MS = 5_000;

/** goal start 時の保険で「直近」とみなす decide 行の窓 */
export const ENTRY_DECIDE_FRESH_MS = 5 * 60_000;

/** plugin 内部 prompt の識別子。ctx.session.prompt に付けて渡す */
export const INTERNAL_PROMPT_METADATA_KEY = "graphhopper_internal";

/** plugin 内部 prompt の本文マーカー（metadata が届かない場合の保険） */
const INTERNAL_TEXT_PREFIX = "[graphhopper";

/**
 * plugin 自身が投げた prompt か（自動継続・eval 失敗通知・handoff など）。
 * metadata の印と本文マーカーの両方を見る。
 */
export function isInternalPrompt(
  metadata: Record<string, unknown> | undefined,
  text: string,
): boolean {
  if (metadata?.[INTERNAL_PROMPT_METADATA_KEY] === true) return true;
  return text.trimStart().startsWith(INTERNAL_TEXT_PREFIX);
}

/** 判定の最終結果（decideRoute の返り値と同じ形） */
export type EntryVerdict = DecideResult;

/** 判定しない理由 */
export type EntrySkipReason =
  | "internal"
  | "child_session"
  | "active_goal"
  | "no_api_key"
  | "empty";

export type EntryDecideInput = {
  /** ユーザー入力の本文 */
  text: string;
  /** plugin 自身が投げた prompt か（自動継続・eval 失敗通知など） */
  isInternal: boolean;
  /** subagent などの子セッションか */
  isChildSession: boolean;
  /** 実行中の goal があるか */
  hasActiveGoal: boolean;
  /** LIQUID_API_KEY があるか */
  hasApiKey: boolean;
};

export type EntryDecideDecision =
  | { run: true }
  | { run: false; reason: EntrySkipReason };

/**
 * 判定を実行してよいか。
 * 順序は「除外の副作用の大きさ」順: 内部 prompt が最頻出なので最初に落とす。
 */
export function shouldRunEntryDecide(
  input: EntryDecideInput,
): EntryDecideDecision {
  if (input.isInternal) return { run: false, reason: "internal" };
  if (input.isChildSession) return { run: false, reason: "child_session" };
  if (input.hasActiveGoal) return { run: false, reason: "active_goal" };
  if (!input.hasApiKey) return { run: false, reason: "no_api_key" };
  if (!input.text.trim()) return { run: false, reason: "empty" };
  return { run: true };
}

/**
 * 判定結果をモデルに渡す注入文。
 *
 * - fallback（d1 失敗）や不正 choice、raw=direct は null（＝注入しない）。
 *   判定不能を「重い」と解釈してループを起こさない（design 判断4）。
 * - route の判定には **rawRoute**（confidence 下限で full に潰される前の route）を使う。
 *   mapped route を使うと 5 択 choice の confidence が常に 0.6 未満で全依頼が full になる（design 判断3）。
 */
export function formatEntryVerdict(v: EntryVerdict): string | null {
  if (v.fallback) return null;
  const route = v.rawRoute;
  if (!route) return null;
  if (route === "direct") return null;
  const conf = v.confidence === null ? "n/a" : v.confidence.toFixed(2);
  const diffNote = v.difficulty ? `、difficulty=${v.difficulty}` : "";
  const diffArg = v.difficulty ? `, difficulty: '${v.difficulty}'` : "";
  return [
    "## graphhopper 入口判定（d1・自動判定済み）",
    "",
    `判定: route=${route}（confidence ${conf}${diffNote}）`,
    `- graphhopper_route_set(route: '${route}', reason: 'd1判定'${diffArg}) を呼び、` +
      `graphhopper_goal(action: 'start', title: ...) でループを開始する。`,
    "- 明らかに単一ファイルの小修正・質問応答ならループを作らず直接対応してよい（route_set 不要）。",
    "- d1 の判定は参考値。判断に確信があれば route_set で上書きしてよい。",
  ].join("\n");
}

/** 判定を実行して記録する。失敗は fallback（route=full）として返す */
export async function decideEntry(
  request: string,
  fetchFn: typeof fetch = fetch,
  opts?: { root?: string; sessionID?: string | null; timeoutMs?: number },
): Promise<EntryVerdict> {
  return decideRoute(request, fetchFn, {
    root: opts?.root,
    sessionID: opts?.sessionID ?? null,
    timeoutMs: opts?.timeoutMs ?? ENTRY_DECIDE_TIMEOUT_MS,
  });
}

/**
 * 判定しなかった記録を残す（カバレッジ計測用）。
 * 内部 prompt は自動継続で毎回発生するため記録しない（ログが埋まる）。
 */
export async function recordEntrySkip(
  root: string,
  reason: EntrySkipReason,
  request: string,
  sessionID: string | null,
): Promise<void> {
  if (reason === "internal") return;
  await logDecision(root, {
    kind: "decide-skip",
    request: request.slice(0, 200),
    result: reason,
    confidence: null,
    latencyMs: 0,
    fallback: false,
    reason: `entry判定スキップ(${reason})`,
    sessionID,
  });
}

/** decisions.jsonl の末尾だけ読んで decide 行を走査する */
function readDecisionRows(root: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(join(root, ".graphhopper/decisions.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const rows: Array<Record<string, unknown>> = [];
    for (const l of lines.slice(-2000)) {
      try {
        rows.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // 壊れた行は無視（1行で全体が落ちない）
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** このセッションに直近の decide 行があるか（goal start 時の保険の判定用） */
export function hasRecentEntryDecision(
  root: string,
  sessionID: string | null,
  now: number = Date.now(),
  windowMs: number = ENTRY_DECIDE_FRESH_MS,
): boolean {
  const rows = readDecisionRows(root);
  for (const r of rows) {
    if (r.kind !== "decide") continue;
    if (sessionID && r.sessionID !== sessionID) continue;
    const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (now - ts <= windowMs) return true;
  }
  return false;
}

/**
 * goal start 時の保険: 直近に decide 行が無ければ goal title を入力に判定して**記録だけ**残す。
 * route は変えない（entry_route は既存の route_set / fail-safe に委ねる）。
 */
export async function ensureEntryDecision(
  root: string,
  sessionID: string | null,
  title: string,
  opts?: { fetchFn?: typeof fetch; timeoutMs?: number; now?: number },
): Promise<EntryVerdict | null> {
  if (hasRecentEntryDecision(root, sessionID, opts?.now ?? Date.now())) {
    return null;
  }
  return decideEntry(title, opts?.fetchFn ?? fetch, {
    root,
    sessionID,
    timeoutMs: opts?.timeoutMs ?? ENTRY_DECIDE_TIMEOUT_MS,
  });
}
