/**
 * verdict — verifier の結果の検査と集約（純粋層）。
 *
 * 採点に関わる関数を state.ts から切り出し、凍結の監視対象（verify.ts の rubricCodeHash）を
 * state.ts 丸ごとから外すために分けた（design g-mwmqmg6b 判断5）。
 * state.ts から取るのは型だけ（実行時の循環 import を作らない）。
 */
import { SIBLINGS_ID, isValidAngleId, type AnglePlan } from "./angles";
import type {
  DriftTarget,
  VerdictLevel,
  VerifierLens,
  VerifierSeverityEntry,
} from "./state";

/** verifier fan-out の1レンズ分の結果（verifier_set の results 要素）。
 * model は per-lens上書き（deep時の上位モデル等）。省略時はトップレベルmodel→config既定。
 * 申告値であり実在は検証しない（critic_set／consult_set同型の既知トレードオフ） */
export interface VerifierResult {
  lens: VerifierLens;
  level: VerdictLevel;
  target?: DriftTarget | null;
  model?: string | null;
  /** 重要度の件数（design g-mwmnvx3x 判断4）。undefined＝未申告 */
  severity?: VerifierSeverityCounts;
  /** 前回の指摘の判定（持ち越した角度のみ） */
  prior?: { valid: number; invalid: number; unresolved: number };
}

export type VerifierSeverityCounts = {
  must_fix: number;
  should_fix: number;
  nit: number;
  pre_existing: number;
};

/** lens ごとの severity 内訳（未申告は counts: null） */
export function collectSeverity(results: VerifierResult[]): VerifierSeverityEntry[] {
  return results.map((r) => ({ lens: r.lens, counts: r.severity ?? null }));
}

/** 延べ件数（lens をまたいで同じ指摘を重複計上しうる） */
export function sumSeverity(entries: VerifierSeverityEntry[]): VerifierSeverityCounts {
  const sum: VerifierSeverityCounts = { must_fix: 0, should_fix: 0, nit: 0, pre_existing: 0 };
  /* ゼロの数値は parseSeverity と揃える（片方だけ増やさない） */
  for (const e of entries) {
    if (!e.counts) continue;
    sum.must_fix += e.counts.must_fix;
    sum.should_fix += e.counts.should_fix;
    sum.nit += e.counts.nit;
    sum.pre_existing += e.counts.pre_existing;
  }
  return sum;
}

/** status 1 行。未申告の lens を「0 件」と混ぜない（design g-mwmnvx3x 判断4） */
export function formatSeverity(entries: VerifierSeverityEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "";
  const sum = sumSeverity(entries);
  const missing = entries.filter((e) => !e.counts).map((e) => e.lens);
  const head = `must-fix ${sum.must_fix} / should-fix ${sum.should_fix} / nit ${sum.nit}`;
  return missing.length > 0 ? `${head}（${missing.join(",")}: 未申告）` : head;
}

/** verifier_set 入力の検証。通れば null、ダメならエラー文（tool がそのまま返す）。
 * self-graded 完了防止の機械ゲート。「今の diff の計画があり、その角度を全部含む」ことを見る
 * （design g-mwmqmg6b 判断3）。計画外の id は `siblings`（追い検証）だけ受け付ける。 */
export function checkVerifierResults(
  results: VerifierResult[] | null | undefined,
  opts?: { plan?: AnglePlan | null; diffHash?: string | null },
): string | null {
  if (!Array.isArray(results) || results.length === 0) {
    return "error: results が空です。graphhopper_verifier_set は verifier（graphhopper_verify）を実際に呼んだ後にしか記録できません（self-graded完了を防ぐための機械的ゲート）。";
  }
  const seen = new Set<string>();
  for (const r of results) {
    if (!r || typeof r !== "object") return "error: results の要素が不正です";
    if (!isValidAngleId(r.lens)) {
      return `error: 不正な lens（角度の id）です: ${String((r as { lens?: unknown }).lens)}`;
    }
    if (seen.has(r.lens)) {
      return `error: lens が重複しています: ${r.lens}`;
    }
    seen.add(r.lens);
    if (r.level !== "clean" && r.level !== "drift") {
      return `error: 不正な level です: ${String((r as { level?: unknown }).level)}`;
    }
    if (
      r.target !== undefined &&
      r.target !== null &&
      r.target !== "implementing" &&
      r.target !== "design" &&
      r.target !== "requirements"
    ) {
      return `error: 不正な target です: ${String(r.target)}`;
    }
    if (r.level === "drift" && !r.target) {
      return `error: drift には target が必要です (lens: ${r.lens})`;
    }
    if (
      r.model !== undefined &&
      r.model !== null &&
      (typeof r.model !== "string" || r.model.trim().length === 0)
    ) {
      return `error: 不正な model です (lens: ${r.lens})`;
    }
  }
  const plan = opts?.plan;
  if (!plan) {
    return "error: 今の diff の検証計画がありません。graphhopper_verify を呼んでから記録してください";
  }
  if (!opts?.diffHash || plan.diff_hash !== opts.diffHash) {
    return "error: 検証計画が今の diff と違います（検証後に編集された）。diag → diff_stash → graphhopper_verify をやり直してください";
  }
  const planned = new Set(plan.entries.map((e) => e.id));
  for (const id of planned) {
    if (!seen.has(id)) return `error: 計画した角度の結果がありません: ${id}（graphhopper_verify を呼び直してください）`;
  }
  for (const id of seen) {
    if (!planned.has(id) && id !== SIBLINGS_ID) return `error: 計画に無い角度です: ${id}`;
  }
  return null;
}

/** verifier fan-out 結果の集約ルール（純粋関数）。
 * 前提: checkVerifierResults で検証済み（非空・既知lens・重複なし・
 * drift に target 必須）。「confidence高 & severity high/critical のみ採用」
 * というメインの裁量だった基準をコード化したもの:
 * - 1つでも drift → 全体 drift。target は `implementing` を優先
 *   （即時巻き戻し可能な唯一の行き先）、無ければ先頭の drift target。
 * - 全 clean → clean (target null)。 */
export function aggregateVerdicts(results: VerifierResult[]): {
  level: VerdictLevel;
  target: DriftTarget | null;
} {
  const drifts = results.filter((r) => r.level === "drift");
  if (drifts.length === 0) return { level: "clean", target: null };
  const impl = drifts.find((r) => r.target === "implementing");
  return {
    level: "drift",
    target: (impl ?? drifts[0])?.target ?? null,
  };
}
