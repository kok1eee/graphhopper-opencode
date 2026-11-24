/* bun test の preload（bunfig.toml [test] preload）。
 * 判定プロバイダ系の新 env を未設定に固定し、開発者のシェル設定でテストが変わらないようにする。
 * shadow は既定で off（既存テストが実ネットワークへ出ないようにするため）。
 * shadow を試すテストは自前で set → finally で戻すこと。 */
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of [
  "GRAPHHOPPER_DECISION_PROVIDER",
  "GRAPHHOPPER_DECISION_SHADOW",
  "GRAPHHOPPER_JEV_MODEL",
  "OPENCODE_API_KEY",
  /* 判定モデルの key。手元にあると idle hook（見張り・入口判定）がテスト中に実ネットワークへ出る。
   * 判定を使うテストは自前で set → finally で戻す */
  "LIQUID_API_KEY",
] as const) {
  delete process.env[k];
}
process.env.GRAPHHOPPER_DECISION_SHADOW = "off";

/* 開発者の手元の環境（実ユーザー設定・実 opencode 本体）を読まない（design g-mwu1q953）。
 * CI にはどちらも無いので、ここで固定しないと手元でだけ通るテストになる。
 * - GRAPHHOPPER_CONFIG: 存在しないパス → 空の設定として読む。全体設定が要るテストは自前で差し替える
 * - GH_OPENCODE_BIN: 実在しないパス。invoke のテストは偽の spawn を渡すので実際には起動しない
 *   （plugin-tools のテストは自前で偽バイナリに差し替え、終わったらこの値へ戻す） */
process.env["GRAPHHOPPER_CONFIG"] = join(tmpdir(), "gh-test-no-global-config.json");
process.env["GH_OPENCODE_BIN"] = join(tmpdir(), "gh-test-opencode-bin");
