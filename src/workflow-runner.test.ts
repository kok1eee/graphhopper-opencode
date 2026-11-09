/** workflow runner のポリシー拒否テスト（design g-mw8xvsg8 判断5）。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_DENIED, type WorkflowDef } from "./workflow";
import { runWorkflow, type WorkflowHost } from "./workflow-runner";

const def: WorkflowDef = {
  name: "t",
  nodes: [
    {
      id: "n1",
      agent: null,
      tier: "baseline",
      prompt: "p",
      output: { required: [] },
      maxRetry: 0,
    },
  ],
};

const cascade = {
  enabled: false,
  baseline: "x/y",
  escalate: "x/y",
  escalate_on: [],
  fail_threshold: 0,
  agents: { apply: "always" as const, quality: {} },
};

describe("runWorkflow のポリシー拒否", () => {
  test("POLICY_DENIED は LLM リカバリを回さず即 failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-runner-"));
    let recoveries = 0;
    const host: WorkflowHost = {
      createChild: async () => {
        throw new Error(`${POLICY_DENIED}: opencode-go/gpt-6-luna (model_deny)`);
      },
      prompt: async () => {},
      wait: async () => {},
      lastText: async () => "",
      interrupt: async () => {},
      repoHash: async () => "x",
    };
    const run = await runWorkflow(host, {
      root,
      goal: "g",
      task: "t",
      def,
      cascade,
      nodeTimeoutMs: 1000,
      decideRecovery: async () => {
        recoveries++;
        return "abort";
      },
      isAborted: () => false,
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain(POLICY_DENIED);
    expect(recoveries).toBe(0);
  });
});
