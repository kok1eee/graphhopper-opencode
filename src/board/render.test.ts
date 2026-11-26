import { describe, expect, test } from "bun:test";
import { ago, cells, formatDetail, formatList, formatVerify, truncCells, wrap } from "./render";
import type { BoardGoal } from "./model";

const NOW = Date.parse("2026-11-26T06:00:00Z");

const goal: BoardGoal = {
  repo: "/Users/x/amu-repos/amu-tool",
  repoName: "amu-tool",
  id: "g-mwx1zmvx",
  title: "請求集計の追加画面のレビュー、ポイント(010)フッタの試算・突合、差分だけ書き換える実行の設計と実装",
  status: "paused",
  phase: "polish",
  createdAt: "2026-11-26T04:29:30.909Z",
  doneAt: null,
  lastEventAt: "2026-11-26T05:44:20.323Z",
  lastEventType: "angles_selected",
  stop: { reason: "stalls", at: "2026-11-26T05:00:00.000Z" },
  verify: {
    at: "2026-11-26T05:46:04.993Z",
    angles: [
      { lens: "agreement", level: "drift", summary: "冪等性が SQL を通っていない", body: "- [must] 二重実行で二重計上" },
      { lens: "premise", level: "clean", summary: "" },
    ],
    missing: [{ lens: "wiring", reason: "判定できない" }],
    currentDiff: true,
  },
  error: null,
};

describe("board/render: 時刻と幅", () => {
  test("ago は日本語の相対時刻", () => {
    expect(ago(null, NOW)).toBe("-");
    expect(ago("2026-11-26T05:59:40Z", NOW)).toBe("いま");
    expect(ago("2026-11-26T05:20:00Z", NOW)).toBe("40分前");
    expect(ago("2026-11-25T20:00:00Z", NOW)).toBe("10時間前");
    expect(ago("2026-11-21T06:00:00Z", NOW)).toBe("5日前");
  });

  test("truncCells は全角 2 桁で数え、切ったら … を付ける", () => {
    expect(truncCells("abcdef", 4)).toBe("abc…");
    expect(truncCells("あいうえ", 4)).toBe("あ…");
    expect(truncCells("abc", 10)).toBe("abc");
    expect(cells("あa")).toBe(3);
  });
});

describe("board/render: 一覧", () => {
  test("行の幅が端末幅を超えず、選択行に > が付く", () => {
    const lines = formatList([goal, { ...goal, id: "g-2", title: "短い", status: "active", phase: null }], {
      width: 80,
      now: NOW,
      selected: 1,
      showDone: false,
      header: "graphhopper board",
    });
    expect(lines[0]).toBe("graphhopper board");
    const body = lines.slice(2);
    for (const l of body) expect(cells(l)).toBeLessThanOrEqual(80);
    expect(body[1]!.startsWith(">")).toBe(true);
    expect(body[0]!.startsWith(" ")).toBe(true);
    expect(body.join("\n")).toContain("amu-tool");
  });

  test("goal が無いときは案内を出す", () => {
    const lines = formatList([], { width: 80, now: NOW, selected: 0, showDone: false });
    expect(lines.join("\n")).toContain("該当する goal がありません");
  });

  test("古い paused は「停止(古)」と表示する", () => {
    const lines = formatList([{ ...goal, lastEventAt: "2026-11-01T00:00:00Z" }], {
      width: 100,
      now: NOW,
      selected: 0,
      showDone: false,
    });
    expect(lines.join("\n")).toContain("停止(古)");
  });
});

describe("board/render: 詳細", () => {
  test("検証結果は要修正の観点を先に数え、判定できなかった観点も出す", () => {
    const out = formatVerify(goal.verify, NOW).join("\n");
    expect(out).toContain("要修正 1 観点");
    expect(out).toContain("✗ agreement: 冪等性が SQL を通っていない");
    expect(out).toContain("✓ premise");
    expect(out).toContain("? wiring: 判定できず（判定できない）");
    // 要修正の観点は本文（指摘の中身）も出す
    expect(out).toContain("[must] 二重実行で二重計上");
  });

  test("今の差分と違う判定なら注意書きを出す", () => {
    const out = formatVerify({ ...goal.verify!, currentDiff: false }, NOW).join("\n");
    expect(out).toContain("今の差分とは別の差分");
    const same = formatVerify({ ...goal.verify!, currentDiff: true }, NOW).join("\n");
    expect(same).not.toContain("別の差分");
  });

  test("詳細に題・止まった理由・検証・履歴・決定記録が入る", () => {
    const events = [
      {"ts":"2026-11-26T05:41:09.909Z","type":"phase","from":"implementing","to":"polish","goal":"g-mwx1zmvx"},
      {"ts":"2026-11-26T05:43:21.904Z","type":"router_check","diff_lines":1697,"route":"polish","goal":"g-mwx1zmvx"},
    ];
    const lines = formatDetail(goal, "## 決めたこと\n- 差分だけ書き換える", events, {
      width: 80,
      now: NOW,

    });
    const text = lines.join("\n");
    expect(text).toContain("amu-tool / g-mwx1zmvx / 停止 / polish");
    expect(text).toContain("止まった理由: stalls");
    expect(text).toContain("implementing→polish");
    expect(text).toContain("diff=1697");
    expect(text).toContain("差分だけ書き換える");
    for (const l of lines) expect(cells(l)).toBeLessThanOrEqual(80);
  });

  test("決定記録が無くても落ちない", () => {
    const text = formatDetail(goal, null, [], { width: 60, now: NOW }).join("\n");
    expect(text).toContain("（決定記録なし）");
    expect(text).toContain("（履歴なし）");
  });

  test("wrap は長い行を折る（切らない）", () => {
    const out = wrap("あ".repeat(10), 6);
    expect(out).toEqual(["あああ", "あああ", "あああ", "あ"]);
    expect(wrap("abあc", 3)).toEqual(["ab", "あc"]);
    expect(wrap("x\n\ny", 3)).toEqual(["x", "", "y"]);
  });
});
