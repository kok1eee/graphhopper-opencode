/**
 * 決定記録（design g-mwmykjt4 判断1）。designing で合意したことを残す記録の形と検査。
 * 機械が見るのは「3 つの見出しがあり、どれも空でない」ことだけ。中身の質は合意で担保する。
 * 純粋関数のみ（ファイル I/O は呼び出し側）。
 */

export const RECORD_SECTIONS = [
  { key: "決めたこと", heading: "決めたこと" },
  { key: "やらないこと", heading: "やらないこと" },
  { key: "完了の確かめ方", heading: "完了の確かめ方" },
] as const;

/** 実質内容とみなす最小文字数（空白を除く） */
export const RECORD_MIN_CHARS = 8;

const HEADING = /^##\s+(.*?)\s*$/;
const PLACEHOLDER = /^[（(].*[）)]$/;

export function recordTemplate(goalId: string, title: string): string {
  return [
    `# 決定記録: ${title} (${goalId})`,
    ``,
    `> 意図ログ: .graphhopper/plans/${goalId}.intent.md（goal 開始時の会話。designing 中の質問と答えは実装に進むときに後ろへ足される）`,
    ``,
    `## 決めたこと`,
    ``,
    `（ユーザーと合意した内容。判断ごとに 1 項目。理由が要るものは 1 行で添える）`,
    ``,
    `## やらないこと`,
    ``,
    `（この goal で変えないもの。無いなら、何を確かめて無いと判断したかを書く）`,
    ``,
    `## 完了の確かめ方`,
    ``,
    `（テスト・コマンド・目視など、終わったと言える観測）`,
    ``,
  ].join("\n");
}

/** 節の本文（見出しの次の行から次の `##` まで）。見出しが無ければ null */
export function recordSection(raw: string, heading: string): string[] | null {
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex((l) => {
    const m = HEADING.exec(l);
    return m !== null && m[1] === heading;
  });
  if (i === -1) return null;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (HEADING.test(l)) break;
    out.push(l);
  }
  return out;
}

function hasContent(lines: string[]): boolean {
  return lines.some((l) => {
    const t = l.trim().replace(/^[-*]\s+/, "");
    if (!t || PLACEHOLDER.test(t)) return false;
    return t.replace(/\s/g, "").length >= RECORD_MIN_CHARS;
  });
}

/** 検査。空配列なら適合。違反は「何をどこに足すか」を返す */
export function checkDecisionRecord(raw: string | null): string[] {
  if (raw === null) return ["決定記録の読み込みに失敗した（ファイルが無い、または不正なエンコーディング）"];
  const problems: string[] = [];
  for (const s of RECORD_SECTIONS) {
    const body = recordSection(raw, s.heading);
    if (body === null) {
      problems.push(`「## ${s.heading}」の見出しが無い`);
    } else if (!hasContent(body)) {
      const hint =
        s.key === "やらないこと" ? "（無いなら、何を確かめて無いと判断したかを書く。「なし」だけでは通らない）" : "";
      problems.push(`「## ${s.heading}」が空（実質 ${RECORD_MIN_CHARS} 文字以上の行が要る）${hint}`);
    }
  }
  return problems;
}
