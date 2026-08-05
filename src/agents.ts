/**
 * graphhopper の専用 subagent 定義（config hook で注入）
 *
 * graphhopper本体（Claude Code版）のtiering をそのまま踏襲する:
 *   researcher = haiku（高頻度・事実収集専用・判断を含まない）
 *   advisor/verifier(polish council) = opus（判断node、常にopus品質を保証）
 *
 * amazon-bedrock 経由で Claude ファミリをフルに使える環境向けにモデルIDを固定。
 * 系列多様性の議論（flywheelの2-vendor構成）はgraphhopperには不要——
 * 判断は「メイン(sonnet) + advisor/verifier(opus)」の2層で足りるという
 * graphhopper自体の設計原則（council再発防止）に合わせ、vendorを増やさない。
 *
 * 全て読み取り専用（edit/bash deny）。実装はメインループ側だけが行う。
 * ユーザーが opencode.json(c) に同名 agent を定義している場合はそちらを優先する。
 */
import { readConfig } from "./state";
import type { Config } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

const HAIKU = "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0";
const OPUS = "amazon-bedrock/anthropic.claude-opus-5";

export const GRAPHHOPPER_AGENTS: Record<string, AgentConfig> = {
  "graphhopper-researcher": {
    description:
      "コードベース探索と外部調査の統合エージェント。ファイル検索・構造把握・公式ドキュメント調査。高頻度に呼ばれるためコストティア最下層（haiku）固定",
    mode: "subagent",
    model: HAIKU,
    temperature: 0.1,
    permission: { edit: "deny", bash: "deny" },
    prompt: [
      "あなたは調査専門家。与えられた問いに対し、コードベースを探索して根拠（ファイル:行）付きの回答を返す。",
      "",
      "ルール:",
      "- 推測で答えない。必ずgrep/glob/readで裏付けを取る",
      "- 回答は「結論 → 根拠 → 不明点」の形式",
      "- 見つからなかった場合は見つからなかったと言う",
      "- コードは書かない。調査と報告だけ",
    ].join("\n"),
  },

  "graphhopper-verifier": {
    description:
      "polishフェーズのadversarial verifier fan-out用。requirement/behavior/progressの3レンズいずれかとして呼ばれる。判断nodeなので常にopus品質を保証する",
    mode: "subagent",
    model: OPUS,
    temperature: 0.2,
    permission: { edit: "deny", bash: "deny" },
    prompt: [
      "あなたは敵対的レビューアー。実装者ではなく第三者の立場でdiffのdrift（乖離）を検証する。",
      "",
      "呼び出し側が渡すcharter（requirement/behavior/progressのいずれか）に従い、",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければfindings: []とsummaryに「driftなし」と明記する。",
      "",
      "ルール:",
      "- 指摘は具体的に（ファイル:行を特定、該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
    ].join("\n"),
  },
};

export function injectAgents(
  input: { agent?: Config["agent"] },
  root: string,
): void {
  const cfg = readConfig(root);
  input.agent ??= {};
  for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
    const override = cfg.agents[name];
    input.agent[name] ??= override ? { ...def, model: override } : def;
  }
}
