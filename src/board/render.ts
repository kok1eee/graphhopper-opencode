/**
 * board の表示文字列を作る純粋関数。ANSI 色は付けない（TUI 側が行単位で色を足す）。
 */
import type { BoardGoal, VerifySummary } from "./model";
import { isStale } from "./model";

/** 相対時刻。1 分未満は「いま」 */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "いま";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}日前`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}か月前` : `${Math.floor(mo / 12)}年前`;
}

export function statusLabel(g: BoardGoal, now: number): string {
  if (g.status === "active") return "進行中";
  if (g.status === "done") return "完了";
  return isStale(g, now) ? "停止(古)" : "停止";
}

/** 1 文字の表示幅（全角 2 桁） */
function charCells(ch: string): 1 | 2 {
  const c = ch.codePointAt(0) ?? 0;
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    c >= 0x1f300;
  return wide ? 2 : 1;
}

export function cells(s: string): number {
  let w = 0;
  for (const ch of s) w += charCells(ch);
  return w;
}

/** 幅（端末の桁数）を超えないよう切る。切ったら … を付ける */
export function truncCells(s: string, width: number): string {
  if (width <= 0) return "";
  if (cells(s) <= width) return s;
  const limit = width - 1;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charCells(ch);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export function padCells(s: string, width: number): string {
  const t = truncCells(s, width);
  return t + " ".repeat(Math.max(0, width - cells(t)));
}

export interface ListOptions {
  width: number;
  now: number;
  selected: number;
  showDone: boolean;
  header?: string;
}

/** 一覧の行（ANSI なし）。選択行は先頭に ">" を付ける */
export function formatList(goals: BoardGoal[], opt: ListOptions): string[] {
  const w = Math.max(40, opt.width);
  const repoW = Math.min(20, Math.max(10, Math.floor(w * 0.16)));
  const statusW = 9;
  const phaseW = Math.min(14, Math.max(8, Math.floor(w * 0.1)));
  const timeW = 9;
  const titleW = Math.max(12, w - repoW - statusW - phaseW - timeW - 6);
  const lines: string[] = [];
  const head = `  ${padCells("状態", statusW)} ${padCells("リポジトリ", repoW)} ${padCells("goal", titleW)} ${padCells("段階", phaseW)} ${padCells("最終", timeW)}`;
  lines.push(opt.header ?? "", truncCells(head, w));
  if (goals.length === 0) {
    lines.push("", "  該当する goal がありません（d で完了も表示）");
    return lines;
  }
  goals.forEach((g, i) => {
    const sel = i === opt.selected ? ">" : " ";
    const line = `${sel} ${padCells(statusLabel(g, opt.now), statusW)} ${padCells(g.repoName, repoW)} ${padCells(g.title, titleW)} ${padCells(g.phase ?? "-", phaseW)} ${padCells(ago(g.lastEventAt ?? g.createdAt, opt.now), timeW)}`;
    lines.push(truncCells(line, w));
  });
  return lines;
}

/** 折り返し（桁数ベース。長い行は切らずに折る） */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    let w = 0;
    for (const ch of raw) {
      const cw = charCells(ch);
      if (w + cw > width) {
        out.push(line);
        line = ch;
        w = cw;
      } else {
        line += ch;
        w += cw;
      }
    }
    out.push(line);
  }
  return out;
}

export function formatVerify(v: VerifySummary | null, now: number, width = 80): string[] {
  if (!v) return ["  （検証結果なし。まだ polish まで来ていないか、古い記録です）"];
  const out: string[] = [];
  const drift = v.angles.filter((a) => a.level === "drift");
  out.push(`  検証: ${ago(v.at, now)} / 要修正 ${drift.length} 観点・問題なし ${v.angles.length - drift.length} 観点`);
  if (v.currentDiff === false) out.push("  ※ 今の差分とは別の差分に対する判定です（その後の変更が入っています）");
  for (const a of v.angles) {
    const mark = a.level === "drift" ? "✗" : a.level === "clean" ? "✓" : "?";
    out.push(`   ${mark} ${a.lens}${a.summary ? `: ${a.summary}` : ""}`);
    // 要修正の観点だけ本文（指摘の中身）を下げて添える
    if (a.level === "drift" && a.body) {
      for (const l of wrap(a.body.trim(), Math.max(20, width - 6))) out.push(`      ${l}`);
    }
  }
  for (const m of v.missing) out.push(`   ? ${m.lens}: 判定できず（${m.reason}）`);
  return out;
}

/** 詳細画面の行。designText は決定記録の本文、events は history の該当 goal 分 */
export function formatDetail(
  g: BoardGoal,
  designText: string | null,
  events: Record<string, unknown>[],
  opt: { width: number; now: number },
): string[] {
  const w = Math.max(40, opt.width) - 2;
  const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const lines: string[] = [];
  lines.push(...wrap(g.title, w));
  lines.push(...wrap(`${g.repoName} / ${g.id} / ${statusLabel(g, opt.now)}${g.phase ? ` / ${g.phase}` : ""}`, w));
  if (g.stop) lines.push(...wrap(`止まった理由: ${g.stop.reason}（${ago(g.stop.at, opt.now)}）`, w));
  lines.push("");
  lines.push("## 検証結果");
  for (const l of formatVerify(g.verify, opt.now, w)) lines.push(...wrap(l, w));
  lines.push("");
  lines.push("## 最近の出来事");
  const recent = events.slice(-40).reverse();
  if (recent.length === 0) lines.push("  （履歴なし）");
  for (const e of recent) {
    const ts = s(e.ts);
    const type = s(e.type) ?? "?";
    const detail = [
      s(e.from) && s(e.to) ? `${s(e.from)}→${s(e.to)}` : null,
      s(e.level) ? `level=${s(e.level)}` : null,
      s(e.reason) ? `reason=${s(e.reason)}` : null,
      typeof e.ok === "boolean" ? (e.ok ? "ok" : "fail") : null,
      typeof e.diff_lines === "number" ? `diff=${e.diff_lines}` : null,
      s(e.route) ? `route=${s(e.route)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const when = ts ? new Date(ts) : null;
    const stamp = when && !Number.isNaN(when.getTime())
      ? `${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
      : "--";
    lines.push(...wrap(`  ${stamp} ${type}${detail ? ` ${detail}` : ""}`, w));
  }
  lines.push("");
  lines.push("## 決定記録");
  if (!designText) lines.push("  （決定記録なし）");
  else for (const l of wrap(designText.trimEnd(), w)) lines.push(`  ${l}`);
  return lines;
}
