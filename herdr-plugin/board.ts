/**
 * graphhopper board — herdr のポップアップで開く、全リポジトリの goal 一覧。
 * 読み取り専用（.graphhopper/ は変えない）。状態を変えるのは 'o'（該当ワークスペースへ移動）だけ。
 *
 * キー: ↑↓/jk 移動, Enter 詳細, Esc 戻る（一覧で押すと閉じる）, o 移動, d 完了も表示, r 更新, q 閉じる
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findRepos,
  readBoard,
  readDesign,
  readGoalEvents,
  visibleGoals,
  type BoardGoal,
  type ScanRoot,
} from "../src/board/model";
import { formatDetail, formatList, type ListOptions } from "../src/board/render";
import { moveToRepo, type Runner } from "../src/board/herdr";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const INVERSE = "\x1b[7m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

/** GH_BOARD_ROOTS は `dir` か `dir=深さ` を `:` 区切りで並べる */
export function roots(): ScanRoot[] {
  const env = process.env["GH_BOARD_ROOTS"];
  if (env) {
    return env
      .split(":")
      .filter(Boolean)
      .map((item) => {
        const m = /^(.*)=(\d+)$/.exec(item);
        return m ? { dir: m[1]!, depth: Number(m[2]) } : { dir: item, depth: 3 };
      });
  }
  const home = homedir();
  return [
    { dir: join(home, "Documents"), depth: 3 },
    { dir: join(home, "dotfiles"), depth: 2 },
  ];
}

