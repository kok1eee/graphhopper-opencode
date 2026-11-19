/**
 * invoke / 実行中表示が共有する時間の上限（design g-mwkfisl7）。
 * `src/invoke.ts` と `src/running-invoke.ts` の相互 import（循環）を避けるため、
 * 定数だけをここに置く。invoke.ts は従来の名前で再エクスポートする。
 */

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
export const MIN_TIMEOUT_MS = 10000;
/** verify の角度 1 つあたりの既定 timeout。invoke 全体の上限（MAX_TIMEOUT_MS）とは別に固定する
 * （角度は 4 本まで並列に走るので、1 本に 10 分は待たない） */
export const ANGLE_TIMEOUT_MS = 300000;
