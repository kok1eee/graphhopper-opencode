/**
 * graphhopper v2 plugin: 自前 LSP 読取 7 件。
 * v1 src/index.ts の lsp_* tool 本体を v2 形に移植。座標は tool 境界 1-based。
 */
import { BUILTIN_SERVERS } from "../../../src/lsp/config";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
} from "../../../src/lsp/format";
import {
  extOf,
  languageIdFor,
  readFileText,
  serversWithWarnings,
  withLspClient,
} from "../../../src/lsp/helpers";
import { toZeroBased } from "../../../src/lsp/types";
import * as state from "../../../src/state";
import { S, text, type Gh } from "./shared";

const filePathProp = { filePath: S.str("対象ファイルパス") };
const lineColProps = {
  ...filePathProp,
  line: S.num("行（1-based）"),
  col: S.num("列（1-based）"),
};

export function registerLspTools(
  editor: { add(tool: Record<string, unknown>): void },
  gh: Gh,
): void {
  const { root } = gh;
  const extra = () => state.readConfig(root).lsp_servers;

  editor.add({
    name: "lsp_hover",
    description: "LSP hover: 指定位置（file:line:col・1-based）のホバー情報を返す。位置特定済みの問い専用",
    input: S.obj(lineColProps, ["filePath", "line", "col"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string; line: number; col: number };
      const out = await withLspClient(args.filePath, extra(), async (c) => {
        const h = await c.hover(args.filePath, toZeroBased(args.line, args.col));
        return formatHover(h);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_goto_definition",
    description: "LSP goto_definition: 指定位置の定義位置を返す。位置特定済みの問い専用",
    input: S.obj(lineColProps, ["filePath", "line", "col"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string; line: number; col: number };
      const out = await withLspClient(args.filePath, extra(), async (c) => {
        const locs = await c.definition(args.filePath, toZeroBased(args.line, args.col));
        return formatLocations("definitions", locs);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_find_references",
    description: "LSP find_references: 指定位置の参照位置を返す（宣言含む・上限200）。位置特定済みの問い専用",
    input: S.obj(lineColProps, ["filePath", "line", "col"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string; line: number; col: number };
      const out = await withLspClient(args.filePath, extra(), async (c) => {
        const locs = await c.references(args.filePath, toZeroBased(args.line, args.col));
        return formatLocations("references", locs);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_document_symbols",
    description: "LSP document_symbols: 当該ファイルのシンボル一覧を返す",
    input: S.obj(filePathProp, ["filePath"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string };
      const out = await withLspClient(args.filePath, extra(), async (c) => {
        const syms = await c.documentSymbols(args.filePath);
        return formatSymbols(syms);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_workspace_symbols",
    description: "LSP workspace_symbols: ワークスペース横断のシンボル検索（query最小2文字・空クエリ拒否・上限200）",
    input: S.obj(
      {
        query: S.str("検索クエリ（2文字以上）"),
        filePath: S.optStr("起点ファイル（server解決用。省略時はroot直下のダミーで解決できないため必須に近い）"),
      },
      ["query"],
    ),
    execute: async (input: unknown) => {
      const args = input as { query: string; filePath?: string };
      const q = (args.query ?? "").trim();
      if (q.length < 2) return text("error: query must be at least 2 characters");
      const probe = args.filePath ?? `${root}/probe.ts`;
      const out = await withLspClient(probe, extra(), async (c) => {
        const syms = await c.workspaceSymbols(q);
        return formatSymbols(syms);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_diagnostics",
    description: "LSP diagnostics: 指定ファイルの即時診断を返す（didOpen→待機→didClose）",
    input: S.obj(filePathProp, ["filePath"]),
    execute: async (input: unknown) => {
      const args = input as { filePath: string };
      const fileText = readFileText(args.filePath);
      if (fileText === null) return text(`error: cannot read ${args.filePath}`);
      const out = await withLspClient(args.filePath, extra(), async (c) => {
        const diags = await c.diagnostics(args.filePath, fileText, languageIdFor(extOf(args.filePath)));
        return formatDiagnostics(diags);
      });
      return text(String(out));
    },
  });

  editor.add({
    name: "lsp_servers",
    description: "LSP servers: 対応server表（builtin＋config追加分）を返す",
    input: S.obj({}, []),
    execute: async () => {
      const { servers: merged, ignored } = serversWithWarnings(extra());
      const builtin = new Set(BUILTIN_SERVERS.map((s) => s.command));
      const lines = merged.map(
        (s) => `${s.command} ${s.args.join(" ")} [${s.extensions.join(",")}]${builtin.has(s.command) ? "" : " (config)"}`,
      );
      if (ignored > 0) {
        lines.push(
          `warning: ignored ${ignored} invalid lsp_servers entries (must have {command:string, args:string[], extensions:string[]})`,
        );
      }
      return text(lines.join("\n"));
    },
  });
}
