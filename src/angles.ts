/**
 * angles — verify の「角度」（純粋層。design g-mwmqmg6b 判断1・2・4）。
 *
 * 固定の lens をやめ、変更ごとに疑う角度を選んで並列に検証する。ここは角度の一覧・枠の数・
 * 計画の組み立て・選ぶ役の prompt と出力の読み取りだけを持つ（I/O・state の実行時依存なし）。
 * 判断ロジックを tool 側に置くと凍結の監視から漏れるので、純粋関数としてここに置く。
 */
import type { Difficulty, RouterRoute } from "./state";

/** 角度の id。一覧の id か、選ぶ役・メインが作った id（実行時に isValidAngleId で検証する） */
export type AngleId = string;

/** 出どころ。持ち越しても変えない（持ち越しかどうかは別の印） */
export type AngleSource = "list" | "created" | "default" | "main_add" | "followup";

export interface Angle {
  id: AngleId;
  /** 題（短く） */
  title: string;
  /** 疑うこと */
  doubt: string;
  /** 見るファイルの範囲（diff が途中で切れても、この範囲は自分で開いて見る） */
  scope: string;
}

export const AGREEMENT_ID = "agreement";
export const SIBLINGS_ID = "siblings";
export const RESERVED_ANGLE_IDS: readonly string[] = [AGREEMENT_ID, SIBLINGS_ID];

/** メインが 1 つの diff に足せる角度の数（枠の外） */
export const MAX_MAIN_ADD = 2;

/** 選ぶ役が失敗したときの既定（順に残りの枠へ入れる） */
export const DEFAULT_ANGLE_IDS: readonly string[] = ["wiring", "test-efficacy", "cleanup", "behavior"];

export const AGREEMENT: Angle = {
  id: AGREEMENT_ID,
  title: "合意との照合",
  doubt:
    "design と意図ログで決めたことが全部実装に入っているか。決めていないこと（スコープの膨張）が入っていないか。進捗タスクに未完・cancel の理由が妥当でないものが残っていないか。",
  scope: "design・意図ログ・進捗タスクと diff の全体。",
};

export const SIBLINGS: Angle = {
  id: SIBLINGS_ID,
  title: "同じ種類の問題",
  doubt:
    "渡された指摘ファイルの問題と同じ種類のものが、指摘された場所以外にないか。同じ関数・同じパターン・同じ前提を使う別の箇所を探す。指摘された場所そのものは再報告しない。",
  scope: "指摘ファイルが挙げた場所の呼び出し元・兄弟関数・同じパターンを使う箇所。",
};

/** 出発点の一覧（選ぶ役はここから選んでも、新しい角度を作ってもよい） */
export const ANGLES: readonly Angle[] = [
  {
    id: "wiring",
    title: "配線",
    doubt:
      "新しく足した値・引数・関数が、入口から出口（呼び出し元・返り値・保存先・表示）まで実際につながっているか。型は通っても途中で捨てられていないか。",
    scope: "diff で追加・変更された値の流れを、呼び出し元と返り値の受け手まで。",
  },
  {
    id: "test-efficacy",
    title: "テストの実効性",
    doubt:
      "テストが壊れ方を本当に検出できるか。上限や値を壊しても通る性質テストになっていないか。design に書いたテストが欠けていないか。テストは読んで判定するだけで実行していない。出力に「テストは実行していない」と必ず書く。",
    scope: "diff のテストと、そのテストが守る実装の関数。",
  },
  {
    id: "premise",
    title: "前提の成立",
    doubt:
      "design と実装が置いている前提（ファイルの場所・実行環境・呼ばれる順序・他モジュールの挙動）が、実コードで成り立っているか。",
    scope: "前提が指すファイルと関数を実際に開いて確かめる。",
  },
  {
    id: "frequency",
    title: "運用時の頻度",
    doubt:
      "実運用で頻繁に起きる状況で、記録・通知・拒否が多すぎたり誤検知が多かったりしないか。直近の履歴で頻度を見積もれるものは見積もる。",
    scope: "diff が足す記録・拒否・通知の発火条件。",
  },
  {
    id: "cleanup",
    title: "後始末",
    doubt:
      "新しく作るファイル・状態・記録に、消す・移す・期限の後始末があるか。置き換えた古いコード・未使用の import・古い案内文が残っていないか。",
    scope: "diff が作るファイルと状態の置き場所、置き換えた関数の旧参照。",
  },
  {
    id: "report-evidence",
    title: "報告と証拠",
    doubt:
      ".log.md・コメント・案内文の記述が、実際の diff と履歴に合っているか。決定の経緯と棄却した代替案が .log.md に追記されているか。",
    scope: ".log.md・変えた文書・コメントと、それが述べる実装。",
  },
  {
    id: "behavior",
    title: "挙動",
    doubt:
      "コードの境界値・失敗時の挙動（空・null・timeout・不正入力・途中で切れた場合）が正しいか。テストの良し悪しは扱わない。",
    scope: "diff で変えた関数の分岐と失敗経路。",
  },
];

const ANGLE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidAngleId(id: unknown): id is AngleId {
  return typeof id === "string" && ANGLE_ID.test(id);
}

