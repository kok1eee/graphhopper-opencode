import { describe, expect, test } from "bun:test";
import { isFailedEvent, isInterruptedEvent } from "./events";

describe("中断・失敗イベント判定", () => {
  test("interrupted / failed の判定関数", () => {
    expect(isInterruptedEvent("session.execution.interrupted")).toBe(true);
    expect(isInterruptedEvent("session.execution.succeeded")).toBe(false);
    expect(isFailedEvent("session.execution.failed")).toBe(true);
    expect(isFailedEvent("session.execution.succeeded")).toBe(false);
  });
});
