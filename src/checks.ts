/**
 * checks — diff トリガ付きチェックリスト（純粋層）。
 *
 * 「変更の形」から機械的に発火条件を決め、当たった確認だけを verify の角度として必ず走らせる。
 * 角度を選ぶ役（LLM）の判断に任せると、過去に踏んだ不具合を落とすため。
 * 一覧は project の `skills/graphhopper/refs/checks.md` に置く（形式はそのファイルの先頭に書く）。
 *
 * 発火の意味:
 * - when-path: diff のファイル path に「含まれる」なら真（複数は OR）
 * - when-line: diff の +/- 行に正規表現が当たれば真（複数は OR）
 * - 両方あれば AND（そのファイルの、その行が変わったとき）
 * - どちらも無い項目は無視する（常時発火させない）
 */
import { isValidAngleId, type PlanEntry } from "./angles";

export interface Check {
  id: string;
  title: string;
  whenPath: string[];
  whenLine: string[];
  doubt: string;
  scope: string;
  /** この項目が生まれた事例（任意） */
  why?: string;
}

/** project 側の一覧。無ければチェックは走らない（fail-open） */
export const CHECKS_PATH = "skills/graphhopper/refs/checks.md";

/** 1 回の verify で走らせる上限。当たりすぎたらトリガを狭める */
export const MAX_CHECKS = 4;

const TITLE_MAX = 40;
const TEXT_MAX = 400;
const WHY_MAX = 200;

/** 値を包む backtick を外す（`when-line: \`regex\`` の形を許す） */
function unquote(v: string): string {
  return v.trim().replace(/^`+/, "").replace(/`+$/, "").trim();
}

/** checks.md を読む。壊れた項目は捨てる（id 不正・doubt 無し・発火条件なし） */
export function parseChecks(md: string): Check[] {
  const out: Check[] = [];
  for (const block of md.split(/^### /m).slice(1)) {
    const [head, ...rest] = block.split("\n");
    const id = unquote(head ?? "");
    if (!isValidAngleId(id)) continue;
    const check: Check = { id, title: "", whenPath: [], whenLine: [], doubt: "", scope: "" };
    for (const raw of rest) {
      const m = /^\s*-\s*(when-path|when-line|title|doubt|scope|why)\s*:\s*(.*)$/.exec(raw);
      if (!m) continue;
      const value = unquote(m[2] ?? "");
      if (!value) continue;
      switch (m[1]) {
        case "when-path":
          check.whenPath.push(value);
          break;
        case "when-line":
          check.whenLine.push(value);
          break;
        case "title":
          check.title = value.slice(0, TITLE_MAX);
          break;
        case "doubt":
          check.doubt = value.slice(0, TEXT_MAX);
          break;
        case "scope":
          check.scope = value.slice(0, TEXT_MAX);
          break;
        default:
          check.why = value.slice(0, WHY_MAX);
      }
    }
    if (!check.doubt) continue;
    if (check.whenPath.length === 0 && check.whenLine.length === 0) continue;
    if (!check.title) check.title = id;
    if (!check.scope) check.scope = "diff の関連箇所";
    out.push(check);
  }
  return out;
}

export interface DiffFile {
  /** 変更されたファイルの path（b/ 側） */
  path: string;
  /** そのファイルの変更行（+/- で始まる行。---/+++ のヘッダは除く） */
  lines: string[];
}

export interface DiffScan {
  files: DiffFile[];
  /** 変更されたファイルの path（files の写し） */
  paths: string[];
  /** 全ファイルの変更行（path 条件が無いとき用） */
  lines: string[];
}

export function scanDiff(diff: string): DiffScan {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = { path: head[2], lines: [] };
      files.push(current);
      continue;
    }
    if (/^(---|\+\+\+)\s/.test(line)) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (!current) {
      /* ヘッダの無い diff 断片は 1 つの仮ファイルに入れる */
      current = { path: "", lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }
  return { files, paths: files.map((f) => f.path), lines: files.flatMap((f) => f.lines) };
}

function safeRegExp(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/** 発火したチェック（上限まで、一覧の並び順）。
 * path 条件があるときは、path が一致したファイルの変更行だけを line 条件で見る（別ファイルの行で発火しない） */
export function matchChecks(diff: string, checks: Check[], max = MAX_CHECKS): Check[] {
  const scan = scanDiff(diff);
  const hit: Check[] = [];
  for (const check of checks) {
    if (hit.length >= max) break;
    let lines = scan.lines;
    if (check.whenPath.length > 0) {
      const picked = scan.files.filter((f) => check.whenPath.some((p) => f.path.includes(p)));
      if (picked.length === 0) continue;
      lines = picked.flatMap((f) => f.lines);
    }
    if (check.whenLine.length > 0) {
      const ok = check.whenLine.some((src) => {
        const re = safeRegExp(src);
        return re !== null && lines.some((l) => re.test(l));
      });
      if (!ok) continue;
    }
    hit.push(check);
  }
  return hit;
}

/** チェックを角度の計画へ入れる形にする */
export function checkEntries(checks: Check[]): PlanEntry[] {
  return checks.map((c) => ({
    id: c.id,
    title: c.title,
    doubt: c.doubt,
    scope: c.scope,
    source: "check",
    carried: false,
  }));
}
