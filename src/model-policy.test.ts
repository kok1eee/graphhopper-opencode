/** モデル許可判定の単体テスト（design g-mw8qwiy6 / g-mw8rlbjr）。 */
import { describe, expect, test } from "bun:test";
import { checkModelAllowed } from "./model-policy";

describe("checkModelAllowed", () => {
  test("未設定は無制限", () => {
    expect(checkModelAllowed("a/b", {})).toEqual({ ok: true });
    expect(checkModelAllowed(undefined, {})).toEqual({ ok: true });
  });
  test("deny は allow より優先", () => {
    expect(checkModelAllowed("a/b", { allow: ["a/*"], deny: ["a/b"] })).toEqual({
      ok: false,
      kind: "deny",
      rule: "a/b",
    });
  });
  test("allow 非空なら一致必須", () => {
    expect(checkModelAllowed("a/b", { allow: ["a/*"] })).toEqual({ ok: true });
    expect(checkModelAllowed("x/y", { allow: ["a/*"] })).toEqual({
      ok: false,
      kind: "allow",
    });
  });
  test("glob は全体一致・大小文字区別", () => {
    expect(
      checkModelAllowed("opencode-go/x", { deny: ["opencode-go/*"] }),
    ).toMatchObject({ ok: false, kind: "deny" });
    // 部分一致しない
    expect(
      checkModelAllowed("pre-opencode-go/x", { deny: ["opencode-go/*"] }),
    ).toEqual({ ok: true });
    // 大小文字を区別する
    expect(
      checkModelAllowed("Opencode-Go/x", { deny: ["opencode-go/*"] }),
    ).toEqual({ ok: true });
  });
  test("未解決は制限有効時のみ拒否", () => {
    expect(checkModelAllowed(undefined, { deny: ["a/*"] })).toEqual({
      ok: false,
      kind: "unresolved",
    });
  });
});
