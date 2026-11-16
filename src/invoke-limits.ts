/**
 * invoke / 実行中表示が共有する時間の上限（design g-mwkfisl7）。
 * `src/invoke.ts` と `src/running-invoke.ts` の相互 import（循環）を避けるため、
 * 定数だけをここに置く。invoke.ts は従来の名前で再エクスポートする。
 */

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 300000;
export const MIN_TIMEOUT_MS = 10000;
