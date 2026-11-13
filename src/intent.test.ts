/** 意図ログ生成の単体テスト（design g-mwebh9vl）。 */
import { describe, expect, test } from "bun:test";
import {
  INTENT_MAX_CHARS,
  INTENT_MAX_TURNS,
  maskSecrets,
  renderIntent,
  toIntentTurns,
  type IntentMessage,
} from "./intent";

const user = (text: string, metadata?: Record<string, unknown>): IntentMessage => ({
  type: "user",
  text,
  ...(metadata ? { metadata } : {}),
});
const assistant = (...texts: string[]): IntentMessage => ({
  type: "assistant",
  content: [
    ...texts.map((t) => ({ type: "text", text: t })),
    { type: "tool", text: "ignored" },
  ],
});

describe("toIntentTurns", () => {
  test("user と assistant の text だけを拾い、tool は捨てる", () => {
    expect(toIntentTurns([user("やって"), assistant("了解", "方針はA")])).toEqual([
      { role: "me", text: "やって" },
      { role: "assistant", text: "了解\n\n方針はA" },
    ]);
  });
  test("内部注入（接頭辞・metadata）と空は捨てる", () => {
    const turns = toIntentTurns([
      user("[graphhopper] 内部"),
      user("[graphhopper-continuation] 続けよ"),
      user("本物", { graphhopper_internal: true }),
      user("   "),
      assistant(""),
      user("残る"),
    ]);
    expect(turns).toEqual([{ role: "me", text: "残る" }]);
  });
});

describe("renderIntent", () => {
  test("原依頼を残し、直近 maxTurns 件に切り詰める", () => {
    const msgs: IntentMessage[] = [user("最初の依頼")];
    for (let i = 0; i < INTENT_MAX_TURNS + 10; i++) {
      msgs.push(user(`発言${i}`));
      msgs.push(assistant(`応答${i}`));
    }
    const out = renderIntent(msgs, { goalId: "g-x", title: "t" });
    expect(out).not.toBeNull();
    expect(out!).toContain("me: 最初の依頼");
    expect(out!).toContain("older messages omitted");
    // 直近の応答は残る
    expect(out!).toContain(`応答${INTENT_MAX_TURNS + 9}`);
  });

  test("文字数上限を超えない（原依頼は残す）", () => {
    const msgs: IntentMessage[] = [
      user("最初の依頼"),
      ...Array.from({ length: 50 }, (_, i) =>
        user(`長い発言${i} `.repeat(200)),
      ),
    ];
    const out = renderIntent(msgs, { goalId: "g-y", title: "t" });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(INTENT_MAX_CHARS + 500);
    expect(out!).toContain("me: 最初の依頼");
  });

  test("有効な発言が無い・大きすぎる場合は null", () => {
    expect(renderIntent([])).toBeNull();
    expect(renderIntent([assistant("")])).toBeNull();
    expect(
      renderIntent([user("x".repeat(100))], { maxFetchChars: 10 }),
    ).toBeNull();
  });

  test("既知のキー形式を伏せる", () => {
    expect(maskSecrets("key=oc_sk_5315b78e01fb_wHLjgK4qUN5WmtZYvbWwxMwwibtjs5uF")).toBe(
      "key=oc_sk_***",
    );
    expect(maskSecrets("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer ***",
    );
    expect(maskSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA***");
  });
});
