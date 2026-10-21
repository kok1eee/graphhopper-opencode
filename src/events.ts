/**
 * opencode v2 の turn 完了イベント判定（純粋関数）。
 *
 * v2 の turn 完了シグナルは `session.execution.succeeded`。
 * `session.idle` / `session.status` は SDK の型には残っているが 2.1 系は発行しない
 * （実測: plugin の event 購読は活着するのに session.idle は届かない）。
 * 旧名も将来互換のため見ておくが、判定の主役にしない。
 *
 * この判定を1か所へ集約する理由: 「session.idle を待つ」バグで
 * auto-eval・継続注入・loop 検知・TUI の subagent 完了通知が全部死んでいた実例がある。
 * 複数ファイルに同じ判定を書くと片方だけ旧名のまま残る。
 */

/** turn 完了（自動継続・eval実行の起点）として扱うイベントか */
export function isTurnEndEvent(type: string | undefined): boolean {
  if (!type) return false;
  if (type === "session.execution.succeeded") return true;
  // 旧名（将来互換）。2.1 系では発行されないが、出る_versions がある
  if (type === "session.idle") return true;
  return false;
}

/** ユーザーが中断した（自動継続してはいけない）イベントか */
export function isInterruptedEvent(type: string | undefined): boolean {
  return type === "session.execution.interrupted";
}

/** 実行が失敗したイベントか（プロバイダ障害。自動継続は空回りするので使わない） */
export function isFailedEvent(type: string | undefined): boolean {
  return type === "session.execution.failed";
}
