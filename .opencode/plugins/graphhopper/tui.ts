/**
 * TUI エントリの解決用シム。
 *
 * opencode の CLI plugin discovery が `<plugin>/tui.ts` と `<plugin>/tui.tsx` の
 * どちらを探すかは実装依存なので、確実に拾わせるために .ts 側から実装を再輸出する。
 * 実装は tui-main.tsx 側だけを編集する（`./tui` だと自分自身に解決されるため別名）。
 */
export { default } from "./tui-main";
