import { describe, expect, test } from "bun:test";
import { checkDecisionRecord, recordSection, recordTemplate } from "./record";

const ok = [
  "# 決定記録: x (g-1)",
  "## 決めたこと",
  "- 入口を 2 つにする（ユーザー合意）",
  "## やらないこと",
  "- verify の仕組みは変えない",
  "## 完了の確かめ方",
  "- bun test が通る",
].join("\n");

describe("checkDecisionRecord", () => {
  test("3 見出しがそろい空でなければ適合", () => {
    expect(checkDecisionRecord(ok)).toEqual([]);
  });
  test("テンプレのままは拒否（3 節とも空扱い）", () => {
    expect(checkDecisionRecord(recordTemplate("g-1", "t"))).toHaveLength(3);
  });
  test("見出しが欠けると拒否", () => {
    const p = checkDecisionRecord(ok.replace("## やらないこと", "## 別の節"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("見出しが無い");
  });
  test("「なし」だけの節は拒否し、書き方を添える", () => {
    const p = checkDecisionRecord(ok.replace("- verify の仕組みは変えない", "- なし"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("何を確かめて");
  });
  test("読めない記録（null）は拒否", () => {
    expect(checkDecisionRecord(null)).toHaveLength(1);
  });
  test("CRLF でも見出しを拾う", () => {
    expect(checkDecisionRecord(ok.replace(/\n/g, "\r\n"))).toEqual([]);
  });
});

describe("recordSection", () => {
  test("次の ## までを返す", () => {
    expect(recordSection(ok, "決めたこと")).toEqual(["- 入口を 2 つにする（ユーザー合意）"]);
    expect(recordSection(ok, "無い節")).toBeNull();
  });
});

import { appendDesigningTurns, renderIntent } from "./intent";

describe("appendDesigningTurns", () => {
  const SINCE = 1_000;
  const m = (role: string, text: string, created: number | undefined) =>
    ({
      ...(role === "user"
        ? { type: "user", text }
        : { type: "assistant", content: [{ type: "text", text }] }),
      ...(created === undefined ? {} : { time: { created } }),
    }) as never;
  const base = [m("user", "やって", 100), m("assistant", "了解", 200)];
  const log = renderIntent(base, { goalId: "g" })!;

  test("開始時刻より後の発言だけを後ろに足し、開始時の部分は変えない", () => {
    const next = appendDesigningTurns(
      log,
      [...base, m("assistant", "質問A", 1_100), m("user", "答えB", 1_200)],
      { since: SINCE },
    )!;
    expect(next.startsWith(log.trimEnd())).toBe(true);
    const tail = next.slice(log.trimEnd().length);
    expect(tail).toContain("## designing 中の会話");
    expect(tail).toContain("assistant: 質問A");
    expect(tail).toContain("me: 答えB");
    expect(tail).not.toContain("やって");
    expect(tail).not.toContain("了解");
  });

  test("同じ会話で呼び直しても変わらない（null）", () => {
    const msgs = [...base, m("assistant", "質問A", 1_100), m("user", "答えB", 1_200)];
    const next = appendDesigningTurns(log, msgs, { since: SINCE })!;
    expect(appendDesigningTurns(next, msgs, { since: SINCE })).toBeNull();
  });

  test("designing に戻って進み直すと、後ろの節だけを作り直す（節は 1 つのまま）", () => {
    const first = [...base, m("assistant", "質問A", 1_100), m("user", "答えB", 1_200)];
    const next = appendDesigningTurns(log, first, { since: SINCE })!;
    const again = appendDesigningTurns(
      next,
      [...first, m("assistant", "質問C", 1_300), m("user", "答えD", 1_400)],
      { since: SINCE },
    )!;
    expect(again.startsWith(log.trimEnd())).toBe(true);
    expect(again.split("## designing 中の会話").length).toBe(2);
    expect(again).toContain("質問A");
    expect(again).toContain("答えD");
  });

  test("会話の先頭が compact で消えていても、時刻で分けて足せる", () => {
    const next = appendDesigningTurns(log, [m("assistant", "質問A", 1_100), m("user", "答えB", 1_200)], {
      since: SINCE,
    });
    expect(next).toContain("答えB");
  });

  test("足す発言が無い・時刻が取れない・開始時刻が不正なら何もしない", () => {
    expect(appendDesigningTurns(log, base, { since: SINCE })).toBeNull();
    expect(
      appendDesigningTurns(log, [...base, m("user", "時刻なし", undefined)], { since: SINCE }),
    ).toBeNull();
    expect(
      appendDesigningTurns(log, [...base, m("user", "答え", 1_200)], { since: Number.NaN }),
    ).toBeNull();
  });

  test("足す部分にも上限がかかる（古い側を落とし、落とした数を書く）", () => {
    const many = Array.from({ length: 6 }, (_, i) => m(i % 2 ? "user" : "assistant", `発言${i}`, 1_100 + i));
    const next = appendDesigningTurns(log, many, { since: SINCE, maxTurns: 3 })!;
    const tail = next.slice(log.trimEnd().length);
    expect(tail).toContain("older messages omitted");
    expect(tail).toContain("発言5");
    expect(tail).not.toContain("発言2");
  });
});