export function findListAngle(id: string): Angle | undefined {
  return ANGLES.find((a) => a.id === id);
}

/** 計画の 1 件（作られた角度の文面も持つので、計画だけで prompt を作れる） */
export interface PlanEntry extends Angle {
  source: AngleSource;
  /** 前の diff で drift だったので入った角度か */
  carried: boolean;
}

export interface AnglePlan {
  diff_hash: string;
  entries: PlanEntry[];
}

export interface SlotInput {
  route: RouterRoute | null;
  difficulty: Difficulty | null;
}

/** `agreement` 以外の角度の枠。判定の順は旧 planVerifier と同じ */
export function angleSlots(o: SlotInput): number {
  if (o.difficulty === "easy") return 1;
  return o.route === "polish" ? 4 : 2;
}

const entryOf = (a: Angle, source: AngleSource, carried = false): PlanEntry => ({
  id: a.id,
  title: a.title,
  doubt: a.doubt,
  scope: a.scope,
  source,
  carried,
});

/** 枠に数える角度（`agreement`・メイン追加・持ち越しでない `siblings` は数えない） */
function counted(e: PlanEntry): boolean {
  return e.id !== AGREEMENT_ID && e.source !== "main_add";
}

export function remainingSlots(plan: AnglePlan, slots: number): number {
  return Math.max(0, slots - plan.entries.filter(counted).length);
}

export interface PrevResult {
  lens: string;
  level: "clean" | "drift";
}

/** 前の diff で drift だった角度を持ち越す。`agreement` は常に入るので持ち越しの印は付けない。
 * 持ち越したまま判定が出なかった角度（判定不能のまま diff が変わった）も落とさずに持ち越す */
export function carryOver(prev: AnglePlan | null, prevResults: PrevResult[]): PlanEntry[] {
  const drifted = new Set(prevResults.filter((r) => r.level === "drift").map((r) => r.lens));
  const judged = new Set(prevResults.map((r) => r.lens));
  const out: PlanEntry[] = [];
  for (const e of prev?.entries ?? []) {
    if (e.id === AGREEMENT_ID) continue;
    if (drifted.has(e.id) || (e.carried && !judged.has(e.id))) out.push({ ...e, carried: true });
  }
  if (drifted.has(SIBLINGS_ID) && !out.some((e) => e.id === SIBLINGS_ID)) {
    out.push(entryOf(SIBLINGS, "followup", true));
  }
  return out;
}

/** 最初の計画（`agreement` と持ち越し。持ち越しは枠を超えても入る） */
export function initialPlan(diffHash: string, carried: PlanEntry[]): AnglePlan {
  return { diff_hash: diffHash, entries: [entryOf(AGREEMENT, "list"), ...carried] };
}

export interface Pick {
  id: AngleId;
  source: "list" | "created";
  title: string;
  doubt: string;
  scope: string;
}

export type SelectionResult = { ok: true; picks: Pick[] } | { ok: false; reason: string };

const clip = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** 選ぶ役の出力（json 1 つ）を読む。予約 id・重複・文面の無い新しい角度は捨て、枠で切る。
 * 0 個・読めない出力は失敗（呼び出し側が既定の角度に切り替える） */
export function parseSelection(obj: Record<string, unknown> | null, slots: number): SelectionResult {
  const raw = obj?.["angles"];
  if (!Array.isArray(raw)) return { ok: false, reason: "angles の配列が無い" };
  const picks: Pick[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (picks.length >= slots) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = rec["id"];
    if (!isValidAngleId(id) || RESERVED_ANGLE_IDS.includes(id) || seen.has(id)) continue;
    const listed = findListAngle(id);
    const scope = clip(rec["scope"], 400);
    if (listed) {
      picks.push({ id, source: "list", title: listed.title, doubt: listed.doubt, scope: scope || listed.scope });
    } else {
      const title = clip(rec["title"], 40);
      const doubt = clip(rec["doubt"], 400);
      if (!title || !doubt) continue;
      picks.push({ id, source: "created", title, doubt, scope: scope || "diff の関連箇所" });
    }
    seen.add(id);
  }
  if (picks.length === 0) return { ok: false, reason: "選ばれた角度が 0 個" };
  return { ok: true, picks };
}

export function applyPicks(plan: AnglePlan, picks: Pick[], slots: number): AnglePlan {
  const entries = [...plan.entries];
  let room = remainingSlots(plan, slots);
  for (const p of picks) {
    if (room <= 0) break;
    if (entries.some((e) => e.id === p.id)) continue;
    entries.push({ id: p.id, title: p.title, doubt: p.doubt, scope: p.scope, source: p.source, carried: false });
    room -= 1;
  }
  return { ...plan, entries };
}

