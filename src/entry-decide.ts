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
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decideRoute,
  logDecision,
  type DecideResult,
  type FetchFn,
} from "./decision";

/** hook 経路の d1 待ち時間上限。モデル呼び出しを止めるので短めに切る */
export const ENTRY_DECIDE_TIMEOUT_MS = 5_000;

/** goal start 時の保険で「直近」とみなす decide 行の窓 */
export const ENTRY_DECIDE_FRESH_MS = 5 * 60_000;

/** decisions.jsonl を末尾何バイト読むか（先頭からの全走査を避ける）。
 * skip 行も毎 prompt 記録されるので 5 分の窓を余裕をもって覆う */
export const DECISION_TAIL_BYTES = 256 * 1024;

/** plugin 内部 prompt の識別子。ctx.session.prompt に付けて渡す */
export const INTERNAL_PROMPT_METADATA_KEY = "graphhopper_internal";

/** plugin 内部 prompt の本文マーカー（metadata が届かない場合の保険）。
 * "[graphhopper..." は自動継続・eval 失敗通知、"## graphhopper" は handoff 通知 */
const INTERNAL_TEXT_PREFIXES = ["[graphhopper", "## graphhopper"];

/**
 * plugin 自身が投げた prompt か（自動継続・eval 失敗通知・handoff など）。
 * metadata の印と本文マーカーの両方を見る。
 */
export function isInternalPrompt(
  metadata: Record<string, unknown> | undefined,
  text: string,
): boolean {
  if (metadata?.[INTERNAL_PROMPT_METADATA_KEY] === true) return true;
  const t = text.trimStart();
  return INTERNAL_TEXT_PREFIXES.some((p) => t.startsWith(p));
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
  fetchFn: FetchFn = fetch,
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
 * 除外は全て記録する（internal も含む。自動継続の回数もカバレッジの一部として数える）。
 */
export async function recordEntrySkip(
  root: string,
  reason: EntrySkipReason,
  request: string,
  sessionID: string | null,
): Promise<void> {
  await logDecision(root, {
    kind: "decide-skip",
    request,
    result: reason,
    confidence: null,
    latencyMs: 0,
    fallback: false,
    reason: `entry判定スキップ(${reason})`,
    sessionID,
  });
}

/** decisions.jsonl の末尾だけ読む（先頭から全部走査しない） */
function readDecisionRows(root: string): Array<Record<string, unknown>> {
  const path = join(root, ".graphhopper/decisions.jsonl");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - DECISION_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    /* 先頭が切れた行は JSON.parse が失敗して無視される（1行で全体が落ちない） */
    const rows: Array<Record<string, unknown>> = [];
    for (const l of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        rows.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // 壊れた行は無視
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** このセッションに直近の decide 行があるか（goal start 時の保険の判定用）。
 * sessionID が null のときは「セッション不明」として一致なしとみなす（他セッションの decide で代用しない） */
export function hasRecentEntryDecision(
  root: string,
  sessionID: string | null,
  now: number = Date.now(),
  windowMs: number = ENTRY_DECIDE_FRESH_MS,
): boolean {
  if (!sessionID) return false;
  const rows = readDecisionRows(root);
  for (const r of rows) {
    if (r.kind !== "decide") continue;
    if (r.sessionID !== sessionID) continue;
    const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (now - ts <= windowMs) return true;
  }
  return false;
}

/**
 * goal start 時の保険: 直近に decide 行が無ければ goal title を入力に判定して**記録だけ**残す。
 * route は変えない（entry_route は既存の route_set / fail-safe に委ねる）。
 *
 * - セッションが不明なときは何もしない（他セッションの decide と二重計上になるため）。
 * - API キーが無い環境では判定しない（失敗した decide 行が goal ごとに残ると
 *   calibrate の decide×outcome 結合が偽の decide に実績を吸わせる）。
 * - 例外は投げない（goal start を止めない）。呼び出し側で try/catch しないためのもの。
 */
export async function ensureEntryDecision(
  root: string,
  sessionID: string | null,
  title: string,
  opts?: { fetchFn?: FetchFn; timeoutMs?: number; now?: number },
): Promise<EntryVerdict | null> {
  try {
    /* セッション不明では Recent 判定も紐付けもできない。
     * 保険 运行すると他セッションの decide と二重計上になるので行わない */
    if (!sessionID) return null;
    if (!process.env.LIQUID_API_KEY?.trim()) {
      await recordEntrySkip(root, "no_api_key", title, sessionID);
      return null;
    }
    if (hasRecentEntryDecision(root, sessionID, opts?.now ?? Date.now())) {
      return null;
    }
    return await decideEntry(title, opts?.fetchFn ?? fetch, {
      root,
      sessionID,
      timeoutMs: opts?.timeoutMs ?? ENTRY_DECIDE_TIMEOUT_MS,
    });
  } catch {
    // 判定の失敗で goal start を止めない
    return null;
  }
}
