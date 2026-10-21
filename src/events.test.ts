import { describe, expect, test } from "bun:test";
import { isFailedEvent, isInterruptedEvent, isTurnEndEvent } from "./events";

describe("turn 完了イベント判定", () => {
  test("session.execution.succeeded が turn 完了", () => {
    expect(isTurnEndEvent("session.execution.succeeded")).toBe(true);
  });
  test("旧名 session.idle も turn 完了（将来互換）", () => {
    expect(isTurnEndEvent("session.idle")).toBe(true);
  });
  test("failed / interrupted / 其它は turn 完了ではない", () => {
    // failed はプロバイダ障害で空回りするので自動継続に使わない
    expect(isTurnEndEvent("session.execution.failed")).toBe(false);
    // interrupted はユーザー中断
    expect(isTurnEndEvent("session.execution.interrupted")).toBe(false);
    expect(isTurnEndEvent("session.status")).toBe(false);
    expect(isTurnEndEvent("session.tool.success")).toBe(false);
    expect(isTurnEndEvent(undefined)).toBe(false);
  });
  test("interrupted / failed の判定関数", () => {
    expect(isInterruptedEvent("session.execution.interrupted")).toBe(true);
    expect(isInterruptedEvent("session.execution.succeeded")).toBe(false);
    expect(isFailedEvent("session.execution.failed")).toBe(true);
    expect(isFailedEvent("session.execution.succeeded")).toBe(false);
  });
});
