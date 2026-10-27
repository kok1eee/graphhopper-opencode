/**
 * graphhopper v2 plugin entry.
 * designing/implementing/polish state machine with a physical design-gate.
 * v1 (config hook＋tool map) を v2 (Plugin.define＋domain transforms/hooks) に移植。
 */
import { Plugin } from "@opencode/plugin";
import { collectAgentUpdates } from "../../../src/agents";
import { registerHooks } from "./hooks";
import { registerCoreTools } from "./tools-core";
import { registerLspTools } from "./tools-lsp";
import { registerOpsTools } from "./tools-ops";
import { registerWorkflowTool } from "./workflow";
import type { Gh } from "./shared";

export default Plugin.define({
  id: "graphhopper",
  async setup(ctx) {
    const gh: Gh = { ctx, root: ctx.location.directory };

    /* 8→7 subagent: 静的宣言 (.opencode/agents/*.md) 済みが前提。
     * 割当表 (.graphhopper/config.json agents) の model＋permissions を update で適用する。
     * v1 K10/K11 の教訓: 割当はここで必ず適用し、継承に流さない。 */
    /* 注意: transform 実行時点では builtin しかカタログに無い (.md 発見は後で、
     * reload しても discovery が後に replay されるため update は当たらない。
     * 実測済み)。割当の適用は scripts/gen-agents.ts の bake が本命。
     * ここは将来の順序変更に備えた best-effort として残す。 */
    await ctx.agent.transform((editor) => {
      const updates = collectAgentUpdates(gh.root);
      for (const [name, u] of Object.entries(updates)) {
        if (!editor.get(name)) continue;
        editor.update(name, (agent) => {
          agent.model = { providerID: u.model.providerID, model: u.model.model } as never;
          agent.permissions = u.permissions as never;
          if (u.temperature !== undefined) {
            agent.request = { body: { temperature: u.temperature } } as never;
          }
        });
      }
    });

    /* graphhopper_* tools＋7 lsp_* tools (namespace無し・生名登録。M1)。
     * invoke は spawn 版 (src/invoke.ts) を薄く包む。opencode では MCP を無効にし本経路に一本化。
     * TUI 内の子起動は task() が正 (native・可視・並列)。 */
    await ctx.tool.transform((editor) => {
      registerCoreTools(editor, gh);
      registerOpsTools(editor, gh);
      registerLspTools(editor, gh);
      registerWorkflowTool(editor, gh);
    });

    return registerHooks(gh);
  },
});
