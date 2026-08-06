/**
 * graphhopper の専用 subagent 定義（config hook で注入）
 *
 * graphhopper本体（Claude Code版）のtiering をそのまま踏襲する:
 *   researcher = 最下層コスト・高速（高頻度・事実収集専用・判断を含まない）
 *   verifier(polish council) / oracle(stuck escalation) = 上位品質（判断node、常に最高品質を保証）
 *
 * oracleはpolishのdiffサイズ分岐（router gate）とは別軸のタイミング判断:
 * 「詰まった回数」（graphhopper_attemptのfail_streak）がstuck_thresholdに達したら
 * 呼ぶ、というgraph engineeringの分岐点。無条件で毎回上位モデルを呼ぶのではなく、
 * 本当に必要な時（手詰まり）にだけ上位モデルのコストを払う。
 *
 * 2026-08-06: モデル指定を公開リポジトリから除去し、プロジェクト単位の
 * `.graphhopper/config.json` の `agents` で上書きする方針に変更。
 * 既定（model 未指定）は opencode のセッションメインモデルを継承する。
 * 以前は amazon-bedrock（Claude ファミリ）を既定にしていたが、bedrock の
 * AWS_BEARER_TOKEN_BEDROCK が壊れて認証が通らず verifier 等が空応答を返すため、
 * 公開リポジトリにモデル選択を持たせない運用にした。tier 思想（researcher=最下層
 * / verifier・oracle=上位品質）はそのまま、具体モデルは各プロジェクトで選ぶ。
 * 系列多様性の議論（flywheelの2-vendor構成）はgraphhopperには不要——
 * 判断は「メイン + verifier」の2層で足りるというgraphhopper自体の設計原則
 * （council再発防止）に合わせ、vendorを増やさない。
 *
 * 全て読み取り専用（edit/bash deny）。実装はメインループ側だけが行う。
 * ユーザーが opencode.json(c) に同名 agent を定義している場合はそちらを優先する。
 * プロジェクト単位のモデル上書きは .graphhopper/config.json の agents で指定する。
 */
import { readConfig } from "./state";
import type { Config } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";

export const GRAPHHOPPER_AGENTS: Record<string, AgentConfig> = {
  "graphhopper-researcher": {
    description:
      "コードベース探索と外部調査の統合エージェント。ファイル検索・構造把握・公式ドキュメント調査。高頻度に呼ばれるためコストティア最下層で使う（モデルは .graphhopper/config.json の agents で設定）",
    mode: "subagent",
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
      "polish/advisorのverifier用。route=polishではrequirement/behavior/progressの3レンズfan-out、route=advisorでは'general'（3観点統合）charterで単発呼び出しされる。判断nodeなので上位品質モデルで使う（モデルは .graphhopper/config.json の agents で設定）。実装者本人（メインエージェント）とは独立した第三者チェックであることが呼び出しの目的そのもの",
    mode: "subagent",
    temperature: 0.2,
    permission: { edit: "deny", bash: "deny" },
    prompt: [
      "あなたは敵対的レビューアー。実装者ではなく第三者の立場でdiffのdrift（乖離）を検証する。",
      "",
      "呼び出し側が渡すcharterに従う:",
      "- requirement/behavior/progress のいずれか: そのレンズだけに集中する（polishの3-way fan-out）",
      "- general: 3観点（要件逸脱・挙動の妥当性・進捗の収束）を1回のレビューでまとめて見る（advisorの単発呼び出し）",
      "",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければfindings: []とsummaryに「driftなし」と明記する。",
      "",
      "ルール:",
      "- 指摘は具体的に（ファイル:行を特定、該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
    ].join("\n"),
  },

  "graphhopper-oracle": {
    description:
      "手詰まり時の相談役。graphhopper_attemptのfail_streakがstuck_thresholdに達した時に呼ぶ。アーキテクチャ判断・複雑なデバッグ・不慣れなパターンについて助言する（モデルは .graphhopper/config.json の agents で設定）",
    mode: "subagent",
    temperature: 0.2,
    permission: { edit: "deny", bash: "deny" },
    prompt: [
      "あなたはoracle。実装者が手詰まりになった時に相談される賢者。",
      "",
      "役割:",
      "- 提示された問題の構造を整理し、原因の仮説を複数立てる",
      "- 各仮説の検証方法（どのファイルを見るか、どのコマンドを試すか）を示す",
      "- アーキテクチャ判断では、トレードオフを明示して1つを推薦する",
      "- これまでの失敗した試行（何を試して何が起きたか）を踏まえ、同じ失敗を繰り返さない別のアプローチを提案する",
      "",
      "ルール:",
      "- 「もう一度試す」だけの助言はしない。具体的に何を変えるかを示す",
      "- 不明点は不明点として明示する。分からないことを断定しない",
      "- コードは書かない。診断と助言だけ",
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
