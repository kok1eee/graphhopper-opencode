/* bun test の preload（bunfig.toml [test] preload）。
 * 判定プロバイダ系の新 env を未設定に固定し、開発者のシェル設定でテストが変わらないようにする。
 * shadow は既定で off（既存テストが実ネットワークへ出ないようにするため）。
 * shadow を試すテストは自前で set → finally で戻すこと。 */
for (const k of [
  "GRAPHHOPPER_DECISION_PROVIDER",
  "GRAPHHOPPER_DECISION_SHADOW",
  "GRAPHHOPPER_JEV_MODEL",
  "OPENCODE_API_KEY",
] as const) {
  delete process.env[k];
}
process.env.GRAPHHOPPER_DECISION_SHADOW = "off";
