/**
 * todo — 進捗ストアの純粋層。
 *
 * 型・パーサ・状態遷移・ゲート判定のみ。IO は src/state.ts（readTodos/writeTodos/ensureTodos）。
 * 「進捗の source of truth」は graphhopper 自身のストア（.graphhopper/todos/<goalId>.json）。
 * design.md は planning 終端で immutable のため進捗の計測源にできない（進捗Lens との二重管理も避ける）。
 */

/** タスクの状態。pending/in_progress が「未完了」 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  /** 連番で採番した ID（t1, t2, ...）。design.md の行番号は使わない */
  id: string;
  text: string;
  status: TodoStatus;
  /** cancelled の理由（cancel のみ必須） */
  reason?: string;
  updated_at: string;
}

export interface TodoStore {
  goal_id: string;
  items: TodoItem[];
  updated_at: string;
}

/** scaffold が生成するプレースホルダ行。実タスクではないので seed 対象外 */
export const SCAFFOLD_TASK_PLACEHOLDER = "T1 （タスク）";

/** タスク列セクションの見出し（seed の対象範囲） */
const TASK_SECTION_HEADING = /^#{2,}\s+.*タスク列.*$/m;
/**
 * フォールバックの見出し。design doc の構造ゲート（gate.ts）は
 * 「タスク」を含む見出ししか要求しないので、ここも緩く合わせる。
 * 嚴密版が見つからないときはこれを使う（見出し名の違いで
 * 進捗ゲートが無言で無効化されるのを防ぐ）。
 */
const TASK_SECTION_FALLBACK = /^#{2,}\s+.*タスク.*$/m;
/** 次の見出し（m フラグ必須。無いと全体を切り出せない） */
const ANY_HEADING = /^#{2,}\s+/m;

/** 状態遷移表。pending→* はBeware、終端からの差し戻し/復旧も許す */
const ALLOWED_TRANSITIONS: Record<TodoStatus, readonly TodoStatus[]> = {
  pending: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled", "pending"],
  completed: ["in_progress"],
  cancelled: ["pending"],
};

