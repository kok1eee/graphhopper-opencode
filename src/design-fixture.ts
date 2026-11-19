/**
 * テスト専用 fixture: 決定記録の検査（3 見出しが空でない）を通る doc を書く。
 * 本番コードからは import しない。
 *
 * 目的: 進捗ゲートなど「決定記録の中身以外」を見るテストが、
 * 検査で落ちないように前提を満たす。design の内容そのものを検証するテストは
 * これを使わず、意図的に壊した doc を書くこと。
 */
import { writeFileSync } from "node:fs";
import { getActive, planPath } from "./state";

export type CompliantDesignOpts = {
  title?: string;
  /** 「実装タスク列」節に置く行（検査も進捗ゲートも見ない。置いても seed されないことの確認用） */
  tasks?: string[];
};

/** 規約を満たす design doc の文字列 */
export function compliantDesignDoc(opts: CompliantDesignOpts = {}): string {
  const title = opts.title ?? "t";
  const tasks = opts.tasks ?? ["- [ ] T1（判断1）: （タスク）"];
  return [
    `# 決定記録: ${title}`,
    "",
    "## 決めたこと",
    "",
    "- テスト用の合意（検査が見るのは見出しと空でないことだけ）",
    "",
    "## やらないこと",
    "",
    "- 本番の内容（テスト対象外）",
    "",
    "## 完了の確かめ方",
    "",
    "- テストが通ること",
    "",
    "## 実装タスク列",
    "",
    ...tasks,
    "",
  ].join("\n");
}

/** active goal の決定記録を、検査を通る内容で上書きする */
export function fillCompliantDesign(root: string, opts: CompliantDesignOpts = {}): void {
  const active = getActive(root);
  if (!active) throw new Error("fillCompliantDesign: active goal が無い");
  writeFileSync(planPath(root, active.goal.id), compliantDesignDoc(opts), "utf8");
}
