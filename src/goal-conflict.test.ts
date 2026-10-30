import { describe, expect, test } from "bun:test";
import { checkBuiltinGoal, parseGoalActive, type RpcCaller } from "./goal-conflict";

describe("parseGoalActive", () => {
  test("goal 無しは false", () => {
    expect(parseGoalActive(null)).toBe(false);
    expect(parseGoalActive(undefined)).toBe(false);
  });
  test("status で判定する", () => {
    expect(parseGoalActive({ status: "active" })).toBe(true);
    expect(parseGoalActive({ status: "paused" })).toBe(false);
    expect(parseGoalActive({ status: "complete" })).toBe(false);
  });
  test("形が違えば null（判定不能）", () => {
    expect(parseGoalActive({})).toBeNull();
    expect(parseGoalActive("active")).toBeNull();
    expect(parseGoalActive({ status: 1 })).toBeNull();
  });
});

describe("checkBuiltinGoal", () => {
  test("active を返す", async () => {
    const rpc: RpcCaller = async () => ({ output: { status: "active" } });
    expect(await checkBuiltinGoal(rpc, "ses_a")).toEqual({ active: true, reason: "active" });
  });

  test("goal 無し", async () => {
    const rpc: RpcCaller = async () => ({ output: null });
    expect(await checkBuiltinGoal(rpc, "ses_a")).toEqual({ active: false, reason: "none" });
  });

  test("sessionID 空は RPC を呼ばない", async () => {
    let called = 0;
    const rpc: RpcCaller = async () => {
      called++;
      return { output: { status: "active" } };
    };
    expect(await checkBuiltinGoal(rpc, "")).toEqual({ active: false, reason: "none" });
    expect(called).toBe(0);
  });

  test("RPC が無ければ fail-open（rpc_missing）", async () => {
    const rpc: RpcCaller = async () => {
      throw new Error("unknown rpc");
    };
    expect(await checkBuiltinGoal(rpc, "ses_a")).toEqual({ active: false, reason: "rpc_missing" });
  });

  test("応答が遅ければ timeout で fail-open", async () => {
    const rpc: RpcCaller = (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    expect(await checkBuiltinGoal(rpc, "ses_a", 5)).toEqual({ active: false, reason: "timeout" });
  });

  test("形が違えば shape", async () => {
    const rpc: RpcCaller = async () => ({ output: { weird: true } });
    expect(await checkBuiltinGoal(rpc, "ses_a")).toEqual({ active: false, reason: "shape" });
  });
});
