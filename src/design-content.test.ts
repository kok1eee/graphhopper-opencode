/**
 * design.md の内容規約（checkDesignContent）の単体テスト。
 * 構造（節の有無）は checkDesignDoc の領分で、ここは「判断の4点セット」「§5 非空」
 * 「§2 の file:line 証拠」「§4 タスクの判断紐付け・網羅」だけを見る。
 */
import { describe, expect, test } from "bun:test";
import { checkDesignContent, DESIGN_RULES } from "./gate";
import { compliantDesignDoc } from "./design-fixture";

/** 規約を満たす最小の design doc。各テストはこれを1箇所だけ壊す */
function compliant(over: Partial<Record<"s2" | "s3" | "s4" | "s5", string>> = {}): string {
  return [
    "# design: t (g-x)",
    "",
    "## 1. goal理解",
    "",
    "何か。",
    "",
    "## 2. 現状",
    "",
    over.s2 ?? "- src/gate.ts:358 が入口。\n- src/state.ts:738 がテンプレ。",
    "",
    "## 3. 設計判断",
    "",
    over.s3 ??
      [
        "1. **分離する**",
        "   - 理由: 既存の意味を保つため",
        "   - 代替案: 統合する。採らない理由: 既存テストが壊れる",
        "   - 反証条件: 既存テストが修正なしで通らなければ失敗",
      ].join("\n"),
    "",
    "## 4. 実装タスク列",
    "",
    over.s4 ?? "- [ ] T1（判断1）: gate.ts に追加",
    "",
    "## 5. 触らないもの（スコープ外）",
    "",
    over.s5 ?? "- light/advised の thin 経路は変えない",
    "",
  ].join("\n");
}

describe("checkDesignContent: 適合", () => {
  test("規約を満たす doc は違反なし", () => {
    expect(checkDesignContent(compliant())).toEqual([]);
  });

  test("同義語でも通る（他案/なぜ/失敗条件）", () => {
    const raw = compliant({
      s3: [
        "1. **分離する**",
        "   - なぜ: 既存の意味を保つため",
        "   - 他案: 統合する",
        "   - 失敗条件: 既存テストが壊れる",
      ].join("\n"),
    });
    expect(checkDesignContent(raw)).toEqual([]);
  });

  test("§5 は「なし（理由: …）」なら通る（正直な表明は許す）", () => {
    expect(checkDesignContent(compliant({ s5: "- なし（理由: 今回の変更は新規ファイルのみ）" }))).toEqual([]);
  });
});

describe("checkDesignContent: 判断の4点セット", () => {
  test("理由が無いと判断番号つきで落ちる", () => {
    const raw = compliant({
      s3: [
        "1. **分離する**",
        "   - 代替案: 統合する",
        "   - 反証条件: 既存テストが壊れる",
      ].join("\n"),
    });
    const p = checkDesignContent(raw);
    expect(p.some((m) => m.includes("設計判断1") && m.includes("理由"))).toBe(true);
  });

  test("代替案が無いと落ちる", () => {
    const raw = compliant({
      s3: ["1. **分離する**", "   - 理由: 保つため", "   - 反証条件: テストが壊れる"].join("\n"),
    });
    expect(checkDesignContent(raw).some((m) => m.includes("設計判断1") && m.includes("代替案"))).toBe(true);
  });

  test("反証条件が無いと落ちる", () => {
    const raw = compliant({
      s3: ["1. **分離する**", "   - 理由: 保つため", "   - 代替案: 統合する"].join("\n"),
    });
    expect(checkDesignContent(raw).some((m) => m.includes("設計判断1") && m.includes("反証条件"))).toBe(true);
  });

  test("ラベルだけのプレースホルダは実質なしとして落ちる", () => {
    const raw = compliant({
      s3: [
        "1. **（決定を1行で）**",
        "   - 理由: （なぜそれを選ぶか）",
        "   - 代替案: （他案。採らない理由）",
        "   - 反証条件: （この観測が出たらこの決定は間違い）",
      ].join("\n"),
    });
    const p = checkDesignContent(raw);
    expect(p.some((m) => m.includes("設計判断1") && m.includes("代替案"))).toBe(true);
    expect(p.some((m) => m.includes("設計判断1") && m.includes("反証条件"))).toBe(true);
    // 代替案ラベルの中に「理由」の語があっても、ラベルは内容ではないので理由も落ちる
    expect(p.some((m) => m.includes("設計判断1") && m.includes("理由"))).toBe(true);
  });

  test("§3 に番号付き判断が無いと落ちる", () => {
    const raw = compliant({ s3: "（採用・棄却の判断と理由）" });
    expect(checkDesignContent(raw).some((m) => m.includes("§3"))).toBe(true);
  });

  test("判断ブロックは次の番号で切れる（2つ目の欠落だけを指す）", () => {
    const raw = compliant({
      s3: [
        "1. **A**",
        "   - 理由: 理由A",
        "   - 代替案: 代替A",
        "   - 反証条件: 反証A",
        "2. **B**",
        "   - 理由: 理由B",
      ].join("\n"),
    });
    const p = checkDesignContent(raw);
    expect(p.some((m) => m.includes("設計判断2") && m.includes("代替案"))).toBe(true);
    expect(p.some((m) => m.includes("設計判断1"))).toBe(false);
  });
});