const herdrRunner: Runner = (argv) => {
  const bin = process.env["HERDR_BIN_PATH"] ?? "herdr";
  const r = spawnSync(bin, argv, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

interface View {
  goals: BoardGoal[];
  selected: number;
  showDone: boolean;
  mode: "list" | "detail";
  scroll: number;
  msg: string;
  repos: number;
  errors: string[];
}

function emptyView(): View {
  return { goals: [], selected: 0, showDone: false, mode: "list", scroll: 0, msg: "", repos: 0, errors: [] };
}

function refresh(v: View): View {
  const found = findRepos(roots());
  const board = readBoard(found);
  const goals = visibleGoals(board.goals, v.showDone);
  return {
    ...v,
    goals,
    repos: found.length,
    errors: board.errors,
    selected: Math.min(v.selected, Math.max(0, goals.length - 1)),
  };
}

function termSize(): { cols: number; rows: number } {
  return {
    cols: Math.max(60, process.stdout.columns ?? 100),
    rows: Math.max(16, process.stdout.rows ?? 32),
  };
}

function colorLine(line: string): string {
  if (line.startsWith(">")) return INVERSE + line + RESET;
  // 状態の列は行頭 2 桁目から始まる（題の中の同じ語に反応しない）
  const status = line.slice(2);
  if (status.startsWith("停止(古)")) return RED + line + RESET;
  if (status.startsWith("停止")) return YELLOW + line + RESET;
  if (status.startsWith("進行中")) return GREEN + line + RESET;
  return DIM + line + RESET;
}

/** 詳細画面の行。goal を開いたときと r・幅の変化のときだけ作り直す（スクロールでは読み直さない） */
let detailCache: { key: string; lines: string[] } | null = null;

function detailLines(g: BoardGoal, width: number): string[] {
  const key = `${g.repo}\0${g.id}\0${width}`;
  if (detailCache?.key === key) return detailCache.lines;
  const lines = formatDetail(g, readDesign(g.repo, g.id), readGoalEvents(g.repo, g.id), { width, now: Date.now() });
  detailCache = { key, lines };
  return lines;
}

function draw(v: View): void {
  const { cols, rows } = termSize();
  const now = Date.now();
  const out: string[] = [];
  const g = v.goals[v.selected];
  if (v.mode === "detail" && !g) {
    v.mode = "list";
    v.scroll = 0;
  }
  if (v.mode === "list" || !g) {
    const opt: ListOptions = {
      width: cols,
      now,
      selected: v.selected,
      showDone: v.showDone,
      header: `${BOLD}graphhopper board${RESET} ${DIM}${v.goals.length} goals / ${v.repos} repos${v.showDone ? " / 完了も表示" : ""}${RESET}`,
    };
    const lines = formatList(v.goals, opt);
    const footer = [
      v.msg ? `\x1b[36m${v.msg}${RESET}` : "",
      v.errors.length ? `${DIM}読めない記録 ${v.errors.length} 件（r で再読込。${v.errors[0]}）${RESET}` : "",
      `${DIM}↑↓ 移動 / Enter 詳細 / o ワークスペースへ / d 完了表示 / r 更新 / q・Esc 閉じる${RESET}`,
    ].filter(Boolean);
    const body = lines.slice(1);
    const visible = body.slice(0, Math.max(1, rows - footer.length - 2));
    out.push(lines[0]!, ...visible.map(colorLine), "", ...footer);
  } else {
    const lines = detailLines(g, cols);
    const maxScroll = Math.max(0, lines.length - (rows - 3));
    v.scroll = Math.min(v.scroll, maxScroll);
    const view = lines.slice(v.scroll, v.scroll + Math.max(1, rows - 3));
    out.push(`${BOLD}${g.repoName}${RESET} ${DIM}(${v.scroll}/${maxScroll})${RESET}`, ...view);
    out.push("", v.msg ? `\x1b[36m${v.msg}${RESET}` : `${DIM}↑↓ スクロール / o ワークスペースへ / Esc 一覧へ / r 更新 / q 閉じる${RESET}`);
  }
  while (out.length < rows) out.push("");
  process.stdout.write(`\x1b[H${out.slice(0, rows).join("\n")}${RESET}\x1b[J`);
}

/** 溜まった入力を 1 キーずつ取り出す。エスケープの途中なら null（続きを待つ） */
export function takeKey(pending: string): { key: string; rest: string } | null {
  if (!pending) return null;
  if (pending.startsWith("\x1b")) {
    const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(pending);
    if (csi) return { key: csi[0], rest: pending.slice(csi[0].length) };
    // ESC [ 数字… の途中か、ESC 単独。どちらも続きを待つ
    if (/^\x1b(\[[0-9;]*)?$/.test(pending)) return null;
    // ESC + 1 文字（Alt 系）は ESC として扱う
    return { key: "\x1b", rest: pending.slice(1) };
  }
  const cp = pending.codePointAt(0)!;
  const ch = String.fromCodePoint(cp);
  return { key: ch, rest: pending.slice(ch.length) };
}
/** ESC 単独押しと区別するための待ち時間 */
const ESC_WAIT_MS = 40;

function main(): void {
  if (!process.stdin.isTTY) {
    // TTY が無い（リダイレクト）ときは 1 回だけ描いて終わる。動作確認に使える
    const v = refresh(emptyView());
    process.stdout.write(formatList(v.goals, { width: 120, now: Date.now(), selected: 0, showDone: v.showDone }).join("\n") + "\n");
    return;
  }
  let v: View = refresh(emptyView());
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // 既に閉じている
    }
    process.stdout.write(`\x1b[?25h${RESET}\x1b[H\x1b[2J`);
  };
  const quit = (): void => {
    restore();
    process.exit(0);
  };
  process.on("exit", restore);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => {
    restore();
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
  process.stdout.write("\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const handle = (key: string): void => {
    const g = v.goals[v.selected];
    if (key === "q" || key === "\x03") return quit();
    if (v.mode === "list") {
      if (key === "\x1b") return quit();
      if (key === "\x1b[A" || key === "k") v.selected = Math.max(0, v.selected - 1);
      else if (key === "\x1b[B" || key === "j") v.selected = Math.min(v.goals.length - 1, v.selected + 1);
      else if (key === "g") v.selected = 0;
      else if (key === "G") v.selected = Math.max(0, v.goals.length - 1);
      else if (key === "\r" || key === "\n") {
        if (g) {
          v.mode = "detail";
          v.scroll = 0;
          v.msg = "";
        }
      } else if (key === "o" && g) {
        v.msg = moveToRepo(g.repo, g.repoName, herdrRunner).message;
      } else if (key === "d") {
        v = refresh({ ...v, showDone: !v.showDone, selected: 0 });
      } else if (key === "r") {
        detailCache = null;
        v = refresh({ ...v, msg: "" });
      }
    } else {
      if (key === "\x1b[A" || key === "k") v.scroll = Math.max(0, v.scroll - 1);
      else if (key === "\x1b[B" || key === "j") v.scroll += 1;
      else if (key === "\x1b[5~") v.scroll = Math.max(0, v.scroll - 10);
      else if (key === "\x1b[6~") v.scroll += 10;
      else if (key === "\x1b" || key === "\x7f") {
        v.mode = "list";
        v.scroll = 0;
        v.msg = "";
      } else if (key === "o" && g) {
        v.msg = moveToRepo(g.repo, g.repoName, herdrRunner).message;
      } else if (key === "r") {
        detailCache = null;
        v = refresh({ ...v, msg: "" });
      }
    }
  };

  let pending = "";
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  const drain = (): void => {
    let handled = 0;
    for (;;) {
      const next = takeKey(pending);
      if (!next) break;
      pending = next.rest;
      handle(next.key);
      handled++;
    }
    if (handled) draw(v);
    // エスケープの途中で止まったら、続きが来なければ 1 キーとして扱う（ESC 単独押し）
    if (pending) {
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(() => {
        escTimer = null;
        const rest = pending;
        pending = "";
        for (const ch of rest.split("")) handle(ch);
        draw(v);
      }, ESC_WAIT_MS);
    }
  };
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    drain();
  });
  process.stdout.on("resize", () => draw(v));
  draw(v);
}

if (import.meta.main) main();
