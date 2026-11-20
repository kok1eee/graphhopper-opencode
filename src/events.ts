/**
 * opencode v2 のセッションイベント判定（純粋関数）。
 * 自動継続・eval は `experimental.idle` フックで動くので、turn 完了イベントの判定はここに無い。
 */

/** ユーザーが中断した（自動継続してはいけない）イベントか */
export function isInterruptedEvent(type: string | undefined): boolean {
  return type === "session.execution.interrupted";
}

/** 実行が失敗したイベントか（プロバイダ障害。自動継続は空回りするので使わない） */
export function isFailedEvent(type: string | undefined): boolean {
  return type === "session.execution.failed";
}