describe("checkDesignContent: §2 の証拠アンカー", () => {
  test("file:line が1箇所だけなら落ちる", () => {
    const p = checkDesignContent(compliant({ s2: "- src/gate.ts:358 だけ。" }));
    expect(p.some((m) => m.includes("§2") && m.includes("file:line"))).toBe(true);
  });

  test("同一ファイルの複数行は別カウント", () => {
    expect(checkDesignContent(compliant({ s2: "- src/gate.ts:358\n- src/gate.ts:457" }))).toEqual([]);
  });
});

describe("checkDesignContent: §4 タスクの紐付けと網羅", () => {
  test("判断番号の無いタスク行は落ちる", () => {
    const p = checkDesignContent(compliant({ s4: "- [ ] 実装する" }));
    expect(p.some((m) => m.includes("タスク行に判断番号が無い"))).toBe(true);
  });

  test("判断2に対応するタスクが無ければ落ちる", () => {
    const raw = compliant({
      s3: [
        "1. **A**",
        "   - 理由: 理由A",
        "   - 代替案: 代替A",
        "   - 反証条件: 反証A",
        "2. **B**",
        "   - 理由: 理由B",
        "   - 代替案: 代替B",
        "   - 反証条件: 反証B",
      ].join("\n"),
    });
    const p = checkDesignContent(raw);
    expect(p.some((m) => m.includes("設計判断2") && m.includes("対応するタスクが無い"))).toBe(true);
  });

  test("免除マーカー付きの判断はタスク不要", () => {
    const raw = compliant({
      s3: [
        "1. **A**",
        "   - 理由: 理由A",
        "   - 代替案: 代替A",
        "   - 反証条件: 反証A",
        "2. **今回入れない（タスク不要）**",
        "   - 理由: 理由B",
        "   - 代替案: 代替B",
        "   - 反証条件: 反証B",
      ].join("\n"),
    });
    expect(checkDesignContent(raw)).toEqual([]);
  });

  test("複数参照（判断1, 2）を解釈する", () => {
    const raw = compliant({
      s3: [
        "1. **A**",
        "   - 理由: 理由A",
        "   - 代替案: 代替A",
        "   - 反証条件: 反証A",
        "2. **B**",
        "   - 理由: 理由B",
        "   - 代替案: 代替B",
        "   - 反証条件: 反証B",
      ].join("\n"),
      s4: "- [ ] T1（判断1, 2）: まとめて実装",
    });
    expect(checkDesignContent(raw)).toEqual([]);
  });

  test("§3 の箇条書きをタスク行と誤認しない（走査は §4 限定）", () => {
    // §3 に `- 代替案:` があるが §4 のタスクは判断番号つきで適合。
    // 全文走査だと「判断番号の無いタスク行」が誤検出される。
    expect(checkDesignContent(compliant())).toEqual([]);
  });
});

describe("checkDesignContent: CRLF と短い §5 行（verifier behavior 指摘の回帰）", () => {
  test("CRLF の doc でも見出しを認識して適合する", () => {
    expect(checkDesignContent(compliant().replace(/\n/g, "\r\n"))).toEqual([]);
  });

  test("短い理由の「なし（理由: …）」でも §5 は非空", () => {
    expect(checkDesignContent(compliant({ s5: "- なし（理由: 新規のみ）" }))).toEqual([]);
  });

  test("ラベル付きの短い行（型定義: 変更なし）でも §5 は非空", () => {
    expect(checkDesignContent(compliant({ s5: "- 型定義: 変更なし" }))).toEqual([]);
  });

  test("テンプレの例示行（全角括弧だけ）は §2 の証拠に数えない", () => {
    const raw = compliant({ s2: "- （調査済み事実。`src/foo.ts:123` の形で最低2箇所、根拠を付ける）\n- src/gate.ts:358 のみ" });
    expect(checkDesignContent(raw).some((m) => m.includes("§2"))).toBe(true);
  });
});

describe("checkDesignContent: §5 触らないもの", () => {
  test("表ヘッダだけなら空と判定する", () => {
    const raw = compliant({ s5: "| 対象 | 採用 | 棄却 |\n|---|---|---|" });
    expect(checkDesignContent(raw).some((m) => m.includes("§5"))).toBe(true);
  });

  test("プレースホルダ1行だけなら空と判定する", () => {
    const p = checkDesignContent(compliant({ s5: "- （この goal で変えないもの。境界を具体的に）" }));
    expect(p.some((m) => m.includes("§5"))).toBe(true);
  });

  test("§5 節自体が無ければ落ちる", () => {
    const raw = compliant().replace("## 5. 触らないもの（スコープ外）", "## 5. その他");
    expect(checkDesignContent(raw).some((m) => m.includes("§5"))).toBe(true);
  });
});

describe("DESIGN_RULES: 単一源泉", () => {
  test("免除マーカーは全角/半角の括弧どちらでも効く", () => {
    expect(DESIGN_RULES.exempt.test("（タスク不要）")).toBe(true);
    expect(DESIGN_RULES.exempt.test("(タスク不要)")).toBe(true);
    expect(DESIGN_RULES.exempt.test("タスク不要")).toBe(false);
  });

  test("テスト fixture 自体が規約準拠である（不変条件を名指しで固定）", () => {
    expect(checkDesignContent(compliantDesignDoc())).toEqual([]);
  });
});
