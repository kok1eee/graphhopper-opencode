import { describe, expect, test } from "bun:test";
import { takeKey } from "../../herdr-plugin/board";

/** 溜まった入力を最後まで 1 キーずつ取り出す */
function keys(input: string): string[] {
  const out: string[] = [];
  let pending = input;
  for (;;) {
    const r = takeKey(pending);
    if (!r) break;
    out.push(r.key);
    pending = r.rest;
  }
  return out;
}

describe("board: キー入力の切り分け", () => {
  test("まとめて届いた文字も 1 つずつに分ける", () => {
    expect(keys("jjj")).toEqual(["j", "j", "j"]);
    expect(keys("\x1b[B\x1b[B")).toEqual(["\x1b[B", "\x1b[B"]);
  });

  test("全角や絵文字も 1 文字として扱う", () => {
    expect(keys("あ🙂")).toEqual(["あ", "🙂"]);
  });

  test("エスケープの途中は待つ（null）", () => {
    expect(takeKey("\x1b")).toBeNull();
    expect(takeKey("\x1b[")).toBeNull();
    expect(takeKey("\x1b[5")).toBeNull();
    expect(takeKey("\x1b[5~")).toEqual({ key: "\x1b[5~", rest: "" });
  });

  test("空文字は null", () => {
    expect(takeKey("")).toBeNull();
  });
});
