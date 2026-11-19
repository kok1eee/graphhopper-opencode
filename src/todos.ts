/**
 * todo — 進捗ストアの純粋層。
 *
 * 型・パーサ・状態遷移・ゲート判定のみ。IO は src/state.ts（readTodos/writeTodos）。
 * 「進捗の source of truth」は graphhopper 自身のストア（.graphhopper/todos/<goalId>.json）。
 * 決定記録は designing 終端で不変のため進捗の計測源にできない（進捗Lens との二重管理も避ける）。
 */

/** タスクの状態。pending/in_progress が「未完了」 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  /** 連番で採番した ID（t1, t2, ...）。決定記録の行番号は使わない */
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
