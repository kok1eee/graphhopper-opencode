/** decisions.jsonl の decide と outcome を decision_id で結び、difficulty 別の結果を集計する */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const rows = readFileSync(join(root, ".graphhopper/decisions.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const decides = new Map(rows.filter((r) => r.kind === "decide" && r.id).map((r) => [r.id, r]));
const stats: Record<string, { n: number; fails: number; escalated: number; clean: number }> = {};
for (const o of rows.filter((r) => r.kind === "outcome" && r.decision_id)) {
  const d = decides.get(o.decision_id);
  const key = `${d?.difficulty ?? o.difficulty ?? "unknown"}`;
  const s = (stats[key] ??= { n: 0, fails: 0, escalated: 0, clean: 0 });
  s.n++;
  s.fails += o.outcome.fail_streak;
  if (o.outcome.escalated) s.escalated++;
  if (o.outcome.verifier === "clean") s.clean++;
}
console.table(stats);

const wf = rows.filter((r) => r.kind === "outcome" && r.outcome?.workflow);
if (wf.length) {
  console.log("workflow 利用 goal:", wf.length, "/ 挿入:", wf.flatMap((r) => r.outcome.inserted ?? []).join(",") || "なし");
}

/* ── shadow 比較（primary と別プロバイダの並走結果） ──
 * 突き合わせは decide 行の id ↔ shadow 行の decision_id。
 * 母数=shadow 行。一致率は両方成功の組だけで出す（失敗は別カウント） */
const shadows = rows.filter((r) => r.kind === "shadow" && r.decision_id);
if (shadows.length) {
  const med = (xs: number[]): string =>
    xs.length ? String(Math.round(xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)])) : "-";
  const summarize = (name: string, src: { confidence: number | null; latencyMs: number }[]) => {
    const conf = src.map((r) => r.confidence).filter((c): c is number => typeof c === "number");
    const high = conf.filter((c) => c >= 0.6).length;
    return {
      provider: name,
      n: src.length,
      confMedian: conf.length ? (conf.sort((a, b) => a - b)[Math.floor(conf.length / 2)]).toFixed(2) : "-",
      "conf>=0.6": conf.length ? `${high}/${conf.length}` : "-",
      latencyMedianMs: med(src.map((r) => r.latencyMs)),
    };
  };
  const shadowOk = shadows.filter((s) => !s.fallback);
  const primaryOk = shadows
    .map((s) => decides.get(s.decision_id))
    .filter((d): d is NonNullable<typeof d> => !!d && !d.fallback);
  const both = shadows.filter(
    (s) => !s.fallback && decides.get(s.decision_id) && !decides.get(s.decision_id)!.fallback,
  );
  const agree = both.filter((s) => {
    const d = decides.get(s.decision_id);
    return (d?.rawChoice ?? "") === (s.rawChoice ?? "");
  }).length;
  console.log("\nshadow 比較");
  console.table([
    summarize("primary", primaryOk.map((d) => ({ confidence: d.confidence, latencyMs: d.latencyMs }))),
    summarize("shadow", shadowOk.map((s) => ({ confidence: s.confidence, latencyMs: s.latencyMs }))),
  ]);
  console.log(
    `組=${shadows.length} / primary失敗=${shadows.filter((s) => decides.get(s.decision_id)?.fallback).length}` +
      ` / shadow失敗=${shadows.filter((s) => s.fallback).length}` +
      ` / rawChoice一致=${agree}/${both.length}` +
      (both.length ? ` (${Math.round((agree / both.length) * 100)}%)` : ""),
  );
}
