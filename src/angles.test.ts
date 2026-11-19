/**
 * 角度の一覧・枠・計画の組み立て（design g-mwmqmg6b 判断1・2・4）。
 */
import { describe, expect, test } from "bun:test";
import {
  ANGLES,
  AGREEMENT_ID,
  SIBLINGS_ID,
  angleSlots,
  applyAdds,
  applyDefaults,
  applyPicks,
  buildSelectorPrompt,
  carryOver,
  firstRoundEntries,
  initialPlan,
  needsFollowup,
  parseSelection,
  remainingSlots,
} from "./angles";

describe("枠の数", () => {
  test("easy は 1、それ以外は変更の大きさで polish 4・advisor と未判定 2", () => {
    expect(angleSlots({ route: "polish", difficulty: "easy" })).toBe(1);
    expect(angleSlots({ route: "advisor", difficulty: "easy" })).toBe(1);
    expect(angleSlots({ route: "polish", difficulty: "normal" })).toBe(4);
    expect(angleSlots({ route: "advisor", difficulty: "hard" })).toBe(2);
    expect(angleSlots({ route: "polish", difficulty: "hard" })).toBe(4);
    expect(angleSlots({ route: "advisor", difficulty: "normal" })).toBe(2);
    expect(angleSlots({ route: "polish", difficulty: null })).toBe(4);
    expect(angleSlots({ route: null, difficulty: null })).toBe(2);
  });
});

describe("一覧", () => {
  test("8 件のうち予約 id を含まない（agreement・siblings は別枠）", () => {
    expect(ANGLES.map((a) => a.id)).toEqual([
      "wiring",
      "test-efficacy",
      "premise",
      "frequency",
      "cleanup",
      "report-evidence",
      "behavior",
    ]);
    expect(ANGLES.some((a) => a.id === AGREEMENT_ID || a.id === SIBLINGS_ID)).toBe(false);
  });

  test("test-efficacy の文面に「実行していない」の指示がある", () => {
    const t = ANGLES.find((a) => a.id === "test-efficacy");
    expect(t?.doubt).toContain("実行していない");
  });

  test("全ての角度が見る範囲を持つ", () => {
    for (const a of ANGLES) expect(a.scope.length).toBeGreaterThan(0);
  });
});

describe("選ぶ役の出力の読み取り", () => {
  test("一覧の id を選べる。範囲は上書きできる", () => {
    const r = parseSelection({ angles: [{ id: "wiring", scope: "src/a.ts" }, { id: "cleanup" }] }, 4);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.picks.map((p) => [p.id, p.source])).toEqual([
        ["wiring", "list"],
        ["cleanup", "list"],
      ]);
      expect(r.picks[0]?.scope).toBe("src/a.ts");
    }
  });

  test("新しい角度は title と doubt が要る。無ければ捨てる", () => {
    const r = parseSelection(
      {
        angles: [
          { id: "idempotency", title: "冪等性", doubt: "二重実行で壊れないか" },
          { id: "no-text" },
        ],
      },
      4,
    );
    expect(r.ok && r.picks.map((p) => [p.id, p.source])).toEqual([["idempotency", "created"]]);
  });

  test("予約 id・重複・不正 id は除く。枠で切る", () => {
    const r = parseSelection(
      {
        angles: [
          { id: "agreement" },
          { id: "siblings" },
          { id: "wiring" },
          { id: "wiring" },
          { id: "Bad Id" },
          { id: "cleanup" },
          { id: "behavior" },
        ],
      },
      2,
    );
    expect(r.ok && r.picks.map((p) => p.id)).toEqual(["wiring", "cleanup"]);
  });

  test("0 個・配列が無い・読めない出力は失敗", () => {
    expect(parseSelection({ angles: [] }, 2).ok).toBe(false);
    expect(parseSelection({ angles: [{ id: "agreement" }] }, 2).ok).toBe(false);
    expect(parseSelection({}, 2).ok).toBe(false);
    expect(parseSelection(null, 2).ok).toBe(false);
  });
});

