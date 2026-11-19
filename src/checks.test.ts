/**
 * checks（diff トリガ付きチェック）の unit test。
 * 一覧の形式は skills/graphhopper/refs/checks.md の先頭に書いてある。
 */
import { describe, expect, test } from "bun:test";
import { MAX_CHECKS, checkEntries, matchChecks, parseChecks, scanDiff } from "./checks";
import { applyChecks, initialPlan, remainingSlots } from "./angles";

const MD = `# t

## 書き方

### tool-surface
- title: ツール面の残骸
- when-line: \`^[+-].*name: "graphhopper_\`
- doubt: 旧名が文書に残っていないか
- scope: skills/graphhopper/**
- why: route_set を消したとき

### state-compat
- when-path: src/state.ts
- when-line: \`^[+-].*\\{ type: "\`
- doubt: 旧データを読めるか
- scope: src/state.ts
`;

const DIFF = `diff --git a/src/state.ts b/src/state.ts
--- a/src/state.ts
+++ b/src/state.ts
@@ -1,2 +1,3 @@
+  | { type: "invoke"; goal: string }
-old
diff --git a/.opencode/plugins/graphhopper/tools-ops.ts b/.opencode/plugins/graphhopper/tools-ops.ts
--- a/.opencode/plugins/graphhopper/tools-ops.ts
+++ b/.opencode/plugins/graphhopper/tools-ops.ts
@@ name: "graphhopper_route"
+    name: "graphhopper_verify",
`;

describe("parseChecks", () => {
  test("見出しと項目を読む（backtick は外す）", () => {
    const checks = parseChecks(MD);
    expect(checks.map((c) => c.id)).toEqual(["tool-surface", "state-compat"]);
    expect(checks[0].title).toBe("ツール面の残骸");
    expect(checks[0].whenLine).toEqual(['^[+-].*name: "graphhopper_']);
    expect(checks[0].why).toContain("route_set");
    expect(checks[1].whenPath).toEqual(["src/state.ts"]);
  });

  test("id 不正・doubt 無し・発火条件なしは捨てる", () => {
    const md = [
      "### Bad_ID",
      "- when-line: x",
      "- doubt: d",
      "",
      "### no-doubt",
      "- when-line: x",
      "",
      "### no-trigger",
      "- doubt: d",
      "- scope: s",
    ].join("\n");
    expect(parseChecks(md)).toEqual([]);
  });
});

describe("scanDiff", () => {
  test("変更ファイルと変更行を取り、ヘッダ行は除く", () => {
    const scan = scanDiff(DIFF);
    expect(scan.paths).toEqual([
      "src/state.ts",
      ".opencode/plugins/graphhopper/tools-ops.ts",
    ]);
    expect(scan.lines.some((l) => l.startsWith('+  | { type: "invoke"'))).toBe(true);
    expect(scan.lines.some((l) => l.startsWith("+++"))).toBe(false);
    expect(scan.lines.some((l) => l.startsWith("---"))).toBe(false);
  });
});

/* 実際の退避 diff は jj の人間向け形式（`Modified regular file …` と `旧 新: 内容`）。
 * ここを取りこぼすと、チェックが全件沈黙する（g-mwn8aif6 の検証で発覚）。 */
const JJ_DIFF = `Modified regular file src/plugin-tools.test.ts:
    ...          json: async () => ({ answers: { difficulty: { choice, confidence } } }),
1662 1662:     });
1667     :     const started = Date.now();
    1670:     const calls = 0;
1676     :     expect(Date.now() - started).toBeLessThan(500);
Added regular file skills/graphhopper/refs/foo.md:
    1: # 追加
`;

describe("jj 形式の diff", () => {
  test("ファイルと変更行を取り、文脈行と省略行は無視する", () => {
    const scan = scanDiff(JJ_DIFF);
    expect(scan.paths).toEqual(["src/plugin-tools.test.ts", "skills/graphhopper/refs/foo.md"]);
    expect(scan.lines).toContain("-    const started = Date.now();");
    expect(scan.lines).toContain("+    const calls = 0;");
    expect(scan.lines.some((l) => l.includes("});"))).toBe(false);
    expect(scan.lines.some((l) => l.includes("..."))).toBe(false);
  });

  test("jj 形式でもトリガが発火する", () => {
    const checks = parseChecks(
      [
        "### timing-test",
        "- when-line: `^[+-].*Date\\.now\\(\\)`",
        "- doubt: 時間に依存していないか",
        "### docs-stale",
        "- when-path: skills/graphhopper/",
        "- doubt: 消した概念の残骸",
      ].join("\n"),
    );
    const hit = matchChecks(JJ_DIFF, checks).map((c) => c.id);
    expect(hit).toContain("timing-test");
    expect(hit).toContain("docs-stale");
  });

  test("rename は移動先の path を使う", () => {
    const scan = scanDiff("Renamed regular file src/a.ts => src/b.ts:\n    1: x\n");
    expect(scan.paths).toEqual(["src/b.ts"]);
  });
});

describe("matchChecks", () => {
  const checks = parseChecks(MD);

  test("行の条件だけで発火する", () => {
    const hit = matchChecks(DIFF, checks);
    expect(hit.map((c) => c.id)).toContain("tool-surface");
  });

  test("path と行の両方が要る項目は、片方だけでは発火しない", () => {
    const onlyLine = 'diff --git a/other.ts b/other.ts\n+  | { type: "x" }\n';
    expect(matchChecks(onlyLine, checks).map((c) => c.id)).not.toContain("state-compat");
    const onlyPath = "diff --git a/src/state.ts b/src/state.ts\n+何か\n";
    expect(matchChecks(onlyPath, checks).map((c) => c.id)).not.toContain("state-compat");
    expect(matchChecks(DIFF, checks).map((c) => c.id)).toContain("state-compat");
  });

  test("path が一致しても、別ファイルの行では発火しない", () => {
    const diff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "+何か",
      "diff --git a/src/other.ts b/src/other.ts",
      '+  | { type: "invoke" }',
    ].join("\n");
    expect(matchChecks(diff, checks).map((c) => c.id)).not.toContain("state-compat");
  });

  test("壊れた正規表現は例外にせず、発火もしない", () => {
    const broken = parseChecks("### bad-re\n- when-line: `[unclosed`\n- doubt: d\n");
    expect(() => matchChecks(DIFF, broken)).not.toThrow();
    expect(matchChecks(DIFF, broken)).toEqual([]);
  });

  test("上限までしか返さない", () => {
    const many = Array.from({ length: MAX_CHECKS + 2 }, (_, i) => ({
      id: `c${i}`,
      title: "",
      whenPath: [],
      whenLine: ["^\\+"],
      doubt: "d",
      scope: "s",
    }));
    expect(matchChecks(DIFF, many)).toHaveLength(MAX_CHECKS);
  });
});

describe("計画への入れ方", () => {
  test("source は check", () => {
    const e = checkEntries(parseChecks(MD));
    expect(e.every((x) => x.source === "check")).toBe(true);
    expect(e[0].doubt).toContain("旧名");
  });

  test("チェックは枠を消費せず、同じ id は重ねて足さない", () => {
    const plan = initialPlan("h", []);
    const entries = checkEntries(parseChecks(MD));
    const next = applyChecks(plan, entries);
    expect(next.entries).toHaveLength(1 + entries.length);
    expect(remainingSlots(next, 2)).toBe(2);
    expect(applyChecks(next, entries)).toBe(next);
  });
});
