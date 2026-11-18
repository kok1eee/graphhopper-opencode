/**
 * goal 開始時の会話から「意図ログ」を作る（design g-mwebh9vl）。
 * critic / agreement 角度だけに渡す生ログ。要約はしない。
 * 注意: hooks の toLike とは目的が違う（あちらは tool part を残してループ検知に使う）。
 * この変換は text だけを拾い、内部注入と tool を落とす。
 */
import { isInternalPrompt } from "./entry-decide";

/** v2 の SessionMessageInfo のうち、意図ログに必要な形だけ */
export interface IntentMessage {
  type?: string;
  text?: string;
  content?: { type?: string; text?: string }[];
  metadata?: Record<string, unknown>;
}

export interface IntentTurn {
  role: "me" | "assistant";
  text: string;
}

export const INTENT_MAX_TURNS = 40;
export const INTENT_MAX_CHARS = 24_000;
export const INTENT_MAX_FETCH_CHARS = 2_000_000;

/** 既知のキー形式を伏せる（best-effort。完全な検出ではない） */
export function maskSecrets(text: string): string {
  return text
    .replace(/\boc_sk_[A-Za-z0-9_-]{8,}/g, "oc_sk_***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\bAKIA[0-9A-Z]{12,}/g, "AKIA***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "xox*-***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***");
}

function isInternal(m: IntentMessage, text: string): boolean {
  return isInternalPrompt(m.metadata, text);
}

/**
 * v2 メッセージ列 → me/assistant のターン列（text のみ）。
 * assistant の tool part は意図的に捨てる。hooks の toLike は逆に tool part を残し、
 * 同一 tool call 反復検知（detectLoopKind / isToolRepeatLoop）に使う。
 * 目的が違うので、この2つを統合してはいけない（統合するとループ検知が壊れる）。
 */
export function toIntentTurns(messages: IntentMessage[]): IntentTurn[] {
  const out: IntentTurn[] = [];
  for (const m of messages ?? []) {
    if (m?.type === "user") {
      const text = String(m.text ?? "").trim();
      if (!text || isInternal(m, text)) continue;
      out.push({ role: "me", text });
    } else if (m?.type === "assistant") {
      const text = (m.content ?? [])
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => String(c.text).trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text) continue;
      out.push({ role: "assistant", text });
    }
  }
  return out;
}

/** 原依頼（最初の me）を残し、残りを直近 maxTurns 件にする */
function selectTurns(
  turns: IntentTurn[],
  maxTurns: number,
): { kept: IntentTurn[]; omitted: number } {
  if (turns.length <= maxTurns) return { kept: turns, omitted: 0 };
  const anchor = turns.findIndex((t) => t.role === "me");
  const tailCount = Math.max(1, anchor >= 0 ? maxTurns - 1 : maxTurns);
  const tail = turns.slice(-tailCount);
  const kept = anchor >= 0 && !tail.includes(turns[anchor]!) ? [turns[anchor]!, ...tail] : tail;
  return { kept, omitted: turns.length - kept.length };
}

/** 文字数上限に収める。原依頼（先頭の me）は残し、古い側から落とす */
function fitChars(
  turns: IntentTurn[],
  maxChars: number,
): { kept: IntentTurn[]; omitted: number } {
  const kept = [...turns];
  let omitted = 0;
  const size = (): number =>
    kept.reduce((n, t) => n + t.role.length + t.text.length + 4, 0);
  while (size() > maxChars && kept.length > 1) {
    const dropIdx = kept[0]?.role === "me" && kept.length > 2 ? 1 : 0;
    kept.splice(dropIdx, 1);
    omitted++;
  }
  // 1件だけで上限を超える場合は本文を切る（巨大な貼り付け対策）
  const only = kept[0];
  if (kept.length === 1 && only && size() > maxChars) {
    const room = Math.max(0, maxChars - (only.role.length + 4));
    kept[0] = { role: only.role, text: `${only.text.slice(0, room)}…(truncated)` };
  }
  return { kept, omitted };
}

/** status / start 応答に出す1行（文言の単一源泉） */
export function formatIntentLine(path: string): string {
  return `intent: ${path}（critic と agreement 角度に渡す）`;
}

export interface RenderIntentOptions {
  goalId?: string;
  title?: string;
  sessionID?: string;
  capturedAt?: string;
  maxTurns?: number;
  maxChars?: number;
  maxFetchChars?: number;
}

/** 意図ログの全文。取得が大きすぎる・有効な発言が無い場合は null */
export function renderIntent(
  messages: IntentMessage[],
  opts: RenderIntentOptions = {},
): string | null {
  const maxFetch = opts.maxFetchChars ?? INTENT_MAX_FETCH_CHARS;
  const fetchSize = (messages ?? []).reduce(
    (n, m) =>
      n +
      String(m.text ?? "").length +
      (m.content ?? []).reduce((k, c) => k + String(c.text ?? "").length, 0),
    0,
  );
  if (fetchSize > maxFetch) return null;

  const turns = toIntentTurns(messages);
  if (turns.length === 0) return null;

  const selected = selectTurns(turns, opts.maxTurns ?? INTENT_MAX_TURNS);
  const fitted = fitChars(selected.kept, opts.maxChars ?? INTENT_MAX_CHARS);
  if (fitted.kept.length === 0) return null;
  const omitted = selected.omitted + fitted.omitted;

  const header = [
    `# intent: ${maskSecrets(opts.title ?? "(untitled)")}${opts.goalId ? ` (${opts.goalId})` : ""}`,
    `source: ${opts.sessionID ? `session ${maskSecrets(opts.sessionID)}` : "session (unknown)"} at ${
      opts.capturedAt ?? new Date().toISOString()
    } · ${fitted.kept.length} turns`,
    ...(omitted > 0 ? [`...(older messages omitted: ${omitted})`] : []),
    "---",
    "",
  ].join("\n");

  return (
    header +
    fitted.kept
      .map((t) => `${t.role}: ${maskSecrets(t.text)}`)
      .join("\n\n") +
    "\n"
  );
}
