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
import {
  decideDifficulty,
  decideRoute,
  decisionAvailable,
  logDecision,
  type DecideResult,
  type FetchFn,
} from "./decision";
import type { Difficulty } from "./state";

/** hook 経路の d1 待ち時間上限。モデル呼び出しを止めるので短めに切る */
export const ENTRY_DECIDE_TIMEOUT_MS = 5_000;

/** goal start 時の難易度判定の待ち上限。実測の最大 663ms に対して余裕をみる
 * （入口 hook の 1.5 秒と合わせて 1 往復で最悪 2.5 秒に抑える。design g-mwjsd3om 判断4） */
export const GOAL_DIFFICULTY_TIMEOUT_MS = 1_000;

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
  /* 子セッションかを時間内に確認できなかった。判定すると subagent の内部 prompt が
   * decisions.jsonl に混ざるため、走らせない側に倒す（design g-mwkfisl7 判断2） */
  | "child_unknown"
  | "active_goal"
  | "no_api_key"
  | "session_unknown"
  | "empty";

export type EntryDecideInput = {
  /** ユーザー入力の本文 */
  text: string;
  /** plugin 自身が投げた prompt か（自動継続・eval 失敗通知など） */
  isInternal: boolean;
  /** subagent などの子セッションか。null は時間内に確認できなかった（不明） */
  isChildSession: boolean | null;
  /** 実行中の goal があるか */
  hasActiveGoal: boolean;
  /** 判定モデルを実行できるか（decisionAvailable。jev はキー不要で true） */
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
  /* 不明（null）も判定しない。子に走らせると decisions.jsonl が汚れ、
   * 親に走らせても確認できていない前提で判定することになる（design g-mwkfisl7 判断2） */
  if (input.isChildSession === true) return { run: false, reason: "child_session" };
  if (input.isChildSession === null) return { run: false, reason: "child_unknown" };
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
  /* 難易度は goal start 時に題から判定する（design g-mwjsd3om 判断4）ので、ここでは渡さない */
  return [
    "## graphhopper 入口判定（d1・自動判定済み）",
    "",
    `判定: route=${route}（confidence ${conf}）`,
    `- graphhopper_route_set(route: '${route}', reason: 'd1判定') を呼び、` +
      `graphhopper_goal(action: 'start', title: ...) でループを開始する。`,
    "- 明らかに単一ファイルの小修正・質問応答ならループを作らず直接対応してよい（route_set 不要）。",
    "- d1 の判定は参考値。判断に確信があれば route_set で上書きしてよい。",
  ].join("\n");
}

/** 判定を実行して記録する。失敗は fallback（route=full）として返す */
export async function decideEntry(
  request: string,
  fetchFn: FetchFn = fetch,
  opts?: {
    root?: string;
    sessionID?: string | null;
    messageID?: string | null;
    timeoutMs?: number;
  },
): Promise<EntryVerdict> {
  return decideRoute(request, fetchFn, {
    root: opts?.root,
    sessionID: opts?.sessionID ?? null,
    messageID: opts?.messageID ?? null,
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

/**
 * goal start 時の難易度判定（design g-mwjsd3om 判断4）。
 * route は入口 hook が判定済みなので、ここでは題から難易度だけを決める。
 *
 * - セッション不明では何もしない（他セッションの判定と二重計上になるため）
 * - API キーが無い環境では判定しない（失敗行が goal ごとに残ると較正が汚れる）
 * - 例外は投げない（goal start を止めない）
 * - 上限は GOAL_DIFFICULTY_TIMEOUT_MS（外れたら difficulty: null で始める）
 */
export async function judgeGoalDifficulty(
  root: string,
  sessionID: string | null,
  title: string,
  opts?: { fetchFn?: FetchFn; timeoutMs?: number },
): Promise<Difficulty | null> {
  try {
    if (!sessionID) {
      await recordEntrySkip(root, "session_unknown", title, null);
      return null;
    }
    if (!decisionAvailable()) {
      await recordEntrySkip(root, "no_api_key", title, sessionID);
      return null;
    }
    const r = await decideDifficulty(title, opts?.fetchFn ?? fetch, {
      root,
      sessionID,
      source: "goal-start",
      timeoutMs: opts?.timeoutMs ?? GOAL_DIFFICULTY_TIMEOUT_MS,
    });
    return r.difficulty;
  } catch {
    // 判定の失敗で goal start を止めない
    return null;
  }
}