describe("計画の組み立て", () => {
  const prevPlan = (ids: [string, "list" | "main_add" | "followup"][]) =>
    initialPlan("h0", []).entries.length === 1
      ? {
          diff_hash: "h0",
          entries: [
            ...initialPlan("h0", []).entries,
            ...ids.map(([id, source]) => ({ id, title: id, doubt: "d", scope: "s", source, carried: false })),
          ],
        }
      : null;

  test("持ち越しは枠を超えても入り、枠を使う。選ぶ役は残りだけ", () => {
    const prev = prevPlan([["wiring", "list"], ["cleanup", "list"], ["premise", "list"]])!;
    const carried = carryOver(prev, [
      { lens: "wiring", level: "drift" },
      { lens: "cleanup", level: "drift" },
      { lens: "premise", level: "drift" },
    ]);
    const plan = initialPlan("h1", carried);
    expect(remainingSlots(plan, 2)).toBe(0);
    const picked = applyPicks(plan, [{ id: "behavior", source: "list", title: "t", doubt: "d", scope: "s" }], 2);
    expect(picked.entries.map((e) => e.id)).toEqual(["agreement", "wiring", "cleanup", "premise"]);
  });

  test("持ち越した siblings は枠に数え、持ち越したメイン追加は数えない", () => {
    const prev = prevPlan([["x-add", "main_add"], ["siblings", "followup"]])!;
    const carried = carryOver(prev, [
      { lens: "x-add", level: "drift" },
      { lens: "siblings", level: "drift" },
    ]);
    expect(carried.map((e) => [e.id, e.carried])).toEqual([
      ["x-add", true],
      ["siblings", true],
    ]);
    const plan = initialPlan("h1", carried);
    expect(remainingSlots(plan, 4)).toBe(3);
    expect(carried.find((e) => e.id === "x-add")?.source).toBe("main_add");
  });

  test("agreement は持ち越しに入らない（常に入る）。clean の角度は持ち越さない", () => {
    const prev = prevPlan([["wiring", "list"]])!;
    const carried = carryOver(prev, [
      { lens: "agreement", level: "drift" },
      { lens: "wiring", level: "clean" },
    ]);
    expect(carried).toEqual([]);
  });

  test("選ぶ役が枠 0 の計画には何も足さない。既定は残りの枠だけ", () => {
    const plan = initialPlan("h", []);
    const d = applyDefaults(plan, 2);
    expect(d.entries.map((e) => [e.id, e.source])).toEqual([
      ["agreement", "list"],
      ["wiring", "default"],
      ["test-efficacy", "default"],
    ]);
    expect(applyDefaults(d, 2).entries).toHaveLength(3);
  });

  test("計画は同じ diff の間は減らない（足すだけ）", () => {
    const plan = initialPlan("h", []);
    const a = applyPicks(plan, [{ id: "wiring", source: "list", title: "t", doubt: "d", scope: "s" }], 2);
    const b = applyPicks(a, [], 2);
    expect(b.entries.map((e) => e.id)).toEqual(["agreement", "wiring"]);
  });
});