/** 選ぶ役が失敗したとき、既定の角度を残りの枠へ入れる */
export function applyDefaults(plan: AnglePlan, slots: number): AnglePlan {
  const picks: Pick[] = [];
  for (const id of DEFAULT_ANGLE_IDS) {
    const a = findListAngle(id);
    if (a) picks.push({ id, source: "list", title: a.title, doubt: a.doubt, scope: a.scope });
  }
  const entries = [...plan.entries];
  let room = remainingSlots(plan, slots);
  for (const p of picks) {
    if (room <= 0) break;
    if (entries.some((e) => e.id === p.id)) continue;
    entries.push({ id: p.id, title: p.title, doubt: p.doubt, scope: p.scope, source: "default", carried: false });
    room -= 1;
  }
  return { ...plan, entries };
}

export interface AddInput {
  id: string;
  title?: string;
  doubt?: string;
  scope?: string;
}

export type AddResult = { ok: true; plan: AnglePlan; added: string[] } | { ok: false; error: string };

/** メインの `add`。枠の外で、その diff で 2 個まで。判定の順:
 * (1) 予約 id はエラー (2) 計画にある id は無視 (3) 新しい id が 2 個を超えるならエラー（1 つも足さない） */
export function applyAdds(plan: AnglePlan, adds: AddInput[]): AddResult {
  const fresh: PlanEntry[] = [];
  for (const a of adds) {
    if (!isValidAngleId(a.id)) return { ok: false, error: `add の id が不正です: ${String(a.id)}（小文字英数とハイフン、32 文字まで）` };
    if (RESERVED_ANGLE_IDS.includes(a.id)) return { ok: false, error: `add できない予約 id です: ${a.id}` };
    if (plan.entries.some((e) => e.id === a.id) || fresh.some((e) => e.id === a.id)) continue;
    const listed = findListAngle(a.id);
    const title = clip(a.title, 40) || listed?.title || "";
    const doubt = clip(a.doubt, 400) || listed?.doubt || "";
    if (!title || !doubt) return { ok: false, error: `新しい角度 ${a.id} には title と doubt が要ります` };
    fresh.push({
      id: a.id,
      title,
      doubt,
      scope: clip(a.scope, 400) || listed?.scope || "diff の関連箇所",
      source: "main_add",
      carried: false,
    });
  }
  const used = plan.entries.filter((e) => e.source === "main_add" && !e.carried).length;
  if (used + fresh.length > MAX_MAIN_ADD) {
    return { ok: false, error: `add は 1 つの diff に ${MAX_MAIN_ADD} 個までです（今 ${used} 個、追加 ${fresh.length} 個）` };
  }
  return { ok: true, plan: { ...plan, entries: [...plan.entries, ...fresh] }, added: fresh.map((e) => e.id) };
}

/** 2 巡目（追い検証）の上限。初回を含めて 2 巡 */
export const MAX_ROUNDS = 2;

/** 2 巡目の `siblings` を走らせるか。1 巡目に drift がある、または `siblings` が持ち越されている */
export function needsFollowup(plan: AnglePlan, firstRound: PrevResult[]): boolean {
  if (plan.entries.some((e) => e.id === SIBLINGS_ID)) return true;
  return firstRound.some((r) => r.level === "drift" && r.lens !== SIBLINGS_ID);
}

/** 1 巡目に走らせる角度（持ち越した `siblings` は 2 巡目なので除く） */
export function firstRoundEntries(plan: AnglePlan): PlanEntry[] {
  return plan.entries.filter((e) => e.id !== SIBLINGS_ID);
}

/** 選ぶ役の prompt（判定ではなく角度の json を返させる） */
export function buildSelectorPrompt(o: {
  designPath: string;
  diffPath: string;
  slots: number;
  taken: string[];
}): string {
  const list = ANGLES.map((a) => `- ${a.id}（${a.title}）: ${a.doubt}`).join("\n");
  return [
    "あなたは graphhopper の verifier の「角度を選ぶ役」である。検証そのものはしない。",
    "この変更で何を疑うべきかを、diff と design を読んで選ぶ。",
    "",
    "## 読むもの（path で渡す）",
    `design: ${o.designPath}`,
    `diff: ${o.diffPath}`,
    "diff は途中で切れている可能性がある。変更が大きいときは diff のファイル一覧を見て、疑うべき角度を決める。",
    "",
    "## 出発点の一覧（ここから選んでも、新しい角度を作ってもよい）",
    list,
    "",
    "## 選び方",
    `- ${o.slots} 個まで選ぶ（1 個以上）。この変更に当たりそうな角度だけを選び、無関係な角度は選ばない。`,
    `- 次の id は選ばない（常設・自動で入る）: ${[...new Set([AGREEMENT_ID, SIBLINGS_ID, ...o.taken])].join(", ")}`,
    "- 新しい角度を作るときは、id（小文字英数とハイフン）・title・doubt（疑うこと）を書く。",
    "- 各角度に scope（見るファイルの範囲。diff に出てくる path や関数名）を書く。diff が切れていても、その範囲は検証役が自分で開く。",
    "",
    "## 出力形式（必須）",
    "説明は書かず、末尾に json フェンスを 1 つだけ出す。",
    "```json",
    '{"angles":[{"id":"wiring","scope":"src/foo.ts の bar と、その呼び出し元"},{"id":"new-angle-id","title":"題","doubt":"疑うこと","scope":"見る範囲"}]}',
    "```",
  ].join("\n");
}
