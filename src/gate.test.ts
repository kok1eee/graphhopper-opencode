/** usability ゲートの純関数テスト（design g-mwfltxyt）。 */
import { describe, expect, test } from "bun:test";
import {
  isPolicyDocPath,
  policyDocsChanged,
  usabilityGateRefusal,
} from "./gate";

describe("isPolicyDocPath", () => {
  test("AI が読んで従う文書だけを対象にする", () => {
    expect(isPolicyDocPath("AGENTS.md")).toBe(true);
    expect(isPolicyDocPath("sub/AGENTS.md")).toBe(true);
    expect(isPolicyDocPath("skills/graphhopper/SKILL.md")).toBe(true);
    expect(isPolicyDocPath("skills/x/refs/y.md")).toBe(true);
    expect(isPolicyDocPath("src/agents.ts")).toBe(true);
  });
  test("生成物・docs・plan は対象外", () => {
    expect(isPolicyDocPath(".opencode/agents/graphhopper-critic.md")).toBe(false);
    expect(isPolicyDocPath("docs/x.md")).toBe(false);
    expect(isPolicyDocPath(".graphhopper/plans/g-x.md")).toBe(false);
    expect(isPolicyDocPath("README.md")).toBe(false);
  });
});

describe("policyDocsChanged", () => {
  test("対象文書だけを抽出し、goal 開始前の dirty は除く", () => {
    const files = [
      "skills/a/SKILL.md",
      "src/agents.ts",
      "src/gate.ts",
      "docs/x.md",
      "skills/old.md",
    ];
    expect(policyDocsChanged(files, ["skills/old.md"])).toEqual([
      "skills/a/SKILL.md",
      "src/agents.ts",
    ]);
  });
  test("正規化して重複を除く", () => {
    expect(policyDocsChanged(["./AGENTS.md", "AGENTS.md"], null)).toEqual([
      "AGENTS.md",
    ]);
  });
});

describe("usabilityGateRefusal", () => {
  const review = (over: Record<string, unknown> = {}) => ({
    level: "clean" as const,
    reason: "ok",
    files: ["AGENTS.md"],
    doc_hash: "abc",
    ...over,
  });

  test("対象文書が無ければ常に通す", () => {
    expect(usabilityGateRefusal(null, [], null)).toBeNull();
  });
  test("記録が無ければ拒否", () => {
    expect(usabilityGateRefusal(null, ["AGENTS.md"], "abc")).toContain(
      "ルール文書が変更されています",
    );
  });
  test("drift は拒否", () => {
    expect(
      usabilityGateRefusal(review({ level: "drift", reason: "矛盾" }), ["AGENTS.md"], "abc"),
    ).toContain("drift");
  });
  test("レビュー後に内容が変わったら拒否", () => {
    expect(usabilityGateRefusal(review(), ["AGENTS.md"], "different")).toContain(
      "後にルール文書が変わっています",
    );
  });
  test("レビュー対象に無い文書が変わったら拒否", () => {
    expect(
      usabilityGateRefusal(review({ files: ["AGENTS.md"] }), ["AGENTS.md", "src/agents.ts"], "abc"),
    ).toContain("対象に含まれない文書");
  });
  test("doc_hash が無い記録は拒否", () => {
    expect(
      usabilityGateRefusal(review({ doc_hash: null }), ["AGENTS.md"], "abc"),
    ).toContain("指紋が記録されていません");
  });
  test("clean / skipped で hash 一致なら通す", () => {
    expect(usabilityGateRefusal(review(), ["AGENTS.md"], "abc")).toBeNull();
    expect(
      usabilityGateRefusal(review({ level: "skipped" }), ["AGENTS.md"], "abc"),
    ).toBeNull();
  });
});