export function isAllowedTransition(from: TodoStatus, to: TodoStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ParsedTask {
  text: string;
  done: boolean;
}

/* チェックボックス行の正規表現。既存の extractTasks と同一の挙動を保つ */
const TASK_LINE = /^\s*-\s*\[([ x])\]\s*(\S.*)$/;

/**
 * 全チェックボックス行を抽出する（read-only）。
 * 既存の extractTasks と同じ素朴な行パース。ネスト・改行またぎは対象外。
 */
export function parseTaskLines(raw: string): ParsedTask[] {
  const items: ParsedTask[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(TASK_LINE);
    if (!m) continue;
    items.push({ text: (m[2] ?? "").slice(0, 200), done: m[1] === "x" });
  }
  return items;
}

/**
 * 「タスク列」セクションの本文を切り出す。
 * 見出し /^#{2,}\s+.*タスク列.*$/ の直後から次の同階層見出しまで。
 * 該当セクションが無ければ「タスク」を含む見出しにフォールバックし、
 * それでも無ければ空文字。
 */
export function extractTaskSection(raw: string): string {
  return sectionBody(raw, TASK_SECTION_HEADING) ?? sectionBody(raw, TASK_SECTION_FALLBACK) ?? "";
}

/** 見出し正規表現に一致するセクションの本文を返す（無ければ null） */
function sectionBody(raw: string, heading: RegExp): string | null {
  const m = raw.match(heading);
  if (!m || m.index === undefined) return null;
  const rest = raw.slice(m.index + m[0].length);
  const next = rest.search(ANY_HEADING);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/**
 * seed 対象のタスク行を抽出する。
 * - 「タスク列」セクション内のチェックボックス行だけ（受け入れ基準などの別セクションは対象外）
 * - scaffold のプレースホルダ行は除く
 */
export function parseSeedTasks(raw: string): ParsedTask[] {
  return parseTaskLines(extractTaskSection(raw)).filter(
    (t) => t.text !== SCAFFOLD_TASK_PLACEHOLDER,
  );
}

/** 既存 ID から次の連番を採番する（t1..tn の max+1） */
export function nextTodoId(items: readonly TodoItem[]): string {
  let max = 0;
  for (const it of items) {
    const m = it.id.match(/^t(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t${max + 1}`;
}

export interface SeedResult {
  store: TodoStore;
  /** 新規追加件数 */
  added: number;
  /** design.md 内で同じ文言が複数回出た場合の回数（呼び出し側で警告に使う） */
  duplicateTexts: number;
}

/**
 * seed の idempotent merge。
 * 既存ストアは消さず、design.md のタスク集合との差分だけを追記する。
 * 照合はテキスト一致（複数回出現する文言は出現順で対応づける）。
 */
export function seedMerge(
  store: TodoStore,
  tasks: readonly ParsedTask[],
  now: string,
): SeedResult {
  const items = [...store.items];
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.text, (counts.get(it.text) ?? 0) + 1);

  const seenInTasks = new Map<string, number>();
  let added = 0;
  for (const t of tasks) {
    seenInTasks.set(t.text, (seenInTasks.get(t.text) ?? 0) + 1);
    const c = counts.get(t.text) ?? 0;
    if (c > 0) {
      // 既存タスクが design.md 側と対応。追加しない（id を保つ）
      counts.set(t.text, c - 1);
      continue;
    }
    // 新規追加。counts は「既存ストアに何個あるか」なので増やさない
    // （同文が design.md に複数あれば、それぞれ別 id で追加する）
    items.push({
      id: nextTodoId(items),
      text: t.text,
      status: t.done ? "completed" : "pending",
      updated_at: now,
    });
    added++;
  }

  let duplicateTexts = 0;
  for (const n of seenInTasks.values()) if (n > 1) duplicateTexts += n - 1;

  return {
    store: { ...store, items, updated_at: now },
    added,
    duplicateTexts,
  };
}

export interface TodoProgress {
  total: number;
  /** completed の数 */
  done: number;
  cancelled: number;
  /** pending + in_progress（= ゲートで未完了とみなす数） */
  open: number;
  items: TodoItem[];
}

/**
 * 外部の未型付けデータ（JSON を読む経路）から TodoItem[] に正規化する。
 * 不正な要素は捨てる。進捗の件数判定はここへ集約する。
 */
export function normalizeTodoItems(raw: unknown): TodoItem[] {
  return splitTodoItems(raw).items;
}

/** 正規化の結果と、捨てられた不正要素の件数 */
export interface NormalizedTodoItems {
  items: TodoItem[];
  /** 捨てられた不正要素の件数（0 なら完全） */
  invalidCount: number;
}

/** 正規化しつつ、捨てられた要素数を数える（B9: 黙って減るとゲートの対象から外れる） */
export function splitTodoItems(raw: unknown): NormalizedTodoItems {
  const rec = raw as { items?: unknown } | null;
  if (!rec || !Array.isArray(rec.items)) return { items: [], invalidCount: 0 };
  const out: TodoItem[] = [];
  let invalidCount = 0;
  for (const it of rec.items) {
    if (!it || typeof it !== "object") {
      invalidCount++;
      continue;
    }
    const t = it as Partial<TodoItem>;
    if (typeof t.id !== "string" || typeof t.text !== "string") {
      invalidCount++;
      continue;
    }
    const status: TodoStatus =
      t.status === "completed" || t.status === "cancelled" || t.status === "in_progress"
        ? t.status
        : "pending";
    out.push({
      id: t.id,
      text: t.text,
      status,
      ...(typeof t.reason === "string" ? { reason: t.reason } : {}),
      updated_at: typeof t.updated_at === "string" ? t.updated_at : "",
    });
  }
  return { items: out, invalidCount };
}

/** タスク配列から進捗集計を作る */
export function todoProgressOf(items: readonly TodoItem[]): TodoProgress {
  return {
    total: items.length,
    done: items.filter((i) => i.status === "completed").length,
    cancelled: items.filter((i) => i.status === "cancelled").length,
    open: items.filter((i) => i.status === "pending" || i.status === "in_progress")
      .length,
    items: [...items],
  };
}

export function todoProgress(store: TodoStore): TodoProgress {
  return todoProgressOf(store.items);
}

export function isTodoComplete(store: TodoStore): boolean {
  return todoProgress(store).open === 0;
}
export interface MarkResult {
  ok: boolean;
  store: TodoStore;
  error?: string;
}

/**
 * 状態変更。遷移表と cancel の reason 必須を検証する。
 * 失敗時は store を変更せず error を返す。
 */
export function applyMark(
  store: TodoStore,
  id: string,
  status: TodoStatus,
  opts: { reason?: string; now: string },
): MarkResult {
  const i = store.items.findIndex((it) => it.id === id);
  if (i < 0) return { ok: false, store, error: `タスク ${id} が無い` };
  const cur = store.items[i]!;
  if (!isAllowedTransition(cur.status, status)) {
    return {
      ok: false,
      store,
      error: `遷移不可: ${cur.status} → ${status}（${id}）`,
    };
  }
  if (status === "cancelled" && !opts.reason?.trim()) {
    return { ok: false, store, error: `cancel には reason が要る（${id}）` };
  }
  const next: TodoItem = { ...cur, status, updated_at: opts.now };
  if (status === "cancelled") next.reason = opts.reason!.trim();
  else delete next.reason;
  const items = [...store.items];
  items[i] = next;
  return { ok: true, store: { ...store, items, updated_at: opts.now } };
}

export interface AddResult {
  ok: boolean;
  store: TodoStore;
  error?: string;
  id?: string;
}

/** 実装中に増えたタスクの追加 */
export function addTodo(
  store: TodoStore,
  text: string,
  now: string,
): AddResult {
  const t = text.trim();
  if (!t) return { ok: false, store, error: "text が空" };
  if (t.length > 200) return { ok: false, store, error: "text が長すぎる（200文字まで）" };
  const id = nextTodoId(store.items);
  const items = [...store.items, { id, text: t, status: "pending" as TodoStatus, updated_at: now }];
  return {
    ok: true,
    store: { ...store, items, updated_at: now },
    id,
  };
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** 進捗ゲート。未尽了タスクがあれば拒否メッセージを、なければ null を返す */
/**
 * ストア不読・要素不正のときの共通メッセージ（単一源泉）。
 * ゲート（checkPhaseMove / setPhaseChecked）はどちらもこれを使う。
 * null ならストアは正常。
 */
export function todoStoreError(loaded: {
  valid: boolean;
  invalidCount: number;
}): string | null {
  if (!loaded.valid) {
    return (
      "todo ストアが壊れています（読み込めません）。進捗を機械的に強制できないため遷移を拒否します" +
      "（fail-closed）。ストア（.graphhopper/todos/<goalId>.json）を手で修復するか、goal を作り直してください"
    );
  }
  if (loaded.invalidCount > 0) {
    return (
      `todo ストアに不正要素が ${loaded.invalidCount} 件あります。進捗を機械的に強制できないため遷移を拒否します` +
      "（fail-closed）。ストア（.graphhopper/todos/<goalId>.json）を手で修復してください"
    );
  }
  return null;
}

export function todoGateError(store: TodoStore): string | null {
  if (isTodoComplete(store)) return null;
  const p = todoProgress(store);
  const open = p.items.filter(
    (i) => i.status === "pending" || i.status === "in_progress",
  );
  const list = open.map((i) => `  - ${i.id}: ${i.text}`).join("\n");
  return (
    `未完了のタスクが ${p.open} 件ある。` +
    `graphhopper_todo で completed か cancelled（reason 必須）にしてから遷移せよ:\n${list}`
  );
}

/** 表示用（1行ずつ） */
export function formatTodoList(store: TodoStore): string {
  if (store.items.length === 0) return "(タスクなし)";
  const p = todoProgress(store);
  const lines = store.items.map(
    (i) =>
      `${STATUS_MARK[i.status]} ${i.id}: ${i.text}` +
      (i.status === "cancelled" && i.reason ? `（理由: ${i.reason}）` : ""),
  );
  lines.push(`完了 ${p.done}/${p.total}（cancel ${p.cancelled}・未完了 ${p.open}）`);
  return lines.join("\n");
}

/** TUI チップ用の最短形。タスク 0 件なら null */
export function formatTodoChip(progress: { total: number; done: number }): string | null {
  if (progress.total === 0) return null;
  return `✓${progress.done}/${progress.total}`;
}
