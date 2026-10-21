/**
 * T1: 実 d1 で chooseRecovery を直接呼ぶ（実機検証の段1）。
 * 実行: bun run scripts/verify-recovery.ts
 */
import { chooseRecovery } from "../src/decision";

const cases = [
  { id: "repro", reason: "スキーマ不正: test_file must be string, got number", task: "src/x.ts の関数が境界値で例外を投げる" },
  { id: "repro", reason: "timeout", task: "src/x.ts の関数が境界値で例外を投げる" },
  { id: "fix", reason: "実行失敗: child session error", task: "src/x.ts の関数が境界値で例外を投げる" },
];

for (const c of cases) {
  const t0 = Date.now();
  const choice = await chooseRecovery(c, fetch, { root: process.cwd() });
  console.log(`${c.id} / ${c.reason.slice(0, 40)} -> ${choice} (${Date.now() - t0}ms)`);
}
