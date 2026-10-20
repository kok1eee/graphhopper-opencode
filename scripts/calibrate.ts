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
