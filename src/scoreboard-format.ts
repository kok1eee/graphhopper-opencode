/** scoreboard の人間向け整形（MCP と plugin で共有）。 */
import type { Scoreboard } from "./state";

export function formatScoreboard(sb: Scoreboard): string {
  return [
    "## models",
    ...sb.models.map(
      (m) =>
        `- ${m.role} ${m.model}: ${m.verdicts}件 (clean ${m.clean} / drift ${m.drift}${m.mixed > 0 ? ` / mixed ${m.mixed}` : ""})`,
    ),
    "## goals",
    ...sb.goals.map(
      (g) =>
        `- ${g.id} "${g.title}" [${g.status}] rewinds=${g.rewinds} eval=${g.evalPass}/${g.evalFail} score=${g.score ?? "-"}`,
    ),
    "## hints",
    ...sb.hints.map((h) => `- ${h}`),
  ].join("\n");
}
