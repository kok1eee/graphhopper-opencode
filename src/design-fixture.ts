/**
 * テスト専用 fixture: design.md の内容規約（checkDesignContent）を満たす doc を書く。
 * 本番コードからは import しない。
 *
 * 目的: consult gate / critic gate / 進捗ゲートなど「design の中身以外」を見るテストが、
 * 内容規約で落ちないように前提を満たす。design の内容そのものを検証するテストは
 * これを使わず、意図的に壊した doc を書くこと。
 */
import { writeFileSync } from "node:fs";
import { getActive, planPath } from "./state";

export type CompliantDesignOpts = {
  title?: string;
  /** §4 のタスク行（既定は判断1に対応する2本） */
  tasks?: string[];
};

/** 規約を満たす design doc の文字列 */
export function compliantDesignDoc(opts: CompliantDesignOpts = {}): string {
  const title = opts.title ?? "t";
  const tasks = opts.tasks ?? ["- [ ] T1（判断1）: （タスク）"];
  return [
    `# design: ${title}`,
    "",
    "## 1. goal理解",
    "",
    "テスト用の goal。",
    "",
    "## 2. 現状",
    "",
    "- src/gate.ts:358 が入口。",
    "- src/state.ts:738 がテンプレ。",
    "",
    "## 3. 設計判断",
    "",
    "1. **テスト用の判断**",
    "   - 理由: テストが他のゲートだけを見るため",
    "   - 代替案: 各テストで doc を書く。採らない理由: 重複する",
    "   - 反証条件: この fixture で content gate が落ちるなら壊れている",
    "",
    "## 4. 実装タスク列",
    "",
    ...tasks,
    "",
    "## 5. 触らないもの（スコープ外）",
    "",
    "- 本番の design 内容（テスト対象外）",
    "",
  ].join("\n");
}

/** active goal の design.md を規約準拠の内容で上書きする */
export function fillCompliantDesign(root: string, opts: CompliantDesignOpts = {}): void {
  const active = getActive(root);
  if (!active) throw new Error("fillCompliantDesign: active goal が無い");
  writeFileSync(planPath(root, active.goal.id), compliantDesignDoc(opts), "utf8");
}
