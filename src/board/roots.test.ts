import { afterEach, describe, expect, test } from "bun:test";
import { roots } from "../../herdr-plugin/board";

const saved = process.env["GH_BOARD_ROOTS"];
afterEach(() => {
  if (saved === undefined) delete process.env["GH_BOARD_ROOTS"];
  else process.env["GH_BOARD_ROOTS"] = saved;
});

describe("board: 探す先", () => {
  test("既定は Documents と dotfiles", () => {
    delete process.env["GH_BOARD_ROOTS"];
    const r = roots();
    expect(r.map((x) => x.dir.split("/").pop())).toEqual(["Documents", "dotfiles"]);
    expect(r.map((x) => x.depth)).toEqual([3, 2]);
  });

  test("GH_BOARD_ROOTS で上書きでき、`dir=深さ` も読む", () => {
    process.env["GH_BOARD_ROOTS"] = "/a:/b=1";
    expect(roots()).toEqual([
      { dir: "/a", depth: 3 },
      { dir: "/b", depth: 1 },
    ]);
  });
});