describe("メインの add", () => {
  const base = initialPlan("h", []);
  const add = (...ids: string[]) => ids.map((id) => ({ id, title: id, doubt: "d" }));

  test("枠の外で 2 個まで。3 個目はエラーで 1 つも足さない", () => {
    const r1 = applyAdds(base, add("a1", "a2"));
    expect(r1.ok && r1.added).toEqual(["a1", "a2"]);
    const r2 = applyAdds(base, add("a1", "a2", "a3"));
    expect(r2.ok).toBe(false);
    if (r1.ok) {
      expect(applyAdds(r1.plan, add("a3")).ok).toBe(false);
      expect(remainingSlots(r1.plan, 2)).toBe(2);
    }
  });

  test("あとからでも足せる", () => {
    const r1 = applyAdds(base, add("a1"));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(applyAdds(r1.plan, add("a2")).ok).toBe(true);
  });

  test("予約 id は計画に入っていても常にエラー。計画にある id は無視して数えない", () => {
    expect(applyAdds(base, add("agreement")).ok).toBe(false);
    expect(applyAdds(base, add("siblings")).ok).toBe(false);
    const r = applyAdds(base, add("a1", "a2"));
    if (r.ok) {
      const dup = applyAdds(r.plan, add("a1"));
      expect(dup.ok && dup.added).toEqual([]);
    }
  });

  test("持ち越したメイン追加は add の数に入れない", () => {
    const prev = {
      diff_hash: "h0",
      entries: [
        ...initialPlan("h0", []).entries,
        { id: "old", title: "t", doubt: "d", scope: "s", source: "main_add" as const, carried: false },
      ],
    };
    const plan = initialPlan("h1", carryOver(prev, [{ lens: "old", level: "drift" }]));
    expect(applyAdds(plan, add("n1", "n2")).ok).toBe(true);
  });

  test("一覧の id は文面を省略できる。新しい id は title と doubt が要る", () => {
    expect(applyAdds(base, [{ id: "wiring" }]).ok).toBe(true);
    expect(applyAdds(base, [{ id: "brand-new" }]).ok).toBe(false);
  });
});

describe("持ち越し（判定が出なかった角度）", () => {
  test("持ち越したまま判定が出なかった角度は、次の diff でも持ち越す。持ち越しでない未判定は落とす", () => {
    const e = (id: string, carried: boolean) => ({ id, title: id, doubt: "d", scope: "s", source: "list" as const, carried });
    const prev = { diff_hash: "h0", entries: [e("agreement", false), e("wiring", true), e("cleanup", false), e("siblings", true)] };
    const out = carryOver(prev, [{ lens: "agreement", level: "clean" }]);
    expect(out.map((x) => x.id)).toEqual(["wiring", "siblings"]);
    expect(out.every((x) => x.carried)).toBe(true);
  });
});

describe("追い検証", () => {
  test("1 巡目に drift があれば走る。clean なら走らない", () => {
    const plan = initialPlan("h", []);
    expect(needsFollowup(plan, [{ lens: "agreement", level: "clean" }])).toBe(false);
    expect(needsFollowup(plan, [{ lens: "agreement", level: "drift" }])).toBe(true);
  });

  test("1 巡目の結果に siblings が混ざっても、それだけでは追い検証は走らない", () => {
    const plan = initialPlan("h", []);
    expect(needsFollowup(plan, [{ lens: "siblings", level: "drift" }])).toBe(false);
  });

  test("持ち越した siblings があれば 1 巡目が全部 clean でも走る。1 巡目には入らない", () => {
    const prev = {
      diff_hash: "h0",
      entries: [
        ...initialPlan("h0", []).entries,
        { id: "siblings", title: "t", doubt: "d", scope: "s", source: "followup" as const, carried: false },
      ],
    };
    const plan = initialPlan("h1", carryOver(prev, [{ lens: "siblings", level: "drift" }]));
    expect(needsFollowup(plan, [{ lens: "agreement", level: "clean" }])).toBe(true);
    expect(firstRoundEntries(plan).map((e) => e.id)).toEqual(["agreement"]);
  });
});

describe("選ぶ役の prompt", () => {
  test("path・一覧・枠・除外 id・出力形式が入る", () => {
    const p = buildSelectorPrompt({ designPath: "/d.md", diffPath: "/diff.txt", slots: 2, taken: ["wiring"] });
    expect(p).toContain("/d.md");
    expect(p).toContain("/diff.txt");
    expect(p).toContain("2 個まで");
    expect(p).toContain("test-efficacy");
    expect(p).toContain("wiring");
    expect(p).toContain("```json");
  });
});
