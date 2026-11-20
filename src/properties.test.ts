/**
 * 性質テスト（design g-mwmnvx3x 判断2）。
 *
 * 「壊れたら必ず落ちる」性質だけを置く。生成器は手書き（fast-check を足さない）。
 * 依存を増やさない代わりに、対象を往復・上限に絞る。
 */
import { describe, expect, test } from "bun:test";
import { formatModelRef, parseModelRef } from "./agents";

describe("性質: modelRef の往復（encode → decode → encode が一致）", () => {
  const providers = ["claude-oauth", "opencode-go", "amazon-bedrock", "x"];
  const models = ["claude-opus-5-5", "deepseek-v4.1-flash", "global.xai.grok-4.7"];
  const variants = [null, "xhigh", "max", "none"];

  test("全組合せで往復する", () => {
    for (const providerID of providers) {
      for (const model of models) {
        for (const variant of variants) {
          const ref = { providerID, model, ...(variant ? { variant } : {}) };
          const text = formatModelRef(ref);
          const back = parseModelRef(text);
          expect(back).toEqual(ref);
          expect(formatModelRef(back)).toBe(text);
        }
      }
    }
  });
});
