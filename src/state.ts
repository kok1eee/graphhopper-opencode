import { recordTemplate } from "./record";
import { progressKeyOf } from "./loop-guard";
/**
 * graphhopper state 管理
 *
 * `.graphhopper/` 配下の JSON/JSONL ファイルを読み書きする。
 * - goals.json    : 目標キューと active 指定
 * - state.json    : 現在のループ状態（フェーズ・セッション紐付け・verifier サブステート）
 * - config.json   : プロジェクト毎の上書き設定（任意）
 * - history.jsonl : 監査ログ（append-only）
 * - plans/<goal-id>.md : design ドキュメント（designing フェーズで書く唯一の許可パス）
 *
 * config は「グローバル既定 → プロジェクト上書き」の2層で解決する（readConfig）。
 * グローバル既定は `~/.config/opencode/graphhopper.json`（`GRAPHHOPPER_CONFIG` で変更可）。
 * 全プロジェクトで同じ agents 設定を使いたい場合はグローバルに1枚置けばよい。
 *
 * 外部依存なし（node stdlib のみ）。全ての書き込みは tmp+rename で原子的に行う。
 * flywheel-opencode (src/state.ts) の atomic write パターンを踏襲。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sha1Hex } from "./hashedit";
import {
  addTodo,
  applyMark,
  formatTodoList,
  splitTodoItems,
  todoGateError,
  todoProgress,
  todoStoreError,
  type TodoStatus,
  type TodoStore,
} from "./todos";

/** graphhopper 本体（Claude Code版）の3相グラフに合わせる。flywheelの8フェーズより薄い */
export const PHASES = ["designing", "implementing", "polish", "done"] as const;
export type Phase = (typeof PHASES)[number];

export type GoalStatus = "active" | "paused" | "done";

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  created_at: string;
  done_at: string | null;
  /** complete時の機械採点（B）。内訳付き・後方互換のためoptional */
  score?: GoalScore | null;
  /** pause時の文脈スナップショット。別goal走行後のresumeで自文脈に復帰するため */
  paused_snapshot?: GoalSnapshot | null;
}

/** pause時に退避するgoal固有文脈（単一LoopStateの使い回しによる漏れ対策） */
export interface GoalSnapshot {
  phase: Phase;
  router: RouterState;
  last_verifier: VerifierVerdict | null;
  eval_cmd: string | null;
  notes: string;
  /** goal start時の脏れ。resume後も自goal基準を維持するため退避する */
  initial_diff_lines: number | null;
  /** goal start時の脏れファイル集合。deep判定の差分基準として退避する */
  initial_diff_files: string[] | null;
  /** goal 開始時の会話から作った意図ログの path（design g-mwebh9vl）。null＝未作成 */
  intent_path: string | null;
  /** ルール文書の usability レビュー結果（design g-mwfltxyt）。null＝未記録 */
  usability_review: UsabilityVerdict | null;
  /** goal 開始時の baseline rev（commit）。usability と diff hash の基準に使う */
  start_baseline_rev: string | null;
  /** baseline の取得元（design g-mwkgfssi）。旧 state は null */
  baseline_source: BaselineSource | null;
  /** goal 開始時に凍結した complete ゲートのモード（design g-mwmnvx3x 判断3）。
   * null＝旧 goal（config の現在値を使う） */
  gate_modes: GateModes | null;
  /** goal 開始時に凍結した採点基準の sha1（design g-mwmnvx3x 判断1）。null＝未凍結 */
  rubric_hash: string | null;
  /** goal start の strong: true（goal の間だけ強いモデルで回す） */
  strong_mode: boolean;
}

/** goal出来栄えの機械採点。式はv1で固定し、breakdownで透明化する（調整は式ごと変える） */
export interface GoalScore {
  value: number;
  breakdown: {
    rewinds: number;
    maxFailStreak: number;
    gateBlocks: number;
    verifierRounds: number;
  };
}

export type VerdictLevel = "clean" | "drift";
/** drift 巻き戻し先。implementing 以外は人間の hand-back 待ち（flywheelのmonitor相当） */
export type DriftTarget = "implementing" | "design" | "requirements";
/** 角度の id（旧 lens の 4 値を含む。実行時の検証は angles.ts の isValidAngleId） */
export type VerifierLens = string;

/** difficulty の正規化。未知値は null（昇格しない） */
export function normalizeDifficulty(v: unknown): Difficulty | null {
  return v === "easy" || v === "normal" || v === "hard" ? v : null;
}

export interface VerifierVerdict {
  level: VerdictLevel;
  reason: string;
  target: DriftTarget | null;
  lens: VerifierLens[];
  /** 角度ごとの level と prior（履歴用） */
  angles?: { lens: string; level: VerdictLevel; prior?: { valid: number; invalid: number; unresolved: number } }[];
  /** 判定を実行したモデル（未指定時はconfig既定で補完）。評価機能の成績表素材 */
  model?: string | null;
  /** lens並列の実行モデル（混成run用。欠測・旧eventは [model] fallback）。
   * 長さは lens と一致させる（setVerifierVerdict がpad/truncateする） */
  models?: (string | null)[];
  /** 検証した差分の sha1（design g-mwd3n5bo）。null/欠測＝計算不能。
   * complete 時に現在の差分と照合し、変わっていれば再検証を要求する */
  diff_hash?: string | null;
  /** lens ごとの重要度の件数（design g-mwmnvx3x 判断4）。undefined＝未申告。
   * 同じ要素を lens をまたいで重複計上しうるので合計は「延べ」で出す */
  severity?: VerifierSeverityEntry[];
  at: string;
}

/** lens 1 件分の severity（未申告は counts: null） */
export interface VerifierSeverityEntry {
  lens: VerifierLens;
  counts: { must_fix: number; should_fix: number; nit: number; pre_existing: number } | null;
}

/** ルール文書の usability レビュー結果（design g-mwfltxyt） */
export interface UsabilityVerdict {
  level: "clean" | "drift" | "skipped";
  reason: string;
  /** レビュー対象の文書（repo 相対）。skipped でも自動記録する */
  files: string[];
  /** 対象文書の内容の sha1（review 後の変更検知用）。null＝計算不能 */
  doc_hash: string | null;
  model?: string | null;
  at: string;
}

export type RouterRoute = "advisor" | "polish";

export interface RouterState {
  baseline_rev: string | null;
  diff_lines: number | null;
  route: RouterRoute | null;
  checked_at: string | null;
  /** deep推奨。同一goalの変更がRISK_PATHSに触れたか（recordRouterCheckWithRiskが判定） */
  deep: boolean;
  /** deep=trueの理由（触れたriskファイル列）。false時はnull */
  deep_reason: string | null;
}

/** 難易度（d1判定）。null＝未判定。昇格判断にのみ使う */
export type Difficulty = "easy" | "normal" | "hard";

/** 子セッション（subagent）のモデル切替記録 */
export interface CascadeChild {
  sessionID: string;
  agent: string;
  /** 適用したモデル "provider/model" */
  model: string;
  /** 切替後の読み返しが一致したか（実リクエストの保証ではない） */
  readback_match: boolean;
  at: string;
}

/** モデルカスケードの適用状態。goal終了時に restore へ戻す */
export interface CascadeState {
  level: "baseline" | "escalated";
  reason: string;
  /** 適用中の "provider/model"（表示用。未適用は null） */
  model: string | null;
  /** goal開始前のモデル。ここへ戻す。取れなかった場合は null（＝切替しない） */
  restore: { providerID: string; id: string; variant?: string } | null;
  /** 直近の子セッション切替記録（古い順に最大10件） */
  children: CascadeChild[];
  /** implementing 途中確認の段。未使用は undefined */
  checkpoint?: "requested" | "reviewing" | "done";
  at: string;
}

/** 自動継続の上限ガード（opencode 組み込み /goal と同趣旨の歯止め） */
export interface LoopGuard {
  /** 継続を積んだ回数（resume で 0 に戻す） */
  rounds: number;
  /** 進捗なしの連続回数（resume で 0 に戻す） */
  stalls: number;
  /** 直近の継続時の進捗キー */
  progress_key: string | null;
  /** 「進捗なし」「eval 連続失敗」で止めたときの進捗キー。resume 後の初回判定が同じ値なら
   * その場で pause する（design g-mwokteud）。force の resume で消える。旧 state は undefined */
  stuck_key?: string | null;
  /** background（subagent/shell）待ちを始めた時刻。無ければ null */
  wait_since: string | null;
  /** 継続を積んだが、まだターンが返っていない */
  pending: boolean;
  /** 継続を積んだプロセスの boot id */
  boot: string | null;
}

export interface LoopState {
  goal_id: string | null;
  /** ループ継続注入の対象セッション。null は未バインド */
  session_id: string | null;
  phase: Phase;
  /** 中断・再開用のメモ（「どこまでやったか」） */
  notes: string;
  /** router gate（loop-driver.sh 相当）が直近に測った diff サイズと分岐先 */
  router: RouterState;
  /** polish フェーズの verifier fan-out 結果。null = 未実行 */
  last_verifier: VerifierVerdict | null;
  /**
   * implementing での連続失敗数（eval か graphhopper_attempt が機械カウント）。
   * stuck_threshold に達したら graphhopper-oracle への相談を促す。
   * eval の成功・phase 遷移・resume でリセットされる。eval_cmd 設定中の自己申告 ok では
   * リセットしない（合否は eval が決める。design g-mwoiwjif）。
   */
  fail_streak: number;
  /**
   * implementing の合否を機械判定するコマンド（graphhopper本体のeval_cmd相当）。
   * 設定されていれば turn 終了（session.execution.succeeded）ごとに毎回実行し、exit codeで自動的に
   * pass（polishへ遷移）/fail（fail_streakを機械カウント）を判定する。
   * 未設定なら graphhopper_attempt の自己申告にフォールバックする。
   */
  eval_cmd: string | null;
  /**
   * 直近に注入した継続リマインダー時点の進展フィンガープリント
   * （continuationFingerprint の戻り値）。次回 idle 時に同一なら
   * 「前回注入以降に進展なし」とみなして注入をスキップし、待機ackの
   * 言い換え繰り返しによる空転ループを1往復で止める。
   */
  last_continuation_marker: string | null;
  /**
   * 直近の eval_cmd 実行結果のフィンガープリント（ok + 出力tailのハッシュ）。
   * 同一失敗の再注入を抑止しつつ、結果が変わったら注入を再開するための材料。
   */
  last_eval_fingerprint: string | null;
  /**
   * 無限ループ検知（echoループ）の連続カウント。turn 終了ごとに
   * 「直前のassistantメッセージとほぼ同一のuserメッセージ」を検知して増える。
   * ループでない（人間の新規入力）と判定されたら0に戻る。
   */
  loop_streak: number;
  /** 無限ループを検知して自動継続注入を停止した「現在の一時状態」か。永続フラグではなく
   * pauseGoal / resumeGoal / completeGoal / 明示 pause / clear で false に戻る。
   * resume の恒久ブロックは loop_stop_count >= loop_stop_max の判定で行う。 */
  loop_stopped: boolean;
  /** ループ検知による自動停止の累積回数（goalごと）。loop_stop_max に達すると resume を
   * 拒否して人間に判断を委ねる。明示 pause はカウントしない。clear で0に戻る。 */
  loop_stop_count: number;
  /** 直近に edit/write されたファイル（正規化前パス）。同一ファイル再編集の
   * 検知アンカー。別ファイル・eval pass・phase 遷移・resume でリセット */
  edit_file: string | null;
  /** 同一ファイルへの連続 edit/write 回数。stuck_edit_repeat に達したら
   * stuck 扱い（堂々巡りの再編集の機械検知） */
  edit_streak: number;
  /** 直近に測定したワーキングコピー差分行数。diff 停滞の検知アンカー */
  last_diff_lines: number | null;
  /** ワーキングコピー差分が変わらない idle  eval 回数。stuck_diff_stall に
   * 達したら stuck 扱い。差分変化・eval pass・phase 遷移・resume でリセット */
  diff_stall: number;
  /** 直近に stuck 通知した理由集合。同一理由の再通知を抑止する。
   * resume でクリアする */
  last_stuck_reasons: string[];
  /** goal start時の未コミット脏れ行数（baseline rev基準）。実効diff＝測定－初期値。
   * null＝legacy/未測定→0扱い。designing中はsource編集不可のためstart時測定で安定 */
  initial_diff_lines: number | null;
  /** goal start時の未コミット脏れファイル集合（正規化済み）。deep判定の差分基準。
   * null＝legacy/未測定→deepなし。snapshotInitialDiffFilesがstart時に記録する */
  initial_diff_files: string[] | null;
  /** diff_stash 時点の diff の sha1（design g-mwd3n5bo）。verifier が読んだ入力を
   * 固定するための退避値。.graphhopper/ の作業ファイルは含めない（design g-mwiu6lcj）。
   * resume/新goal でクリアする */
  stash_diff_hash: string | null;
  /** goal 開始時の会話から作った意図ログの path（design g-mwebh9vl）。null＝未作成 */
  intent_path: string | null;
  /** ルール文書の usability レビュー結果（design g-mwfltxyt）。null＝未記録 */
  usability_review: UsabilityVerdict | null;
  /** goal 開始時の baseline rev（commit）。usability と diff hash の基準に使う */
  start_baseline_rev: string | null;
  /** baseline の取得元（design g-mwkgfssi）。旧 state は null */
  baseline_source: BaselineSource | null;
  /** goal 開始時に凍結した complete ゲートのモード（design g-mwmnvx3x 判断3）。
   * null＝旧 goal（config の現在値を使う） */
  gate_modes: GateModes | null;
  /** goal 開始時に凍結した採点基準の sha1（design g-mwmnvx3x 判断1）。null＝未凍結 */
  rubric_hash: string | null;
  /** goal start の strong: true（goal の間だけ強いモデルで回す） */
  strong_mode: boolean;
  /** 入口判定の難易度。null＝未判定（昇格しない） */
  difficulty: Difficulty | null;
  /** 入口判定(decide)の較正ログ id。decisions.jsonl の decide 行と outcome 行を結ぶ。null＝未判定 */
  decision_id: string | null;
  /** モデルカスケードの適用状態。null＝未適用 */
  cascade: CascadeState | null;
  /** 自動継続の上限ガード */
  guard: LoopGuard;
  /** この goal で verifier が drift と判定した回数（design g-mwoxgpsa）。resume で 0 に戻す。
   * verify_drift_max に達したら goal を pause して人間に聞く（ループ検知の loop_stop_count とは別勘定） */
  verify_drift_count: number;
  updated_at: string;
}

export interface GoalsFile {
  goals: Goal[];
  active: string | null;
}

/** difficulty に応じたモデルカスケード。既定は無効（明示opt-in） */
export interface CascadeConfig {
  enabled: boolean;
  /** 通常時に使う "provider/model#variant" */
  baseline: string;
  /** 昇格時に使う "provider/model#variant" */
  escalate: string;
  /** お手上げ段（oracle 用）のモデル（省略時は escalate にフォールバック） */
  expert?: string;
  /** strong モード（goal start の strong: true）で使うモデル。省略時は expert→escalate */
  strong?: string;
  /** 昇格する難易度 */
  escalate_on: Difficulty[];
  /** 連続失敗がこの数に達したら難易度に関係なく昇格（0以下で無効） */
  fail_threshold: number;
  /** phase ごとのメインモデル（level より優先）。例: designing="main"。
   * 値 "main" は goal 開始時のモデル（restore）に解決する */
  phase_models?: { [phase: string]: string };
  /** "main" が弱い（baseline と同じ）ときの代替モデル。"provider/model"。未設定は expert→escalate */
  main_fallback?: string;
  /** implementing の途中で1回だけ main に確認させる（既定 false） */
  checkpoint?: boolean;
  /** 常に昇格モデルで回す判定用 agent（goal の段には依存しない） */
  agents: {
    /** always: 段に関係なく切替 / escalated: メインが escalated のときだけ切替 */
    apply: "always" | "escalated";
    quality: { [name: string]: string };
    /** 後方互換の旧キー。quality と同じ意味（読み取り時に quality へマージする） */
    escalate?: { [name: string]: string };
  };
}

/** complete ゲートのモード（design g-mwmnvx3x 判断3）。
 * enforce=拒否 / observe=記録して通す。off は用意しない（逃げ道は force）。 */
export type GateMode = "enforce" | "observe";

export type GateName = "usability" | "verifier" | "diff_hash" | "verifier_self_modified";

export type GateModes = Record<GateName, GateMode>;

export interface GraphhopperConfig {
  /** router gate の分岐閾値（diff行数）。超えたら polish、以下なら advisor 相当の自己レビューで足りる */
  router_threshold_lines: number;
  /** designing フェーズで編集を許可する path（glob不可、prefix一致）。デフォルトは plans/ 配下のみ */
  design_gate_allow: string[];
  /** subagent 名で model を上書きする（例: { "graphhopper-verifier": "amazon-bedrock/anthropic.claude-opus-5" }） */
  agents: { [name: string]: string };
  /** 許可するモデルの glob（全体一致・大小文字区別・`*` は任意長）。
   * 非空なら一致必須。空・未設定は無制限。project が global を置き換える */
  model_allow?: string[];
  /** 拒否するモデルの glob（全体一致・大小文字区別）。allow より優先。
   * global と project の和集合（禁止は単調に強くする） */
  model_deny?: string[];
  /** complete ゲートのモード（goal 開始時に凍結される）。既定は既存 3 つ enforce・
   * verifier_self_modified だけ observe（verifier 自体を直す goal を止めないため） */
  gates: GateModes;
  /** implementing の連続失敗数がこれに達したら graphhopper-oracle への相談を促す */
  stuck_threshold: number;
  /** echoループ（直前のassistantメッセージとほぼ同一のuserメッセージ）を
   * 何回連続で検知したら自動継続注入を止めるか。0以下なら echo 検知を無効化
   * （tool検知は loop_tool_repeat_threshold で独立に制御される） */
  loop_stop_threshold: number;
  /** ループ検知による自動停止が累積 loop_stop_max 回に達したら resume を拒否する
   * （人間が force:true で明示解除するか clear するまで）。0以下なら resume ブロック無効 */
  loop_stop_max: number;
  /** 同一tool call反復検知のウィンドウ幅（対象は最後の人間user入力以降の tool call のうち
   * 直近この件数）。0以下なら無効 */
  loop_tool_window: number;
  /** 直近 loop_tool_window 件の tool call 内で同一 (tool名+入力ハッシュ) がこの回数
   * 出たらループと判定する。1以下なら tool 検知を無効化 */
  loop_tool_repeat_threshold: number;
  /** eval_cmd / attempt の連続失敗数がこれに達したら giveUp し goal を pause する
   * （既定 6 = stuck_threshold 既定 2 の3倍。fail 2 で escalate 相談→改善なければ
   * 6 で諦めの順序）。0以下で無効。有効時は stuck_threshold
   * 以上にクランプされる（相談前に諦める逆転を防ぐ） */
  max_eval_fails: number;
  /** 同一ファイルへの連続 edit/write がこの回数に達したら stuck 扱いにする。
   * 1以下で無効 */
  stuck_edit_repeat: number;
  /** ワーキングコピー差分が変わらない idle eval がこの回数続いたら stuck 扱い。
   * 1以下で無効 */
  stuck_diff_stall: number;
  /** 追加LSP server定義（design g-mu5atclj D4）。同extensionsはbuiltinを上書き、未知は追記 */
  lsp_servers: { command: string; args: string[]; extensions: string[] }[];
  /** 自動継続の上限: 継続を積む回数（既定 50） */
  loop_max_rounds: number;
  /** 自動継続の上限: 進捗なしが連続した回数（既定 3） */
  loop_max_stalls: number;
  /** 自動継続の上限: background（subagent/shell）待ちの最大時間 ms（既定 30 分） */
  loop_wait_limit_ms: number;
  /** 同じ goal で verifier が drift と判定した回数の上限（既定 3）。達したら pause して
   * 人間に聞く。0 以下で無効 */
  verify_drift_max: number;
  /** true ならラウンド途中で落ちた goal を起動時に pause する（既定 true） */
  loop_restart_pause: boolean;
  /** モデルカスケード。既定無効 */
  cascade: CascadeConfig;
}

export const DEFAULT_GATES: GateModes = {
  usability: "enforce",
  verifier: "enforce",
  diff_hash: "enforce",
  verifier_self_modified: "observe",
};

export function normalizeGates(raw: unknown): { modes: GateModes; invalid: GateName[] } {
  const rec = (raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const invalid: GateName[] = [];
  const pick = (k: GateName): GateMode => {
    const v = rec[k];
    if (v === "enforce" || v === "observe") return v;
    if (v !== undefined) invalid.push(k);
    return DEFAULT_GATES[k];
  };
  for (const k of Object.keys(rec)) {
    if (!(k in DEFAULT_GATES)) invalid.push(k as GateName);
  }
  return {
    modes: {
      usability: pick("usability"),
      verifier: pick("verifier"),
      diff_hash: pick("diff_hash"),
      verifier_self_modified: pick("verifier_self_modified"),
    },
    invalid,
  };
}

export const DEFAULT_CONFIG: GraphhopperConfig = {
  router_threshold_lines: 400,
  gates: DEFAULT_GATES,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
  stuck_threshold: 2,
  loop_stop_threshold: 6,
  loop_stop_max: 3,
  loop_tool_window: 8,
  loop_tool_repeat_threshold: 4,
  max_eval_fails: 6,
  stuck_edit_repeat: 5,
  stuck_diff_stall: 4,
  loop_max_rounds: 50,
  loop_max_stalls: 3,
  loop_wait_limit_ms: 30 * 60_000,
  verify_drift_max: 3,
  loop_restart_pause: true,
  lsp_servers: [],
  cascade: {
    enabled: false,
    baseline: "minimax/MiniMax-M3.1-Flash",
    escalate: "claude-oauth/claude-sonnet-5-5",
    expert: "claude-oauth/claude-opus-5-5",
    escalate_on: ["hard"],
    fail_threshold: 2,
    agents: { apply: "always", quality: {} },
  },
};

function dir(root: string): string {
  return join(root, ".graphhopper");
}

function goalsPath(root: string): string {
  return join(dir(root), "goals.json");
}

function statePath(root: string): string {
  return join(dir(root), "state.json");
}

function configPath(root: string): string {
  return join(dir(root), "config.json");
}

/** 全プロジェクト共通の既定設定。`GRAPHHOPPER_CONFIG` で明示指定も可能。 */
export function globalConfigPath(): string {
  return (
    process.env.GRAPHHOPPER_CONFIG ??
    join(homedir(), ".config", "opencode", "graphhopper.json")
  );
}

function historyPath(root: string): string {
  return join(dir(root), "history.jsonl");
}

export function planPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.md`);
}

/* ---------- 進捗 todo ストア ----------
 * 進捗の source of truth。決定記録は designing 終端で不変なので計測源にできない。
 * goal ごとに 1 ファイル。plugin の tool と hook の両方から read・write できる。 */
export function todosPath(root: string, goalId: string): string {
  return join(dir(root), "todos", `${goalId}.json`);
}

function emptyTodoStore(goalId: string): TodoStore {
  return { goal_id: goalId, items: [], updated_at: new Date().toISOString() };
}

/**
 * ストアを読む。ファイルが無い / 壊れている場合は空ストア。
 * valid=false は「ファイルは在るが読めない（壊れている）」ことを表す。
 * 「タスク 0 件」と「読めなかった」を区別するために使う（fail-open 防止）。
 */
export function readTodosStatus(
  root: string,
  goalId: string,
): { store: TodoStore; valid: boolean; invalidCount: number } {
  const p = todosPath(root, goalId);
  if (!existsSync(p)) return { store: emptyTodoStore(goalId), valid: true, invalidCount: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { store: emptyTodoStore(goalId), valid: false, invalidCount: 0 };
  }
  const rec = raw as { items?: unknown; updated_at?: unknown } | null;
  if (!rec || !Array.isArray(rec.items)) {
    return { store: emptyTodoStore(goalId), valid: false, invalidCount: 0 };
  }
  const split = splitTodoItems(raw);
  return {
    store: {
      goal_id: goalId,
      items: split.items,
      updated_at: typeof rec.updated_at === "string" ? rec.updated_at : "",
    },
    valid: true,
    invalidCount: split.invalidCount,
  };
}

/** ストアを読む。ファイルが無い / 壊れている場合は空ストア */
export function readTodos(root: string, goalId: string): TodoStore {
  return readTodosStatus(root, goalId).store;
}

/** ストアを書く（atomic） */
export function writeTodos(root: string, store: TodoStore): void {
  const p = todosPath(root, store.goal_id);
  mkdirSync(dirname(p), { recursive: true });
  atomicWrite(p, store);
}

export type TodoAction = "list" | "start" | "done" | "cancel" | "add" | "reopen";

/**
 * 進捗タスクの1行サマリ。タスク 0 件なら null（行ごと落とす）。応答文の単一源泉。
 * 読み取り専用。
 */
export function todoSummaryLine(root: string, goalId: string): string | null {
  try {
    const loaded = readTodosStatus(root, goalId);
    if (!loaded.valid) return "tasks: (ストア不読・進捗不明)";
    if (loaded.invalidCount > 0) {
      const p = todoProgress(loaded.store);
      return `tasks: ${p.done}/${p.total} done（cancel ${p.cancelled}・未完了 ${p.open}・不正要素 ${loaded.invalidCount}）`;
    }
    if (loaded.store.items.length === 0) return null;
    const p = todoProgress(loaded.store);
    return `tasks: ${p.done}/${p.total} done（cancel ${p.cancelled}・未完了 ${p.open}）`;
  } catch {
    return null;
  }
}

const TODO_ACTION_STATUS: Record<
  Exclude<TodoAction, "list" | "add">,
  TodoStatus
> = {
  start: "in_progress",
  done: "completed",
  cancel: "cancelled",
  /** cancel の誤操作からの復旧（遷移表 cancelled → pending） */
  reopen: "pending",
};

/**
 * 進捗タスクの操作（tool からの唯一の入口）。
 * 読み・検証・書き込み・監査記録まで行う。失敗時はストアを弄らない。
 */
export function todoAction(
  root: string,
  goalId: string,
  action: TodoAction,
  opts: { id?: string; text?: string; reason?: string } = {},
): { ok: boolean; text: string; store: TodoStore } {
  const loaded = readTodosStatus(root, goalId);
  if (!loaded.valid) {
    return {
      ok: false,
      text: "error: todo ストアが壊れています（読み込めません）。手動で修復してから再実行せよ",
      store: loaded.store,
    };
  }
  const store = loaded.store;
  const now = new Date().toISOString();
  if (action === "list") {
    return { ok: true, text: formatTodoList(store), store };
  }
  if (action === "add") {
    const r = addTodo(store, opts.text ?? "", now);
    if (!r.ok) return { ok: false, text: `error: ${r.error}`, store };
    writeTodos(root, r.store);
    recordEvent(root, {
      type: "todo_update",
      goal: goalId,
      id: r.id ?? "",
      from: null,
      to: "pending",
      ...(opts.text ? { text: opts.text } : {}),
    });
    return { ok: true, text: `added ${r.id}\n${formatTodoList(r.store)}`, store: r.store };
  }
  const id = opts.id;
  if (!id) return { ok: false, text: "error: id が要る（list でIDを確認せよ）", store };
  const status = TODO_ACTION_STATUS[action];
  const r = applyMark(store, id, status, { reason: opts.reason, now });
  if (!r.ok) return { ok: false, text: `error: ${r.error}`, store };
  writeTodos(root, r.store);
  const from = store.items.find((i) => i.id === id)?.status ?? null;
  recordEvent(root, {
    type: "todo_update",
    goal: goalId,
    id,
    from,
    to: status,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  return { ok: true, text: `${id} -> ${status}\n${formatTodoList(r.store)}`, store: r.store };
}

/* design doc scaffold: goal開始時に骨格を自動生成する。
 * 決定記録（record.ts）の雛形。既存ファイルは壊さない（冪等）。 */
export function designTemplate(goalId: string, title: string): string {
  return recordTemplate(goalId, title);
}

/** scaffoldが無ければ生成する。生成したら true、既存なら false */
export function scaffoldDesignDoc(root: string, goalId: string, title: string): boolean {
  try {
    const p = planPath(root, goalId);
    if (existsSync(p)) return false;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, designTemplate(goalId, title), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 決定の経緯・棄却した代替案・進捗を追記するログ（design docとは別物、追記専用・ハードゲート無し）。
 * design_gate_allow の prefix (`.graphhopper/plans/`) に含まれるため、designing中も常時書き込み可能。 */
export function planLogPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.log.md`);
}

/** goal 開始時の会話から作る意図ログの path（design g-mwebh9vl） */
export function intentPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.intent.md`);
}

export function planLogExists(root: string, goalId: string): boolean {
  return existsSync(planLogPath(root, goalId));
}

export type HistoryEvent =
  | {
      type: "goal_start";
      goal: string;
      title: string;
      strong?: boolean;
      /** 直前の入口判定（decisions.jsonl の decide 行）の id。判定と結果の突き合わせ用（g-mwn9al7r） */
      decision_id?: string | null;
    }
  | {
      /* 難易度の昇格（design g-mwjsd3om 判断6）。implementing 遷移時に design の
       * 「決めたこと」から再判定して hard に上げた事実を残す（後から精度を数える） */
      type: "difficulty_upgraded";
      goal: string;
      from: Difficulty | null;
      to: Difficulty;
      confidence: number | null;
      source: string;
    }
  | { type: "goal_pause"; goal: string }
  | { type: "goal_resume"; goal: string }
  /* 状態ファイルが「在るのに読めない」の検知（g-mwoernih）。1 プロセス 1 ファイル 1 回だけ記録する */
  | { type: "state_unreadable"; file: string }
  | { type: "cascade_switch"; goal: string; from: string; to: string; phase: Phase; reason: string }
  | {
      type: "guard_pause";
      goal: string;
      reason: "rounds" | "stalls" | "wait" | "restart" | "stuck_again";
      rounds: number;
      stalls: number;
    }
  | {
      type: "goal_conflict";
      goal: string;
      reason: string;
    }
  | {
      type: "cascade_checkpoint";
      goal: string;
      stage: "requested" | "reviewing" | "done";
      reason: string;
    }
  | {
      type: "usability_verdict";
      goal: string;
      level: "clean" | "drift" | "skipped";
      files: string[];
      reason: string;
    }
  | {
      type: "goal_complete";
      goal: string;
      score?: number | null;
      /** force で完了したか（design g-mwd3n5bo） */
      forced?: boolean;
      /** 差分ゲートの結果。unavailable＝ハッシュが取れずゲート不能 */
      diff_gate?: "ok" | "forced" | "unavailable";
   
      /** complete 時点の実効ゲート（observe で通ったものも含む） */
      gates?: { mode: GateMode; gate: GateName; observed: boolean }[];
    }
  | { type: "phase"; goal: string; from: Phase; to: Phase; notes?: string }
  | {
      type: "router_check";
      goal: string;
      diff_lines: number;
      route: RouterRoute;
      deep?: boolean;
      deep_reason?: string | null;
    }
  | {
      type: "verifier_verdict";
      goal: string;
      level: VerdictLevel;
      target: DriftTarget | null;
      lens: VerifierLens[];
      /** 角度ごとの level と前回の指摘の判定（design g-mwmqmg6b 判断8） */
      angles?: { lens: string; level: VerdictLevel; prior?: { valid: number; invalid: number; unresolved: number } }[];
      model?: string | null;
      /** lens並列の実行モデル（混成run用。旧eventは欠測→[model] fallback） */
      models?: (string | null)[];
    }
  | {
      /* 差し戻しの回数が上限に達して pause した（design g-mwoxgpsa）。
       * 角度ごとの回数は再開前の分も含めた累計 */
      type: "verify_cap";
      goal: string;
      count: number;
      max: number;
      by_lens: { lens: string; count: number }[];
    }
  | {
      /* complete ゲートを observe で通した（design g-mwmnvx3x 判断3） */
      type: "complete_gate_observe";
      goal: string;
      gate: GateName;
      reason: string;
    }
  | {
      /* goal 開始時の採点基準の凍結結果（design g-mwmnvx3x 判断1） */
      type: "rubric_frozen";
      goal: string;
      hash: string;
    }
  | { type: "rubric_snapshot_failed"; goal: string }
  | { type: "rubric_changed"; goal: string }
  | {
      type: "angles_selected";
      goal: string;
      angles: { id: string; source: string; carried: boolean }[];
    }
  | { type: "angle_select_failed"; goal: string; reason: string }
  | {
      type: "invoke";
      goal: string;
      agent: string;
      model: string | null;
      timed_out: boolean;
      cancelled: boolean;
      /** 無応答で打ち切ったあと同じセッションから答えを回収できたか */
      salvage?: boolean;
      /** 無応答で打ち切ったあと別モデルでやり直したか */
      restart?: boolean;
      /** 実測の所要ミリ秒（較正用） */
      elapsed_ms?: number;
    }
  | { type: "angle_followup"; goal: string; carried: boolean; level: VerdictLevel | "unknown" }
  | { type: "verifier_self_modified"; goal: string; code: boolean; agent: boolean }
  | { type: "config_invalid_gate"; goal: string; gate: string }
  | { type: "severity_inconsistent"; goal: string; must_fix: number }
  | { type: "design_gate_block"; goal: string; tool: string; path: string }
  | {
      type: "design_doc_locked_block";
      goal: string;
      tool: string;
      path: string;
    }
  | {
      type: "attempt";
      goal: string;
      ok: boolean;
      fail_streak: number;
      note: string;
    }
  | { type: "eval_set"; goal: string; cmd: string }
  | { type: "eval_run"; goal: string; ok: boolean; fail_streak: number }
  | {
      /* 進捗タスクの変更記録。done/cancel は自己申告だが監査に残す
       *（cancel は reason 必須。progress lens が理由の妥当性を検証する） */
      type: "todo_update";
      goal: string;
      id: string;
      from: TodoStatus | null;
      to: TodoStatus;
      reason?: string;
      /** add 時のタスク本文（reason とは別枠） */
      text?: string;
    }
  | {
      /* 進捗ストアが読めず polish への遷移を拒否した記録。
       * 型名は旧 seed 時代のまま（既存の履歴を読めるように変えない） */
      type: "todo_seed_warning";
      goal: string;
      reason: string;
    }
  | { type: "eval_gave_up"; goal: string; fail_streak: number }
  | { type: "stuck_hint"; goal: string; reasons: string[] }
  | {
      type: "loop_detected";
      goal: string;
      kind: LoopKind;
      streak: number;
      stopped: boolean;
    }
  | { type: "loop_stopped"; goal: string; count: number }
  | { type: "loop_resume_forced"; goal: string }
  | { type: "continuation_skipped"; goal: string; marker: string }
  | { type: "hash_edit_applied"; goal: string; path: string }
  | {
      type: "hash_edit_refused";
      goal: string;
      path: string;
      reason: string;
    }
  | {
      /* 入口判定の受け渡し（design g-mwj6481n 判断5）。**旧記録の読み取り用**。
       * g-mwn9al7r で案内そのものをやめたため、新しくは出さない */
      type: "entry_verdict_delivery";
      sessionID: string;
      outcome: "injected" | "skipped" | "late" | "error";
      waited_ms: number;
      route: string | null;
    }
  | {
      /* phase案内（instructions.entry）の同期失敗（design g-mwj6481n 判断8）。
       * 失敗時は tool 応答と継続メッセージで全文を渡す経路に切り替わる */
      type: "phase_guide_sync";
      sessionID: string;
      ok: boolean;
      error?: string;
    }
  | {
      /* 改善ループ用per-goal集計行。complete時にgoal_completeと2行1appendで同時書き込み。
       * 全てhistory由来の機械事実。欠測はnull。last-write集計 */
      type: "goal_summary";
      goal: string;
      title: string;
      duration_s: number | null;
      router_route: RouterRoute | null;
      diff_lines: number | null;
      lenses: VerifierLens[];
      verdict_level: VerdictLevel | null;
      verdict_target: DriftTarget | null;
      max_fail_streak: number;
      rewinds: number;
      verifier_rounds: number;
      score: number | null;
    };

/** append-only の履歴ログ。LLMの自己申告ではなくplugin機械記録の監査証跡 */
export function recordEvent(root: string, event: HistoryEvent): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const record = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(historyPath(root), line, "utf8");
    writeOutbox(root, record);
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

/* ================================================================== *
 * outbox（durable通知）: プログラムが受け取れる完了・異常通知。
 * 会話上の「終わったよ」ではなくファイルで受け取る。watcher試作が読む。
 * curated種別のみ投下し、上限超は古いものから刈る。失敗しても本線を壊さない。
 * ================================================================== */

const OUTBOX_KEEP = 100;

/** outboxに投下する種別（完了・集計・drift・諦め・停止のみ。attempt等の高頻度は対象外） */
const OUTBOX_EVENTS: ReadonlySet<string> = new Set([
  "goal_complete",
  "goal_summary",
  "verifier_verdict",
  "eval_gave_up",
  "loop_stopped",
]);

function outboxPath(root: string): string {
  return join(dir(root), "outbox");
}

function writeOutbox(
  root: string,
  record: { ts: string; type: string; goal?: unknown },
): void {
  try {
    if (!OUTBOX_EVENTS.has(record.type)) return;
    mkdirSync(outboxPath(root), { recursive: true });
    const stamp = record.ts.replace(/[:.]/g, "-");
    const goal = typeof record.goal === "string" ? record.goal : "nogoal";
    writeFileSync(
      join(outboxPath(root), `${stamp}-${record.type}-${goal}.json`),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
    const files = readdirSync(outboxPath(root))
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - OUTBOX_KEEP))) {
      try {
        unlinkSync(join(outboxPath(root), f));
      } catch {
        // 刈り取り失敗は無視
      }
    }
  } catch {
    // outbox失敗で本線を壊さない
  }
}

/* 直近の正常値をプロセス内で覚える（同時書き換えとのrace対策）。
 * 書込み途中の壊れJSONを読んだ場合、記憶があればそれを返し、
 * 全agentモデル欠落（子の親main継承）を防ぐ。初回から壊れていたらfallback */
const lastGoodJson = new Map<string, unknown>();
/** 読めたかどうかも返す内部版。「在るのに読めない」を fallback と区別するために使う
 * （g-mwoernih）。missing=ファイルが無い / ok=読めた / recovered=壊れているが記憶値あり /
 * unreadable=在るのに読めず、このプロセスで一度も読めていない */
function readJsonCore<T>(
  path: string,
  fallback: T,
  shapeOk?: (v: unknown) => boolean,
): { value: T; status: "missing" | "ok" | "recovered" | "unreadable" } {
  if (!existsSync(path)) return { value: fallback, status: "missing" };
  let parsed: unknown;
  let readable = true;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    readable = false;
  }
  if (readable && shapeOk && !shapeOk(parsed)) readable = false;
  if (readable) {
    // 呼び出し側の変更から守るため複製を記憶する（返却値は毎回freshなparse結果）
    lastGoodJson.set(path, structuredClone(parsed));
    return { value: parsed as T, status: "ok" };
  }
  const remembered = lastGoodJson.get(path) as T | undefined;
  return remembered === undefined
    ? { value: fallback, status: "unreadable" }
    : { value: remembered, status: "recovered" };
}

export function readJson<T>(path: string, fallback: T): T {
  return readJsonCore(path, fallback).value;
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** 文字列配列の和集合（順序保持・重複除去・空は undefined）。
 * config の deny 合成で使う（design g-mw8qwiy6 判断2） */
function unionStrings(a?: unknown, b?: unknown): string[] | undefined {
  const pick = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const merged = [...new Set([...pick(a), ...pick(b)])];
  return merged.length > 0 ? merged : undefined;
}

export function readConfig(root: string): GraphhopperConfig {
  // グローバル既定 < プロジェクト上書き。agents だけは name 単位でマージする
  // （プロジェクト側で一部の subagent だけ別モデルに差し替えられるように）。
  const global = readJson<Partial<GraphhopperConfig>>(globalConfigPath(), {});
  const project = readJson<Partial<GraphhopperConfig>>(configPath(root), {});
  const raw: Partial<GraphhopperConfig> = {
    ...global,
    ...project,
    agents: { ...(global.agents ?? {}), ...(project.agents ?? {}) },
    // モデル制限は非対称に合成する（design g-mw8qwiy6 判断2）:
    // deny は和集合（禁止は単調に強くし、project の空配列で外せない）、
    // allow は project 置き換え（和集合は制限を緩める方向に働くため）。
    model_deny: unionStrings(global.model_deny, project.model_deny),
  };
  const stuck_threshold =
    raw.stuck_threshold ?? DEFAULT_CONFIG.stuck_threshold;
  const maxRaw = raw.max_eval_fails ?? DEFAULT_CONFIG.max_eval_fails;
  const gates = normalizeGates(raw.gates);
  return {
    gates: gates.modes,
    router_threshold_lines:
      raw.router_threshold_lines ?? DEFAULT_CONFIG.router_threshold_lines,
    design_gate_allow:
      raw.design_gate_allow ?? DEFAULT_CONFIG.design_gate_allow,
    agents: { ...(DEFAULT_CONFIG.agents ?? {}), ...(raw.agents ?? {}) },
    model_allow: raw.model_allow,
    model_deny: raw.model_deny,
    stuck_threshold,
    loop_stop_threshold:
      raw.loop_stop_threshold ?? DEFAULT_CONFIG.loop_stop_threshold,
    loop_stop_max: raw.loop_stop_max ?? DEFAULT_CONFIG.loop_stop_max,
    loop_max_rounds: raw.loop_max_rounds ?? DEFAULT_CONFIG.loop_max_rounds,
    loop_max_stalls: raw.loop_max_stalls ?? DEFAULT_CONFIG.loop_max_stalls,
    loop_wait_limit_ms:
      raw.loop_wait_limit_ms ?? DEFAULT_CONFIG.loop_wait_limit_ms,
    verify_drift_max:
      raw.verify_drift_max ?? DEFAULT_CONFIG.verify_drift_max,
    loop_restart_pause:
      raw.loop_restart_pause ?? DEFAULT_CONFIG.loop_restart_pause,
    loop_tool_window:
      raw.loop_tool_window ?? DEFAULT_CONFIG.loop_tool_window,
    loop_tool_repeat_threshold:
      raw.loop_tool_repeat_threshold ??
      DEFAULT_CONFIG.loop_tool_repeat_threshold,
    // 相談 (stuck) より諦め (giveUp) が先に発火しないよう下限を揃える
    max_eval_fails: maxRaw <= 0 ? maxRaw : Math.max(maxRaw, stuck_threshold),
    stuck_edit_repeat:
      raw.stuck_edit_repeat ?? DEFAULT_CONFIG.stuck_edit_repeat,
    stuck_diff_stall:
      raw.stuck_diff_stall ?? DEFAULT_CONFIG.stuck_diff_stall,
    lsp_servers: raw.lsp_servers ?? DEFAULT_CONFIG.lsp_servers,
    cascade: {
      ...DEFAULT_CONFIG.cascade,
      ...(raw.cascade ?? {}),
      phase_models: Object.fromEntries(
        Object.entries({
          ...(global.cascade?.phase_models ?? {}),
          ...(project.cascade?.phase_models ?? {}),
        }).filter(([, v]) => typeof v === "string" && v.trim()),
      ),
      agents: {
        apply:
          (project.cascade?.agents?.apply ?? global.cascade?.agents?.apply) === "escalated"
            ? "escalated"
            : "always",
        // 後方互換: 旧 `cascade.agents.escalate` は `quality` として読む
        quality: {
          ...DEFAULT_CONFIG.cascade.agents.quality,
          ...(global.cascade?.agents?.escalate ?? {}),
          ...(global.cascade?.agents?.quality ?? {}),
          ...(project.cascade?.agents?.escalate ?? {}),
          ...(project.cascade?.agents?.quality ?? {}),
        },
      },
    },
  };
}

export function readGoals(root: string): GoalsFile {
  return readJsonCore<GoalsFile>(
    goalsPath(root),
    { goals: [], active: null },
    isGoalsShape,
  ).value;
}

/** goals.json の形（goals が配列）。壊れた形を「goal なし」と取り違えないための検査 */
function isGoalsShape(v: unknown): boolean {
  const o = v as { goals?: unknown } | null;
  return !!o && typeof o === "object" && !Array.isArray(o) && Array.isArray(o.goals);
}

/** state.json の形（オブジェクト）。配列や null は壊れた扱い */
function isStateShape(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** goals.json / state.json のうち「在るのに読めない」もののパス一覧（無ければ空）。
 * 「ファイルが無い（= goal なし）」と「読めない」を区別する。同じプロセスで一度読めていれば
 * 記憶値で動けるので、これにも含めない（g-mwoernih 決めたこと1） */
export function unreadableStateFiles(root: string): string[] {
  const bad: string[] = [];
  if (readJsonCore<unknown>(goalsPath(root), null, isGoalsShape).status === "unreadable") {
    bad.push(goalsPath(root));
  }
  if (readJsonCore<unknown>(statePath(root), null, isStateShape).status === "unreadable") {
    bad.push(statePath(root));
  }
  return bad;
}

const unreadableReported = new Set<string>();

/** 読めない状態ファイルの説明（無ければ null）。history へは 1 プロセス 1 ファイル 1 回だけ記録する。
 * ツール応答・会話への通知の単一源泉（g-mwoernih 決めたこと4） */
export function unreadableStateNotice(root: string): string | null {
  const files = unreadableStateFiles(root);
  if (files.length === 0) return null;
  for (const f of files) {
    if (unreadableReported.has(f)) continue;
    unreadableReported.add(f);
    recordEvent(root, { type: "state_unreadable", file: f });
  }
  const names = files.map((f) => basename(f)).join(" / ");
  return (
    `error: graphhopper の状態ファイル（${names}）が壊れていて読めません（「goal なし」ではありません）。` +
    "このまま書き込むと goal 一覧や検証の記録が消えるため、書き込みを止めています。" +
    "自動の退避・作り直しはしません。ファイルを直すか削除してから続けてください。"
  );
}

function emptyState(): LoopState {
  return {
    goal_id: null,
    session_id: null,
    phase: "designing",
    notes: "",
    router: {
      baseline_rev: null,
      diff_lines: null,
      route: null,
      checked_at: null,
      deep: false,
      deep_reason: null,
    },
    last_verifier: null,
    fail_streak: 0,
    eval_cmd: null,
    last_continuation_marker: null,
    last_eval_fingerprint: null,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
    verify_drift_count: 0,
    edit_file: null,
    edit_streak: 0,
    last_diff_lines: null,
    diff_stall: 0,
    last_stuck_reasons: [],
    difficulty: null,
    decision_id: null,
    cascade: null,
    guard: {
      rounds: 0,
      stalls: 0,
      progress_key: null,
      stuck_key: null,
      wait_since: null,
      pending: false,
      boot: null,
    },
    initial_diff_lines: null,
    initial_diff_files: null,
    stash_diff_hash: null,
    intent_path: null,
    usability_review: null,
    start_baseline_rev: null,
    baseline_source: null,
    gate_modes: null,
    rubric_hash: null,
    strong_mode: false,
    updated_at: new Date().toISOString(),
  };
}

export function readState(root: string): LoopState {
  const loaded = readJsonCore<Partial<LoopState>>(
    statePath(root),
    emptyState(),
    isStateShape,
  ).value;
  const merged: LoopState = {
    ...emptyState(),
    ...loaded,
    router: { ...emptyState().router, ...(loaded.router ?? {}) },
  };
  // 旧形式（children を持たない cascade）を正規化する。readState 後に [...cascade.children] を
  // 広げる箇所が壊れないよう children 配列を必ず用意する
  if (merged.cascade) {
    merged.cascade = { ...merged.cascade, children: merged.cascade.children ?? [] };
  }
  merged.guard = { ...emptyState().guard, ...(loaded.guard ?? {}) };
  // 破損 state.json の未知 phase は designing にフォールバックする。
  // 未検証のまま通すと PHASE_ACTION[phase] 参照が undefined になる。
  if (!(PHASES as readonly string[]).includes(merged.phase)) {
    merged.phase = "designing";
  }
  return merged;
}

/** 読めないファイルは上書きしない（goal 一覧・検証記録の消失防止。g-mwoernih 決めたこと2）。
 * 「壊れているが記憶値がある」は従来どおり書ける（書込み途中の壊れ対策を維持する） */
function assertWritableStateFile(path: string, shapeOk: (v: unknown) => boolean): void {
  if (readJsonCore<unknown>(path, null, shapeOk).status !== "unreadable") return;
  throw new Error(
    `Refused: ${path} exists but cannot be parsed and this process has no earlier good read, ` +
      "so it was left untouched to avoid losing goals / verifier state. " +
      "Fix or remove the file, then retry.",
  );
}

function writeGoals(root: string, data: GoalsFile): void {
  assertWritableStateFile(goalsPath(root), isGoalsShape);
  atomicWrite(goalsPath(root), data);
}

function writeState(root: string, state: LoopState): void {
  assertWritableStateFile(statePath(root), isStateShape);
  state.updated_at = new Date().toISOString();
  atomicWrite(statePath(root), state);
}

export interface ActiveLoop {
  goal: Goal;
  state: LoopState;
}

/** active な goal と state の組を返す。無ければ null */
export function getActive(root: string): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  return { goal, state: readState(root) };
}

export function startGoal(
  root: string,
  title: string,
  sessionID: string,
  opts?: { strong?: boolean; difficulty?: Difficulty | null },
): ActiveLoop {
  const goals = readGoals(root);
  const goal: Goal = {
    id: `g-${Date.now().toString(36)}`,
    title,
    status: "active",
    created_at: new Date().toISOString(),
    done_at: null,
  };
  for (const g of goals.goals) {
    if (g.status === "active") g.status = "paused";
  }
  goals.goals.push(goal);
  goals.active = goal.id;
  writeGoals(root, goals);

  const next: LoopState = {
    ...emptyState(),
    goal_id: goal.id,
    session_id: sessionID,
    strong_mode: opts?.strong === true,
  };
  /* decision_id は「このセッションの成功 decide」に結ぶ。グローバルな last_decision は
   * 他セッションの依頼を拾うことがあり、d1 障害中は特に誤結合になる */
  next.decision_id = sessionID
    ? readSessionDecisionId(root, sessionID)
    : readLastDecisionId(root);
  /* 難易度は start 時の題の判定（judgeGoalDifficulty）。無ければ null＝未判定 */
  next.difficulty = opts?.difficulty ?? null;
  writeState(root, next);
  recordEvent(root, {
    type: "goal_start",
    goal: goal.id,
    title: goal.title,
    ...(opts?.strong === true ? { strong: true } : {}),
    decision_id: next.decision_id,
  });
  // design scaffold: 骨格を自動生成（既存があれば壊さない）。
  // 構造検証ゲートのアンカーになる
  scaffoldDesignDoc(root, goal.id, goal.title);
  return { goal, state: next };
}

function mutateActive(
  root: string,
  fn: (
    goal: Goal,
    state: LoopState,
  ) => Partial<{ goal: Partial<Goal>; state: Partial<LoopState> }>,
): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  const state = readState(root);
  const patch = fn(goal, state);
  if (patch.goal) Object.assign(goal, patch.goal);
  if (patch.state) Object.assign(state, patch.state);
  writeGoals(root, goals);
  writeState(root, state);
  return { goal, state };
}

export function pauseGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, (goal, state) => ({
    // pause時にgoal固有文脈をスナップショットする。単一LoopStateを使い回すため、
    // 別goalが走った後のresumeでphase/router/verifierが漏れる事故を防ぐ
    goal: {
      status: "paused",
      paused_snapshot: {
        phase: state.phase,
        router: state.router,
        last_verifier: state.last_verifier,
        eval_cmd: state.eval_cmd,
        notes: state.notes,
        initial_diff_lines: state.initial_diff_lines,
        initial_diff_files: state.initial_diff_files,
        intent_path: state.intent_path,
        usability_review: state.usability_review,
        start_baseline_rev: state.start_baseline_rev,
        baseline_source: state.baseline_source,
        gate_modes: state.gate_modes,
        rubric_hash: state.rubric_hash,
        strong_mode: state.strong_mode,
      },
    },
    // 人間による明示的な操作なのでloop停止フラグも解除（pause自体が駆動を止める）
    state: { loop_streak: 0, loop_stopped: false },
  }));
  if (r) recordEvent(root, { type: "goal_pause", goal: r.goal.id });
  return r;
}

export function resumeGoal(
  root: string,
  sessionID: string,
  force = false,
): ActiveLoop | null {
  // 恒久ブロック: loop_stop_max に達したら通常resumeを拒否（forceで明示解除のみ）
  if (isResumeBlocked(root) && !force) return null;
  /* 停止時と同じ状態のまま再開していないか、次の継続判定で見る（design g-mwokteud） */
  const stuckKey = readState(root).guard.stuck_key ?? null;
  const r = mutateActive(root, (goal) => {
    const snap = goal.paused_snapshot;
    return {
      goal: { status: "active" },
      // pause→人間修正→resume の運用で eval リトライ・stuck 信号を数え直すため
      // fail_streak・stuck系も戻す（loop 停止からの resume でも escalate は再カウント）。
      // loop_stop_count（恒久ブロック予算）は維持する
      state: {
        goal_id: goal.id,
        session_id: sessionID,
        loop_streak: 0,
        loop_stopped: false,
        fail_streak: 0,
        /* 差し戻しの数の数え直し（design g-mwoxgpsa）。再開後にまた上限まで差し戻されたら止める */
        verify_drift_count: 0,
        edit_file: null,
        edit_streak: 0,
        last_diff_lines: null,
        diff_stall: 0,
        stash_diff_hash: null,
        last_stuck_reasons: [],
        // 上限ガードは数え直す（loop_stop_count の恒久予算は維持）
        guard: {
          rounds: 0,
          stalls: 0,
          progress_key: null,
          stuck_key: force ? null : stuckKey,
          wait_since: null,
          pending: false,
          boot: null,
        },
        // 別goalが走った後のresumeでも自goalの文脈に戻す（snapshotが無ければ現状維持）
        ...(snap
          ? {
              phase: snap.phase,
              router: snap.router,
              last_verifier: snap.last_verifier,
              eval_cmd: snap.eval_cmd,
              notes: snap.notes,
              // 旧snapshot（field無し）→null＝legacy扱い
              initial_diff_lines: snap.initial_diff_lines ?? null,
              initial_diff_files: snap.initial_diff_files ?? null,
              intent_path: snap.intent_path ?? null,
              usability_review: snap.usability_review ?? null,
              start_baseline_rev: snap.start_baseline_rev ?? null,
              baseline_source: snap.baseline_source ?? null,
              gate_modes: snap.gate_modes ?? null,
              rubric_hash: snap.rubric_hash ?? null,
              strong_mode: snap.strong_mode ?? false,
            }
          : {}),
      },
    };
  });
  if (r) {
    recordEvent(root, { type: "goal_resume", goal: r.goal.id });
    if (force) {
      // 人間の判断を監査証跡に残す（カウンタは保持するため履歴は残る）
      recordEvent(root, { type: "loop_resume_forced", goal: r.goal.id });
    }
  }
  return r;
}

export function completeGoal(
  root: string,
  opts?: {
    forced?: boolean;
    diff_gate?: "ok" | "forced" | "unavailable";
    /** 実効ゲート（observe で通したものも残す。design g-mwmnvx3x 判断3） */
    gates?: { mode: GateMode; gate: GateName; observed: boolean }[];
  },
): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "done", done_at: new Date().toISOString() },
    state: {
      phase: "done",
      loop_streak: 0,
      loop_stopped: false,
      strong_mode: false,
    },
  }));
  if (r) {
    // complete時の機械採点（B）。式v1: 100 - 15*巻き戻し - 5*最大fail - 3*gate阻止 - 5*(verifier追加round)。下限0
    const score = computeGoalScore(root, r.goal.id);
    const goals = readGoals(root);
    const g = goals.goals.find((x) => x.id === r.goal.id);
    if (g) {
      g.score = score;
      writeGoals(root, goals);
    }
    r.goal.score = score;
    // goal_complete＋goal_summaryの2行1append（片側欠けの窓を1箇所に限定）
    recordEventBatch(root, [
      {
        type: "goal_complete",
        goal: r.goal.id,
        score: score.value,
        ...(opts?.forced ? { forced: true } : {}),
        ...(opts?.diff_gate ? { diff_gate: opts.diff_gate } : {}),
        ...(opts?.gates?.length ? { gates: opts.gates } : {}),
      },
      buildGoalSummary(root, r.goal.id, { score: score.value }),
    ]);
    // diff退避を掃除（.graphhopper/tmp。蓄積＋古いpath誤読の防止）
    removeStashedDiff(root, r.goal.id);
    removeDiag(root, r.goal.id);
    removeVerifyResults(root, r.goal.id);
    archiveGoalFiles(root, r.goal.id);
  }
  return r;
}

/** 完了 goal の todos/plans を archive/ へ移す（削除しない＝事後に cancel 理由を確認できる） */
export function archiveGoalFiles(root: string, goalId: string): void {
  const pairs: [string, string][] = [
    [todosPath(root, goalId), join(dirname(todosPath(root, goalId)), "archive", `${goalId}.json`)],
  ];
  for (const ext of [".md", ".log.md", ".intent.md", ".rubric.json"]) {
    const src = join(dirname(planPath(root, goalId)), `${goalId}${ext}`);
    pairs.push([src, join(dirname(src), "archive", `${goalId}${ext}`)]);
  }
  for (const [src, dst] of pairs) {
    try {
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
    } catch {
      // 移せなくても完了処理は止めない
    }
  }
}

/** goal出来栄えの機械採点。history由来の機械事実のみで計算し、人手採点はしない（v1）。
 * 内訳を残すため式の調整はこの関数のみ変える */
export function computeGoalScore(root: string, goalId: string): GoalScore {
  let rewinds = 0;
  let maxFailStreak = 0;
  let gateBlocks = 0;
  let verifierRounds = 0;
  for (const h of readHistory(root)) {
    if ((h as { goal?: unknown }).goal !== goalId) continue;
    switch (h.type) {
      case "phase":
        if (h.from === "polish" && h.to === "implementing") rewinds += 1;
        break;
      case "attempt":
        if (h.fail_streak > maxFailStreak) maxFailStreak = h.fail_streak;
        break;
      case "design_gate_block":
      case "design_doc_locked_block":
        gateBlocks += 1;
        break;
      case "verifier_verdict":
        verifierRounds += 1;
        break;
      default:
        break;
    }
  }
  const breakdown = {
    rewinds,
    maxFailStreak,
    gateBlocks,
    verifierRounds,
  };
  const value = Math.max(
    0,
    100 - 15 * rewinds - 5 * maxFailStreak - 3 * gateBlocks - 5 * Math.max(0, verifierRounds - 1),
  );
  return { value, breakdown };
}

/* 複数eventの一括追記（goal_complete＋goal_summaryの2行1append用。
 * 片側欠けの窓を1箇所に限定する。失敗時は握りつぶす＝本線を壊さない） */
export function recordEventBatch(root: string, events: HistoryEvent[]): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const now = new Date().toISOString();
    const records = events.map((e) => ({ ts: now, ...e }));
    appendFileSync(
      historyPath(root),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    for (const r of records) writeOutbox(root, r);
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

/** goal_summary行（ts付き。buildTelemetryの要素型） */
export type GoalSummaryRecord = Extract<
  HistoryEvent,
  { type: "goal_summary" }
> & { ts?: string };

/* per-goal集計の構築（history走査。computeGoalScoreと同型）。
 * last-write集計。
 * 未complete・pause中にも呼べる（durationはnow基準。欠測はnull） */
export function buildGoalSummary(
  root: string,
  goalId: string,
  opts?: { score?: number | null; now?: string },
): Extract<HistoryEvent, { type: "goal_summary" }> {
  const now = opts?.now ?? new Date().toISOString();
  let title = "(unknown)";
  let startTs: string | null = null;
  let routerRoute: RouterRoute | null = null;
  let diffLines: number | null = null;
  let lenses: VerifierLens[] = [];
  let verdictLevel: VerdictLevel | null = null;
  let verdictTarget: DriftTarget | null = null;
  let maxFail = 0;
  let rewinds = 0;
  let verifierRounds = 0;
  for (const h of readHistory(root)) {
    if ((h as { goal?: unknown }).goal !== goalId) continue;
    switch (h.type) {
      case "goal_start":
        if (startTs === null) {
          startTs = h.ts ?? null;
          title = h.title;
        }
        break;
      case "router_check":
        routerRoute = h.route;
        diffLines = h.diff_lines;
        break;
      case "verifier_verdict":
        lenses = h.lens;
        verdictLevel = h.level;
        verdictTarget = h.target;
        verifierRounds += 1;
        break;
      case "attempt":
      case "eval_run":
        if (h.fail_streak > maxFail) maxFail = h.fail_streak;
        break;
      case "phase":
        if (h.from === "polish" && h.to === "implementing") rewinds += 1;
        break;
      default:
        break;
    }
  }
  const duration =
    startTs === null ? NaN : (Date.parse(now) - Date.parse(startTs)) / 1000;
  return {
    type: "goal_summary",
    goal: goalId,
    title,
    duration_s:
      Number.isNaN(duration) || duration < 0 ? null : Math.round(duration),
    router_route: routerRoute,
    diff_lines: diffLines,
    lenses,
    verdict_level: verdictLevel,
    verdict_target: verdictTarget,
    max_fail_streak: maxFail,
    rewinds,
    verifier_rounds: verifierRounds,
    score: opts?.score ?? null,
  };
}

/* 改善ループ（reflect）の入力となるgoal行集計。
 * goal_summary行を返し、欠落分（既存complete＝backfill兼用）はhistoryから再合成する */
export function buildTelemetry(root: string): GoalSummaryRecord[] {
  const summaries = new Map<string, GoalSummaryRecord>();
  const completed = new Map<string, { score: number | null; ts?: string }>();
  for (const h of readHistory(root)) {
    const g = (h as { goal?: unknown }).goal;
    if (typeof g !== "string") continue;
    if (h.type === "goal_summary") summaries.set(g, h);
    else if (h.type === "goal_complete" && !completed.has(g)) {
      completed.set(g, {
        score: (h as { score?: number | null }).score ?? null,
        ts: h.ts,
      });
    }
  }
  const out = [...summaries.values()];
  for (const [g, c] of completed) {
    // backfill再合成はgoal_completeのtsをnowに使う（クエリ時刻依存の不安定値を避ける）
    if (!summaries.has(g))
      out.push(buildGoalSummary(root, g, { score: c.score, now: c.ts }));
  }
  out.sort((a, b) => (a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0));
  return out;
}

/** clear 専用: goal を done 化するが `goal_complete` イベントは記録しない
 * （clear は完了ではなく破棄のため、監査ログに完了として残さない）。
 * done 化自体（status/done_at）は維持し、`active` からは外す。
 * loop カウンタは0に戻し、phase は designing に戻す（phase イベントも記録しない）。 */
export function clearActiveGoal(root: string): Goal | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  goal.status = "done";
  goal.done_at = new Date().toISOString();
  goals.active = null;
  writeGoals(root, goals);
  // diff退避を掃除（completeGoalと同型）
  removeStashedDiff(root, goal.id);
  removeDiag(root, goal.id);
  removeVerifyResults(root, goal.id);
  const s = readState(root);
  writeState(root, {
    ...s,
    phase: "designing",
    notes: "",
    fail_streak: 0,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
    strong_mode: false,
  });
  return goal;
}

/** clear 専用の loop 全リセット（completeGoal はカウンタを保持するので分離） */
export function resetLoopForClear(root: string): void {
  const state = readState(root);
  writeState(root, {
    ...state,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
  });
}

/** 直近の decide の id（decide が書き、goal start が拾う）。鮮度は10分 */
export function writeLastDecisionId(root: string, id: string): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    writeFileSync(join(dir(root), "last_decision.json"), JSON.stringify({ id, at: Date.now() }));
  } catch {
    // 較正用。失敗しても本体を止めない
  }
}

export function readLastDecisionId(root: string): string | null {
  try {
    const p = JSON.parse(readFileSync(join(dir(root), "last_decision.json"), "utf8")) as { id?: string; at?: number };
    if (typeof p.id !== "string" || typeof p.at !== "number") return null;
    return Date.now() - p.at <= 10 * 60_000 ? p.id : null;
  } catch {
    return null;
  }
}

/** セッションの直近の成功 decide 行の id（fallback は除く。5 分窓）。
 * goal の decision_id を「そのセッションの依頼」に結ぶために使う。
 * d1 障害中は null を返す＝誤った decide に紐付けない。 */
export function readSessionDecisionId(
  root: string,
  sessionID: string,
): string | null {
  if (!sessionID) return null;
  const path = join(dir(root), "decisions.jsonl");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - 256 * 1024);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const cutoff = Date.now() - 5 * 60_000; /* 直近 5 分の decide だけを拾う */
    let found: string | null = null;
    for (const l of buf.toString("utf8").split("\n")) {
      if (!l) continue;
      let r: { kind?: string; id?: string; sessionID?: string; ts?: string; fallback?: boolean };
      try {
        r = JSON.parse(l) as typeof r;
      } catch {
        continue; // 先頭が切れた行は無視
      }
      if (r.kind !== "decide" || !r.id || r.fallback === true) continue;
      if (r.sessionID !== sessionID) continue;
      const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      found = r.id;
    }
    return found;
  } catch {
    return null;
  }
}

/** 難易度を書き換える（implementing 遷移の再判定用。design g-mwjsd3om 判断6） */
export function setDifficulty(root: string, difficulty: Difficulty): ActiveLoop | null {
  return mutateActive(root, () => ({ state: { difficulty } }));
}

/** カスケード状態の保存。null でクリア */
export function setCascade(root: string, cascade: CascadeState | null): ActiveLoop | null {
  return mutateActive(root, () => ({ state: { cascade } }));
}

/** implementing 途中確認の段を更新する（cascade が無ければ何もしない） */
export function setCascadeCheckpoint(
  root: string,
  stage: "requested" | "reviewing" | "done",
  reason: string,
): ActiveLoop | null {
  const active = getActive(root);
  if (!active?.state.cascade) return null;
  recordEvent(root, {
    type: "cascade_checkpoint",
    goal: active.goal.id,
    stage,
    reason,
  });
  return mutateActive(root, () => ({
    state: { cascade: { ...active.state.cascade!, checkpoint: stage } },
  }));
}

/** 子セッションの切替記録を積む（古い順・最大10件） */
export function appendCascadeChild(root: string, child: CascadeChild): ActiveLoop | null {
  const active = getActive(root);
  if (!active) return null;
  const base: CascadeState = active.state.cascade ?? {
    level: "baseline",
    reason: "",
    model: null,
    restore: null,
    children: [],
    at: new Date().toISOString(),
  };
  const children = [...(base.children ?? []), child].slice(-10);
  return mutateActive(root, () => ({ state: { cascade: { ...base, children } } }));
}

/** active goal が無い状態でも cascade だけ消す（終了の途中で落ちて残った孤児の後始末） */
export function clearCascadeState(root: string): void {
  const s = readState(root);
  if (!s.cascade) return;
  writeState(root, { ...s, cascade: null });
}

/* 遷移合法性表（takt workflow doctorの発想の機械版）。
 * - 同一phaseは許可（notes更新等の無遷移呼び出しのため）
 * - polish→implementingのみ巻き戻し可（verifier driftの行き先）
 * - implementing/polish→designingは、決定記録を直す・合意をやり直すときの巻き戻し
 * - *→doneは不可: doneはcompleteGoal（verifier cleanガード付き）のみ。
 *   clearActiveGoalはstate直書きのためこの表の対象外 */
export const LEGAL_TRANSITIONS: Record<Phase, Phase[]> = {
  designing: ["designing", "implementing"],
  implementing: ["implementing", "polish", "designing"],
  polish: ["polish", "implementing", "done", "designing"],
  done: ["done"],
};

export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/* phase遷移時のカウンタリセット集合（setPhase用。
 * 巻き戻し直後のstuck早期発火・fail引き継ぎを防ぐ） */
function phaseResetFields(): Partial<LoopState> {
  return {
    fail_streak: 0,
    edit_file: null,
    edit_streak: 0,
    last_diff_lines: null,
    diff_stall: 0,
    last_stuck_reasons: [],
  };
}

export function setPhase(
  root: string,
  phase: Phase,
  notes?: string,
): ActiveLoop | null {
  return setPhaseChecked(root, phase, notes).active;
}

/**
 * phase 遷移（理由つき）。gate を全部通ったときだけ遷移する。
 *
 * 進捗ゲート（implementing→polish で未完了タスクがある）はここで効く。
 * setPhase だけをゲートすると eval_cmd 通過による自動 polish 遷移
 * （hooks.ts が setPhase を直接呼ぶ）が素通りするため、
 * 遷移の実効点である setPhase 側に置いている。
 */
export function setPhaseChecked(
  root: string,
  phase: Phase,
  notes?: string,
): { ok: boolean; active: ActiveLoop | null; error: string | null } {
  if (!PHASES.includes(phase)) {
    return { ok: false, active: null, error: `未知の phase: ${phase}` };
  }
  const before = getActive(root);
  // 遷移合法性（takt workflow doctorの発想の機械版）。
  // 特に *→done の直指定を塞ぐ: doneはcomplete（verifier cleanガード付き）のみ。
  // setPhase(done)で抜けるとgoalがactiveのままloopだけ止まるself-graded doneの穴になる。
  if (before && !isLegalPhaseTransition(before.state.phase, phase)) {
    return {
      ok: false,
      active: null,
      error:
        `非法遷移 ${before.state.phase} -> ${phase}。` +
        `合法遷移: ${(LEGAL_TRANSITIONS[before.state.phase] ?? []).join(", ")}。`,
    };
  }
  // 進捗ゲート: implementing→polish は未完了タスクを残さない。
  // - ストアが読めない場合は fail-closed（拒否する）。タスク0件だと無言で通ると
  //   進捗の強制点が消えるため、「読めない」と「0件」を区別する。
  // - ストアが空なら通す（進捗タスクは任意の道具。決定記録からは作らない）。
  if (before && before.state.phase === "implementing" && phase === "polish") {
    const loaded = readTodosStatus(root, before.goal.id);
    const storeErr = todoStoreError(loaded);
    if (storeErr) {
      recordEvent(root, {
        type: "todo_seed_warning",
        goal: before.goal.id,
        reason: `polish への遷移を拒否した（fail-closed）: ${storeErr}`,
      });
      return { ok: false, active: null, error: storeErr };
    }
    const store = loaded.store;
    const err = todoGateError(store);
    if (err) return { ok: false, active: null, error: err };
  }
  const r = mutateActive(root, () => ({
    // phaseが変わるたびfail系・stuck系カウンタをリセット
    // （implementingに戻ってきた時も0から数え直す。巻き戻し直後のインフレ防止）
    state: {
      phase,
      ...phaseResetFields(),
      ...(notes !== undefined ? { notes } : {}),
    },
  }));
  if (r && before && before.state.phase !== phase) {
    recordEvent(root, {
      type: "phase",
      goal: r.goal.id,
      from: before.state.phase,
      to: phase,
      ...(notes ? { notes } : {}),
    });
  }
  return { ok: true, active: r, error: null };
}

export function unbindSession(root: string, sessionID: string): void {
  const state = readState(root);
  if (state.session_id !== sessionID) return;
  writeState(root, { ...state, session_id: null });
}

/* ================================================================== *
 * router gate（loop-driver.sh 相当）: diff サイズを機械測定して分岐
 * ================================================================== */
import type { $ as BunShell } from "bun";
type Shell = typeof BunShell;

/** baseline の取得元（goal start の応答と state に残す。design g-mwkgfssi 判断3） */
export type BaselineSource = "jj@" | "git-worktree" | "git-stash" | "git-HEAD";

/** goal 開始時の baseline: **作業コピーそのもの**の commit。
 *
 * jj: `@`（コマンド実行前の自動スナップショット＝未 commit 分を含む）の commit id。
 *     `heads()` はこの jj で引数必須のため使わない（旧実装は常に失敗し git に落ちていた）。
 * git: 未追跡も含めた「今の状態」の commit を一時 index で作る（作業ツリーと実 index は触らない）。
 *     失敗時は `git stash create`、次に HEAD。
 *
 * 実行時のフォールバック（start_baseline_rev が無い legacy goal）は captureBaselineRev を使う。
 * そちらは「最後に commit された状態」を返す（作業コピーを基準にすると差分が常に 0 になる）。
 */
export async function captureStartBaseline(
  shell: Shell,
  root: string,
): Promise<{ rev: string; source: BaselineSource } | null> {
  const run = async (cmd: string): Promise<string | null> => {
    try {
      const r = await shell`sh -c ${cmd}`.cwd(root).nothrow().quiet();
      const out = r.stdout.toString().trim();
      if (r.exitCode !== 0 || !out) return null;
      const rev = out.split("\n")[0] ?? null;
      return rev && isValidBaselineRev(rev) ? rev : null;
    } catch {
      return null;
    }
  };

  /* jj: 作業コピーの commit id（未 commit 分を含む） */
  const jj = await run("jj log -r @ -T commit_id --no-graph");
  if (jj) return { rev: jj, source: "jj@" };

  /* git: 一時 index に全変更（未追跡含む）を載せて commit を作る。
   * GIT_INDEX_FILE を分けるので実 index は変わらない。 */
  const worktree = await run(
    [
      'idx=$(mktemp) || exit 1',
      "GIT_INDEX_FILE=$idx git read-tree HEAD || { rm -f $idx; exit 1; }",
      "GIT_INDEX_FILE=$idx git add -A . || { rm -f $idx; exit 1; }",
      'tree=$(GIT_INDEX_FILE=$idx git write-tree) || { rm -f $idx; exit 1; }',
      "rm -f $idx",
      'git commit-tree "$tree" -p HEAD -m "graphhopper baseline"',
    ].join("; "),
  );
  if (worktree) return { rev: worktree, source: "git-worktree" };

  const stash = await run("git stash create");
  if (stash) return { rev: stash, source: "git-stash" };

  const head = await run("git rev-parse HEAD");
  if (head) return { rev: head, source: "git-HEAD" };
  return null;
}

/** 最後に commit された rev（jj: `@-`、git: HEAD）。start_baseline_rev が無い
 * legacy goal の差分測定に使う。作業コピーを基準にすると差分が常に 0 になるため、
 * goal start では captureStartBaseline を使う（design g-mwkgfssi 判断1・2）。 */
export async function captureBaselineRev(
  shell: Shell,
  root: string,
): Promise<string | null> {
  const run = async (cmd: string): Promise<string | null> => {
    try {
      const r = await shell`sh -c ${cmd}`.cwd(root).nothrow().quiet();
      const out = r.stdout.toString().trim();
      if (r.exitCode !== 0 || !out) return null;
      const rev = out.split("\n")[0] ?? null;
      return rev && isValidBaselineRev(rev) ? rev : null;
    } catch {
      return null;
    }
  };
  const jj = await run("jj log -r '@-' -T commit_id --no-graph");
  if (jj) return jj;
  return run("git rev-parse HEAD");
}

/** baseline_rev の形式検証（jj commit_id / git sha は共に full hex）。
 * VCS由来とはいえ shell 補間に渡す前に検証し、不正なら null 扱いにする。 */
export function isValidBaselineRev(baseline: string): boolean {
  return /^[0-9a-fA-F]+$/.test(baseline);
}

/** deep検知の対象（状態遷移核）。repo相対・正規化済みパスで照合する。
 * 他repoでは一致せずfail-open（deepなし）。判断はstate/gateに閉じる——
 * index.ts の判断に足したらRISKを見直すこと（不変条件） */
export const RISK_PATHS: readonly string[] = ["src/state.ts", "src/gate.ts"];

/** 差分の測定に残す `.graphhopper/` 配下のファイル（人が書き、graphhopper は書かない）。
 * それ以外の `.graphhopper/` は graphhopper の作業ファイル（state.json・history.jsonl・
 * tmp/・plans/ など）で、測定に含めると記録そのものが差分を変えて diff ゲートが止まる
 * （design g-mwiu6lcj）。 */
export const MEASURED_GH_FILES: readonly string[] = [
  ".graphhopper/config.json",
  ".graphhopper/config.example.json",
];

/** jj の fileset（cwd 相対）。`.graphhopper/` を除き、設定だけ残す */
export function ghFileset(): string {
  return `~cwd:".graphhopper" | ${MEASURED_GH_FILES.map((f) => `cwd:"${f}"`).join(" | ")}`;
}

/** git の pathspec（cwd 相対）。`:/\` で測定範囲を従来どおり repo 全体に保ち、`.graphhopper/` を除く */
export function ghAllSpec(): string[] {
  return [":/", ":(exclude).graphhopper"];
}

/** git の pathspec。残す設定は別に取る（exclude したディレクトリの子は同じ pathspec で足せない） */
export function ghKeepSpec(): string[] {
  return [...MEASURED_GH_FILES];
}

/** `git rev-parse --show-prefix` の値（root が repo 直下なら空）。失敗は "" */
async function gitShowPrefix(shell: Shell, root: string): Promise<string> {
  try {
    const r = await shell`git rev-parse --show-prefix`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) return r.stdout.toString().trim();
  } catch {
    // git でない・repo 外は空として扱う
  }
  return "";
}

/** git が返す repo 直下相対のパスを root 相対に直す（root 外は ".." を付ける）。
 * root が VCS repo のサブディレクトリのとき、そのままでは `diffOneFile` の pathspec と
 * 一致しない（design g-mwiwxc5a 判断3）。 */
export function toRootRelative(prefix: string, file: string): string {
  if (!prefix) return file;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  const depth = prefix.split("/").filter((s) => s.length > 0).length;
  return "../".repeat(depth) + file;
}

/** baseline からの変更ファイル列を測定する（jj → git fallback）。
 * 作業ファイル（`.graphhopper/` 配下）は数えない。deep検知用。取得不能時は []
 * （fail-open＝deepなし）。 */
export async function measureChangedFiles(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<string[]> {
  if (!baseline || !isValidBaselineRev(baseline)) return [];
  const collect = (out: string): string[] =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  try {
    const r = await shell`jj diff --from ${baseline} --name-only -- ${[ghFileset()]}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return collect(r.stdout.toString());
  } catch {
    // ignore → gitへ
  }
  try {
    const all = await shell`git diff --name-only ${baseline} -- ${ghAllSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    const keep = await shell`git diff --name-only ${baseline} -- ${ghKeepSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (all.exitCode !== 0 || keep.exitCode !== 0) return [];
    const prefix = await gitShowPrefix(shell, root);
    return [
      ...new Set(
        [...collect(all.stdout.toString()), ...collect(keep.stdout.toString())].map((f) =>
          toRootRelative(prefix, f),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

/** deep判定＝(現行集合 − 初期集合) ∩ RISK_PATHS（effectiveDiffLinesのファイル版。
 * 前goal残骸を除外する）。初期集合null（legacy）時はfalse（帰属不能のため）。 */
export function detectDeepRisk(
  root: string,
  currentFiles: string[],
  initialFiles: string[] | null | undefined,
): { deep: boolean; reason: string | null } {
  if (!initialFiles) return { deep: false, reason: null };
  const initial = new Set(initialFiles.map((f) => normalizeForGate(root, f)));
  const touched = currentFiles
    .map((f) => normalizeForGate(root, f))
    .filter((f) => !initial.has(f) && (RISK_PATHS as readonly string[]).includes(f));
  if (touched.length === 0) return { deep: false, reason: null };
  return { deep: true, reason: `risk files touched: ${touched.join(", ")}` };
}

/** `--stat` / `--shortstat` 末行（"N files changed, M insertions(+), K deletions(-)"）
 * をパースして挿入+削除行数を返す。insert-only / delete-only 対応。
 * どちらも無ければ null（diff無しとパース不能を区別せず、呼び出し側で0扱い）。 */
export function parseDiffShortstat(out: string): number | null {
  const ins = out.match(/(\d+) insertion/);
  const del = out.match(/(\d+) deletion/);
  if (!ins && !del) return null;
  return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
}

/** baseline からの diff 行数を測定する（jj → git fallback） */
export async function measureDiffLines(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<number> {
  if (!baseline || !isValidBaselineRev(baseline)) return 0;
  try {
    // Bun shell の補間値は自動escapeされるため、baseline を直接埋め込む。
    // 以前の `sh -c "jj diff --from ${baseline} ..."` は sh 内で無escapeだった。
    // pipe (tail) を避け、末行の取り出しは JS で行う。
    const r = await shell`jj diff --from ${baseline} --stat -- ${[ghFileset()]}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
    }
  } catch {
    // ignore
  }
  try {
    // 全体（`:/\`）と残す設定の 2 回に分ける: exclude したディレクトリの子は足し戻せない
    const all = await shell`git diff --shortstat ${baseline} -- ${ghAllSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    const keep = await shell`git diff --shortstat ${baseline} -- ${ghKeepSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    return (
      (parseDiffShortstat(all.stdout.toString().trim()) ?? 0) +
      (parseDiffShortstat(keep.stdout.toString().trim()) ?? 0)
    );
  } catch {
    return 0;
  }
}

export interface StashedDiff {
  path: string;
  lines: number;
  baseline: string;
}

/* 実効diff＝測定－初期脏れ（floor 0）。前goalの未コミット分を自goalの実装と
 * 誤認しないための減算。legacy（null）→0扱いで旧挙動維持 */
export function effectiveDiffLines(
  measured: number,
  initial: number | null | undefined,
): number {
  return Math.max(0, measured - (initial ?? 0));
}

/* goal start直後の初期脏れsnapshot（tool層・asyncから呼ぶ。startGoalはsyncのため
 * 測定できない）。designing中はsource編集不可のためstart時測定で安定。
 * rev取得失敗時は書かない（null＝legacy扱い）。mid-designingの手動commitによる
 * ずれは許容（稀・方向は安全側に倒れないが監査可） */
export function snapshotInitialDirt(root: string, lines: number | null): void {
  if (lines === null || lines < 0) return;
  const state = readState(root);
  writeState(root, { ...state, initial_diff_lines: lines });
}

/* goal start直後の初期脏れファイル集合snapshot（行数のsnapshotInitialDirt同型。
 * deep判定の差分基準。nullは書かない（legacy＝deepなし扱いを維持） */
export function snapshotInitialDiffFiles(
  root: string,
  files: string[] | null,
): void {
  if (!files) return;
  const state = readState(root);
  writeState(root, {
    ...state,
    initial_diff_files: files.map((f) => normalizeForGate(root, f)),
  });
}

/** 退避diffのpath（stashDiffと単一源泉。complete/clear時の掃除と共有）。
 * 子セッションのexternal_directory権限で読めるようrepo内（gitignore済み）に置く。
 * /tmpは子から読めない実証済みのため使わない */
export function stashedDiffPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `gh-verify-${goalId}.txt`);
}

/** 退避diffの掃除。存在しなくても成功（best-effort。complete/clear時） */
export function removeStashedDiff(root: string, goalId: string): void {
  if (!/^g-[0-9a-z]+$/.test(goalId)) return;
  try {
    unlinkSync(stashedDiffPath(root, goalId));
  } catch {
    // 存在しない・権限なし等は無視
  }
}

/** 単一ファイルのdiffを取得する（stashDiffの実効diff用）。
 * 失敗時は null（呼び出し側が全文退避に倒す）。 */
export async function diffOneFile(
  shell: Shell,
  root: string,
  baseline: string,
  file: string,
): Promise<string | null> {
  // root 相対の名前を cwd 基準の絶対パスにする（root が repo のサブディレクトリでも
  // pathspec が一致しないように。design g-mwiwxc5a 判断3）。
  const abs = isAbsolute(file) ? file : resolve(root, file);
  try {
    const r = await shell`jj diff --from ${baseline} -- ${abs}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return r.stdout.toString();
  } catch {
    // gitへ
  }
  try {
    const r = await shell`git diff ${baseline} -- ${abs}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return r.stdout.toString();
  } catch {
    return null;
  }
  return null;
}

/* verifier fan-out用のdiff退避: 実効diff（初期脏れ除外）を1回だけ取得し、
 * repo内（.graphhopper/tmp）に置いてpathで渡す（角度ごとの inline 展開を防ぐ。
 * /tmpは子権限で読めないため使わない。ファイル名にgoalを含め並列goalの衝突を避ける）。
 * 初期集合null（legacy）・測定不能時は全文退避に倒す（fail-safe＝読み過ぎ側）。
 * 失敗時は null */
export async function stashDiff(
  shell: Shell,
  root: string,
  baseline: string | null,
  goalId: string,
): Promise<StashedDiff | null> {
  if (!baseline || !isValidBaselineRev(baseline)) return null;
  if (!/^g-[0-9a-z]+$/.test(goalId)) return null;
  const path = stashedDiffPath(root, goalId);
  const write = (out: string): StashedDiff => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out, "utf8");
    return {
      path,
      lines: out.length === 0 ? 0 : out.split("\n").length,
      baseline,
    };
  };
  // 実効diff: 現行集合−初期集合の対象ファイルのみ退避する
  const initial = getActive(root)?.state.initial_diff_files;
  if (initial) {
    let current: string[] = [];
    try {
      current = await measureChangedFiles(shell, root, baseline);
    } catch {
      current = [];
    }
    if (current.length > 0) {
      const initialSet = new Set(
        initial.map((f) => normalizeForGate(root, f)),
      );
      const effective = [
        ...new Set(current.map((f) => normalizeForGate(root, f))),
      ].filter((f) => !initialSet.has(f));
      if (effective.length === 0) return write("");
      try {
        const parts: string[] = [];
        for (const f of effective) {
          const part = await diffOneFile(shell, root, baseline, f);
          if (part === null) throw new Error(`per-file diff failed: ${f}`);
          parts.push(part);
        }
        return write(parts.join("\n"));
      } catch {
        // 下の全文退避へ（読み過ぎ側に倒す）
      }
    }
  }
  try {
    const r = await shell`jj diff --from ${baseline} -- ${[ghFileset()]}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return write(r.stdout.toString());
  } catch {
    // git にフォールバック
  }
  try {
    // 実効diff 経路に乗らなかった場合も作業ファイルは載せない（design g-mwiu6lcj）
    const all = await shell`git diff ${baseline} -- ${ghAllSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    const keep = await shell`git diff ${baseline} -- ${ghKeepSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (all.exitCode !== 0 || keep.exitCode !== 0) return null;
    return write(all.stdout.toString() + keep.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * baseline からの diff の sha1（design g-mwd3n5bo）。
 * 実効diff（stashDiff）と違い初期脏れも含む: goal 中にそのファイルを直した場合も検知するため。
 * ただし `.graphhopper/` の作業ファイルは含めない（graphhopper 自身の記録が差分を変えて
 * ゲートが止まるため。design g-mwiu6lcj。設定 2 つは含む）。
 * VCS 不能・baseline 不正は null（ゲートは fail-open）。
 */
export async function computeDiffHash(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<string | null> {
  if (!baseline || !isValidBaselineRev(baseline)) return null;
  try {
    const r = await shell`jj diff --from ${baseline} --color=never -- ${[ghFileset()]}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) return sha1Hex(r.stdout.toString());
  } catch {
    // git にフォールバック
  }
  try {
    const all = await shell`git diff ${baseline} -- ${ghAllSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    const keep = await shell`git diff ${baseline} -- ${ghKeepSpec()}`
      .cwd(root)
      .nothrow()
      .quiet();
    if (all.exitCode !== 0 || keep.exitCode !== 0) return null;
    return sha1Hex(all.stdout.toString() + keep.stdout.toString());
  } catch {
    return null;
  }
}

/** git の未追跡ファイル（パス・サイズ・更新時刻）の指紋。git は未追跡を diff に含めないため、
 * 新しいファイルを作っただけのターンを「進んでいない」と誤判定しないよう進捗の材料に足す
 * （design g-mwoiwjif 決めたこと6）。jj は自動追跡なので jj のリポジトリでは使わない。
 * 測れなければ空文字（材料に足さないだけ） */
async function measureUntrackedFingerprint(shell: Shell, root: string): Promise<string> {
  try {
    const r = await shell`git ls-files --others --exclude-standard`.cwd(root).nothrow().quiet();
    if (r.exitCode !== 0) return "";
    const files = r.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => f.length > 0 && !f.startsWith(".graphhopper/"));
    const parts = files.sort().map((f) => {
      try {
        const st = statSync(join(root, f));
        return `${f}:${st.size}:${Math.trunc(st.mtimeMs)}`;
      } catch {
        return f;
      }
    });
    return parts.length > 0 ? fnv1a(parts.join("\n")) : "";
  } catch {
    return "";
  }
}

/** 進捗の証拠（goal 開始基準からの diff の指紋）。測れなければ null。
 * jj のリポジトリは未追跡も diff に含むので、git のときだけ未追跡の指紋を足す。 */
export async function measureProgressEvidence(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<string | null> {
  const hash = await computeDiffHash(shell, root, baseline);
  if (hash === null) return null;
  if (existsSync(join(root, ".jj"))) return hash;
  const untracked = await measureUntrackedFingerprint(shell, root);
  return untracked ? `${hash}+${untracked}` : hash;
}

/** diff_stash 時点の指紋を保存する（verifier_set が verdict へ写す） */
export function setStashDiffHash(root: string, hash: string | null): void {
  const state = readState(root);
  writeState(root, { ...state, stash_diff_hash: hash });
}

/** diff_stash 時点の指紋（未 stash は null） */
export function getStashDiffHash(root: string): string | null {
  return readState(root).stash_diff_hash;
}

/** 意図ログの path を保存する（design g-mwebh9vl） */
export function setIntentPath(root: string, path: string | null): void {
  const state = readState(root);
  writeState(root, { ...state, intent_path: path });
}

/** 対象ファイルの内容の sha1（usability の review 後変更検知。design g-mwfltxyt） */
export function hashFiles(root: string, files: string[]): string | null {
  try {
    const parts = [...files]
      .sort()
      .map((f) => `${f}\n${readFileSync(join(root, f), "utf8")}`);
    return sha1Hex(parts.join("\n---\n"));
  } catch {
    return null;
  }
}

/** baseline の単一解決（start 優先）。diff hash と usability の基準を揃える */
export async function resolveBaseline(
  shell: Shell,
  root: string,
  s: {
    start_baseline_rev: string | null;
    router: { baseline_rev: string | null };
  } | null,
): Promise<string | null> {
  return (
    s?.start_baseline_rev ??
    s?.router.baseline_rev ??
    (await captureBaselineRev(shell, root))
  );
}

/** usability レビュー後に文書が変わったか（status 表示用） */
export function usabilityStale(root: string): boolean {
  const u = readState(root).usability_review;
  if (!u || !u.doc_hash || u.files.length === 0) return false;
  return hashFiles(root, u.files) !== u.doc_hash;
}

/** config の gates を global < project でマージして読む（凍結前の実効値） */
export function readGateModes(root: string): { modes: GateModes; invalid: GateName[] } {
  const global = readJson<{ gates?: unknown }>(globalConfigPath(), {});
  const project = readJson<{ gates?: unknown }>(configPath(root), {});
  return normalizeGates({ ...(global.gates ?? {}), ...(project.gates ?? {}) });
}

/** goal 開始時にゲートのモードと採点基準のハッシュを凍結する（design g-mwmnvx3x 判断1・3） */
export function freezeGoalGates(
  root: string,
  modes: GateModes,
  rubricHash: string | null,
): void {
  const state = readState(root);
  writeState(root, { ...state, gate_modes: modes, rubric_hash: rubricHash });
}

/** goal 開始時の baseline rev を保存する（design g-mwfltxyt） */
export function setStartBaselineRev(
  root: string,
  rev: string | null,
  source: BaselineSource | null = null,
): void {
  const state = readState(root);
  writeState(root, { ...state, start_baseline_rev: rev, baseline_source: source });
}

/** usability レビュー結果を保存する（design g-mwfltxyt） */
export function setUsabilityVerdict(
  root: string,
  verdict: Omit<UsabilityVerdict, "at">,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    usability_review: { ...verdict, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "usability_verdict",
      goal: state.goal_id,
      level: verdict.level,
      files: verdict.files,
      reason: verdict.reason,
    });
  }
  return next;
}

export function recordRouterCheck(
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
  deep?: { deep: boolean; reason: string | null },
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    router: {
      baseline_rev: baseline,
      diff_lines: diffLines,
      route,
      checked_at: new Date().toISOString(),
      deep: deep?.deep ?? false,
      deep_reason: deep?.reason ?? null,
    },
  };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, {
      type: "router_check",
      goal: state.goal_id,
      diff_lines: diffLines,
      route,
      deep: next.router.deep,
      deep_reason: next.router.deep_reason,
    });
  return next;
}

/** router記録のchoke point（検知＋記録）。既存のrecordRouterCheck呼出は
 * こちらに置換する（eval経路含む。deep検知の抜けを作らない）。 */
export async function recordRouterCheckWithRisk(
  shell: Shell,
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
): Promise<LoopState> {
  const active = getActive(root);
  // measureChangedFiles は内部で例外を握り潰し [] を返すためここではthrowしない
  const files = await measureChangedFiles(shell, root, baseline);
  const { deep, reason } = detectDeepRisk(
    root,
    files,
    active?.state.initial_diff_files ?? null,
  );
  return recordRouterCheck(root, baseline, diffLines, route, { deep, reason });
}

/** eval 遷移の応答（idle hook の evalNote と tool の返り値） */
export interface EvalToPolishResult {
  /** polish へ遷移したか */
  transitioned: boolean;
  /** 遷移しなかった理由（ゲート拒否・diff=0 など） */
  note: string;
}

/**
 * eval 成功時の implementing→polish 遷移。**idle hook（hooks.ts）と tool の単一実装**。
 *
 * 規則（2 経路に散らばせないこと）:
 * - 遷移するのは「baseline 取得失敗」と「diff>0」の 2 分岐だけ。
 *   実効 diff=0 は「実装なし」の可能性があるので遷移せず、警告だけ返す。
 * - 進捗ゲートに拒否されたら router 記録もしない（拒否のたびに router_check が積み上がるのを防ぐ）。
 * - router 記録は遷移に成功したときだけ。
 */
/**
 * eval 遷移の入力（baseline と実効 diff 行数）を計算する。
 * hooks.ts と tool が同じ物を使う（配線の取り違えを防ぐ）。
 */
export async function evalTransitionInput(
  shell: Shell,
  root: string,
  baselineRev: string | null | undefined,
): Promise<{ baseline: string | null; diffLines: number }> {
  const baseline = baselineRev ?? (await captureBaselineRev(shell, root));
  const measured = await measureDiffLines(shell, root, baseline);
  const diffLines = effectiveDiffLines(
    measured,
    getActive(root)?.state.initial_diff_lines,
  );
  return { baseline, diffLines };
}

export async function evalToPolish(
  shell: Shell,
  root: string,
  input: { cmd: string; baseline: string | null; diffLines: number },
): Promise<EvalToPolishResult> {
  const { cmd, baseline, diffLines } = input;
  if (baseline === null) {
    const mv = setPhaseChecked(root, "polish");
    if (!mv.ok) {
      return { transitioned: false, note: `eval_cmd は通ったが polish へ進めない: ${mv.error}` };
    }
    await recordRouterCheckWithRisk(shell, root, baseline, 0, "advisor");
    return {
      transitioned: true,
      note: `eval_cmd passed but baseline not captured — polishへ進む（simplifyはスキップ、verifierで検証）: ${cmd}`,
    };
  }
  if (diffLines > 0) {
    const cfg = readConfig(root);
    const route: RouterRoute = diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
    const mv = setPhaseChecked(root, "polish");
    if (!mv.ok) {
      return { transitioned: false, note: `eval_cmd は通ったが polish へ進めない: ${mv.error}` };
    }
    const recorded = await recordRouterCheckWithRisk(shell, root, baseline, diffLines, route);
    const deep = recorded.router.deep
      ? `\ndeep: ${recorded.router.deep_reason} — verifier の角度は選ぶ役が選ぶ（verifier既定モデルの上書きは不要）`
      : "";
    return {
      transitioned: true,
      note: `eval_cmd passed (diff ${diffLines} lines since baseline): ${cmd}${deep}`,
    };
  }
  // 実効 diff=0: 実装なし or 前goal残骸との相殺。遷移しない（人手確認）。
  await recordRouterCheckWithRisk(shell, root, baseline, 0, "advisor");
  return {
    transitioned: false,
    note: `eval_cmd passed but effective diff_lines=0 since baseline — 実装なしか前goal残骸との相殺のいずれか。実装を進めるか、router_check で手動確認せよ: ${cmd}`,
  };
}

import {
  aggregateVerdicts,
  checkVerifierResults,
  collectSeverity,
  formatSeverity,
  sumSeverity,
  type VerifierResult,
  type VerifierSeverityCounts,
} from "./verdict";
export {
  aggregateVerdicts,
  checkVerifierResults,
  collectSeverity,
  formatSeverity,
  sumSeverity,
  type VerifierResult,
  type VerifierSeverityCounts,
};

export function setVerifierVerdict(
  root: string,
  verdict: Omit<VerifierVerdict, "at">,
): LoopState {
  const state = readState(root);
  const model =
    verdict.model ?? readConfig(root).agents["graphhopper-verifier"] ?? null;
  // lens並列モデルを lens 長に揃える（不足は既定でpad、過剰はtruncate。fail-safe）
  const models = verdict.lens.map(
    (_, i) => verdict.models?.[i] ?? model,
  );
  const next: LoopState = {
    ...state,
    last_verifier: { ...verdict, model, models, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "verifier_verdict",
      goal: state.goal_id,
      level: verdict.level,
      target: verdict.target,
      lens: verdict.lens,
      ...(verdict.angles ? { angles: verdict.angles } : {}),
      model,
      models,
    });
  }
  return next;
}

/** goal の履歴から角度ごとの drift 回数を数える（再開前の分も含む累計。design g-mwoxgpsa） */
export function driftCountsByLens(
  root: string,
  goalId?: string,
): { lens: string; count: number }[] {
  const gid = goalId ?? readState(root).goal_id;
  if (!gid) return [];
  const counts = new Map<string, number>();
  for (const h of readHistory(root)) {
    if (h.type !== "verifier_verdict" || h.goal !== gid) continue;
    for (const a of (h as { angles?: { lens: string; level: VerdictLevel }[] }).angles ?? []) {
      if (a.level === "drift") counts.set(a.lens, (counts.get(a.lens) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([lens, count]) => ({ lens, count }))
    .sort((a, b) => b.count - a.count || a.lens.localeCompare(b.lens));
}

/** verifier の drift を 1 回数える。上限（verify_drift_max）に達したら goal を pause して
 * 人間に聞く。ループ検知の loop_stop_count には数えない（異常ではなく確認のための停止。
 * 数えると loop_stop_max で resume すら拒否される）。design g-mwoxgpsa */
export function noteVerifyDrift(root: string): {
  count: number;
  max: number;
  capped: boolean;
  byLens: { lens: string; count: number }[];
} {
  const state = readState(root);
  const max = readConfig(root).verify_drift_max;
  const count = state.verify_drift_count + 1;
  /* pause は現在の state をスナップショットするので、先に数えた回数を書く */
  writeState(root, { ...state, verify_drift_count: count });
  const byLens = driftCountsByLens(root);
  const capped = max > 0 && count >= max;
  if (capped && state.goal_id) {
    pauseGoal(root);
    recordEvent(root, {
      type: "verify_cap",
      goal: state.goal_id,
      count,
      max,
      by_lens: byLens,
    });
  }
  return { count, max, capped, byLens };
}

/** status表示用：既定と異なるlensのみ `lens@model` 式で列挙する（差分表示）。
 * 全一致・欠測時は ""（行自体は呼び出し側で省略可）。 */
export function formatLensModels(
  lens: VerifierLens[],
  models: (string | null)[] | undefined,
  fallback: string | null | undefined,
): string {
  if (!models) return "";
  return lens
    .map((l, i) => {
      const m = models[i] ?? fallback ?? null;
      return m && m !== fallback ? `${l}@${m}` : null;
    })
    .filter((x): x is string => x !== null)
    .join(",");
}

/* ================================================================== *
 * 無限ループ検知（echoループ + 同一tool call反復）: assistant出力がそのまま次の
 * user入力にミラーされ続けると、turn 終了が連続して自動継続が延々回る。
 * 検知は2種:
 * - echo: 直前のassistantメッセージとほぼ同一のuserメッセージ（3パターン）
 * - tool: 直近ウィンドウ内で同一 (tool名+入力ハッシュ) の反復
 * どちらかが loop_stop_threshold（echo無効時は loop_tool_repeat_threshold）回
 * 連続したら自動継続を止める（goalをpause）。
 * ================================================================== */

/** 検知の種別。イベント記録・通知文に使う */
export type LoopKind = "echo" | "tool" | "echo+tool";

/** session.messages() の最小構造（SDK型に依存しない軽量型） */
export interface SessionMessageLike {
  info: { id: string; role: "user" | "assistant" };
  parts: Array<{
    type: string;
    text?: string;
    synthetic?: boolean;
    callID?: string;
    tool?: string;
    state?: { status?: string; input?: unknown };
  }>;
}

function normalizeMessage(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\s+/g, "") // 空白・改行を除去
      .replace(/[。、！!？?・…〜〜：:，,（）()「」『』'"'`~]/g, "") // 句読点を除去
      // 絵文字・記号・ASCII装飾を除去（echo判定のノイズ）
      .replace(/[^\u3040-\u30ff\u4e00-\u9fff\u0020-\u007e\u30fc]/g, "")
      .trim()
  );
}

/** echoループ検知。3パターンを扱う:
 * 1. 末尾=user・直前=assistant がほぼ同一（外部ミラーが出力を user にコピーするケース）
 * 2. 末尾=assistant・直前=user で、その user が「その前の assistant（[-3]）」の echo
 *    （自動継続ループで idle 時点の末尾が必ず assistant になるケースの本体）
 * 3. 連続する assistant メッセージ（[-3] と [-1]）がほぼ同一（強制継続で同文を繰り返す）
 * どれも正規化テキストの同一 or 十分な重複を echo とみなす。 */
export function isEchoMessage(msgs: SessionMessageLike[]): boolean {
  if (msgs.length < 2) return false;
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];

  const text = (m: SessionMessageLike): string =>
    (m.parts ?? [])
      /* 自動継続（synthetic + CONTINUATION_MARKER）は echo 判定の対象に含める。
       * synthetic を一律に外すと、継続ループの echo 検知（パターン2）が空振りする */
      .filter(
        (p) =>
          p.type === "text" &&
          (!p.synthetic || (p.text ?? "").startsWith(CONTINUATION_MARKER)),
      )
      .map((p) => p.text ?? "")
      .join("");

  const isEcho = (a: string, b: string): boolean => {
    const x = normalizeMessage(a);
    const y = normalizeMessage(b);
    if (!x || !y) return false;
    // 短すぎる挨拶（"👋" など）は echo と誤判定しない
    if (Math.min(x.length, y.length) < 4) return false;
    if (x === y) return true;
    // 部分一致（一方が他方にほぼ含まれる）。例: 編集で微差が付いた場合
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (long.includes(short)) return short.length >= long.length * 0.5;
    return false;
  };

  // パターン1: 末尾=user・直前=assistant のミラー echo
  if (last.info.role === "user" && prev.info.role === "assistant") {
    return isEcho(text(prev), text(last));
  }

  // パターン2/3: 末尾=assistant（自動継続ループはこちらの形）
  if (last.info.role === "assistant" && msgs.length >= 3) {
    const beforePrev = msgs[msgs.length - 3];
    // 直前の user がその前の assistant の echo になっている
    if (prev.info.role === "user" && beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(prev))) return true;
    }
    // 直前の assistant と末尾の assistant が同一文の繰り返し
    if (beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(last))) return true;
    }
  }
  return false;
}

export interface LoopDetectionResult {
  streak: number;
  stopped: boolean;
  justStopped: boolean;
}

/* ---------------------------------------------------------------- *
 * 同一tool call反復検知: 最後の人間user入力以降の tool call のうち、直近
 * loop_tool_window 件で同一 (tool名+入力ハッシュ) が loop_tool_repeat_threshold 回
 * 出たらループとみなす。callID で dedupe、completed/error のみ数える。
 * ---------------------------------------------------------------- */

/** JSONのcanonical形式（キーを再帰ソート）。入力の同一性を順序非依存で判定する。
 * stringify不能な入力（undefined / function / symbol）は "undefined" を返す。 */
export function canonicalJSON(input: unknown): string {
  if (input === null || typeof input !== "object") {
    const s = JSON.stringify(input);
    return s === undefined ? "undefined" : s;
  }
  if (Array.isArray(input)) {
    return "[" + input.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") +
    "}"
  );
}

/** FNV-1a 64bit ハッシュ（文字列→16進hex）。実用目的のハッシュで十分 */
export function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

/** tool call を `tool名:hash(canonicalJSON(input))` に正規化する。
 * シリアライズ不能・callID欠損・input欠損の tool 部品は null（カウント対象外）。 */
export function toolCallHash(part: SessionMessageLike["parts"][number]): string | null {
  if (part.type !== "tool") return null;
  if (!part.callID || !part.tool || !part.state || !("input" in part.state)) {
    return null;
  }
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null; // pending / running は数えない
  }
  try {
    return `${part.tool}:${fnv1a(canonicalJSON(part.state.input))}`;
  } catch {
    return null;
  }
}

/** 自動継続注入メッセージの先頭マーカー。session.messages 上で人間入力と
 * 区別するための目印（index.ts の idle ハンドラが注入文の先頭に付与する）。
 * これが無いと自前の注入が「人間の新規入力」に見えて tool 反復検知の
 * ウィンドウが毎回リセットされ、tool ループを検知できなくなる。 */
export const CONTINUATION_MARKER = "[graphhopper-continuation]";

/** 人間の新規入力テキスト部品か。自動継続注入・synthetic は除外する */
export function isHumanTextPart(
  p: SessionMessageLike["parts"][number],
): boolean {
  if (p.type !== "text" || p.synthetic || !(p.text ?? "").length) return false;
  if (p.text!.startsWith(CONTINUATION_MARKER)) return false;
  /* graphhopper の通知（"[graphhopper] ..."）は人間の新規入力ではない */
  return !p.text!.startsWith("[graphhopper");
}

/** 同一tool call反復を検知する。callID重複は1件に数え直す。 */
export function isToolRepeatLoop(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): boolean {
  const window = cfg.loop_tool_window;
  const threshold = cfg.loop_tool_repeat_threshold;
  if (window <= 0 || threshold <= 1) return false;

  // 最後の「人間の新規user入力（自動継続注入・syntheticでない text 部品を持つ）」
  // 以降のメッセージだけを見る。
  // tool result を運ぶ user メッセージ（text 部品なし）は人間入力扱いしない
  // （自動継続バーストを切らない）。自前の継続注入（CONTINUATION_MARKER 付き）も
  // 人間入力扱いしない（注入のたびにウィンドウがリセットされ tool ループを
  // 検知できなくなるバグの修正）。
  let lastHumanIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const hasHumanText = (m.parts ?? []).some(
      (p) => m.info.role === "user" && isHumanTextPart(p),
    );
    if (hasHumanText) {
      lastHumanIdx = i;
      break;
    }
  }

  // callID で dedupe（最新状態を採用）
  const calls = new Map<string, string>();
  for (let i = lastHumanIdx + 1; i < msgs.length; i++) {
    for (const p of msgs[i]?.parts ?? []) {
      if (p.type !== "tool" || !p.callID) continue;
      const h = toolCallHash(p);
      if (h === null) continue;
      calls.set(p.callID, h);
    }
  }

  const recent = Array.from(calls.values()).slice(-window);
  if (recent.length < threshold) return false;

  const counts = new Map<string, number>();
  for (const h of recent) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const n of counts.values()) if (n >= threshold) return true;
  return false;
}

/** echo / tool のどちらが検知に寄与したかを判定する（両方なら "echo+tool"） */
export function detectLoopKind(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): { detected: boolean; kind: LoopKind } {
  const echoEnabled = cfg.loop_stop_threshold > 0;
  const toolEnabled = cfg.loop_tool_repeat_threshold > 1;
  if (!echoEnabled && !toolEnabled) return { detected: false, kind: "echo" };

  const isEcho = echoEnabled && isEchoMessage(msgs);
  const isTool = toolEnabled && isToolRepeatLoop(msgs, cfg);
  const kind: LoopKind = isEcho && isTool ? "echo+tool" : isEcho ? "echo" : "tool";
  return { detected: isEcho || isTool, kind };
}

/** ループ検知で loop_streak / loop_stopped を更新する。検知でない（人間の新規入力）なら
 * streakをリセットし、停止中でも再開する（検知による誤検知でgoalが永久停止しないため）。
 * 閾値に達したら loop_stopped=true を返す（呼び出し側が goal を pause する）。 */
export function updateLoopDetection(
  root: string,
  detected: boolean,
  kind: LoopKind = "echo",
): LoopDetectionResult {
  const cfg = readConfig(root);
  const threshold =
    cfg.loop_stop_threshold > 0
      ? cfg.loop_stop_threshold
      : cfg.loop_tool_repeat_threshold;
  const state = readState(root);

  let streak: number;
  let stopped: boolean;
  if (threshold > 0 && detected) {
    streak = state.loop_streak + 1;
    stopped = state.loop_stopped || streak >= threshold;
  } else {
    streak = 0;
    stopped = false;
  }

  writeState(root, { ...state, loop_streak: streak, loop_stopped: stopped });
  if (state.goal_id && streak > 0) {
    recordEvent(root, {
      type: "loop_detected",
      goal: state.goal_id,
      kind,
      streak,
      stopped,
    });
  }
  return { streak, stopped, justStopped: stopped && !state.loop_stopped };
}

/* ---------------------------------------------------------------- *
 * 継続注入 dedupe: 前回注入以降の「進展」をフィンガープリント化する。
 * 進展 = 人間入力の到達位置・tool 実行件数・phase・eval_cmd・直近 eval 結果。
 * assistant の言い換え待機 ack（テキストのみ・tool なし）は進展に数えない。
 * これにより「deny → 待機ack → 注入 → 言い換え待機ack → 注入 …」の空転が
 * echo 検知（文面一致・閾値6回）を待たずに1往復で止まる。
 * ---------------------------------------------------------------- */

/** 最後の人間入力メッセージの id（無ければ null）。
 * id はスライドウィンドウをまたいで安定するため、dedupe の人間アンカーに使う。
 * id 欠損時は空文字に倒す（null=不在と区別。衝突しても安定するため
 * dedupe が壊れない）。 */
export function lastHumanId(msgs: SessionMessageLike[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.info.role === "user" &&
      (m.parts ?? []).some((p) => isHumanTextPart(p))
    ) {
      const id: unknown = (m.info as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    }
  }
  return null;
}

/** 進展フィンガープリントを計算する（純粋関数・テスト容易性のため分離）。
 * 人間アンカーは配列インデックスではなくメッセージ id で持つ。
 * 末尾N取得のスライドウィンドウ下でも、deny/ack の追加では人間 id・tool 件数
 * ともに不変のため dedupe「1往復で止まる」が成立する。 */
export function continuationFingerprint(
  msgs: SessionMessageLike[],
  phase: Phase,
  evalCmd: string | null,
  evalFingerprint: string | null,
): string {
  const h = lastHumanId(msgs);
  let toolCalls = 0;
  let afterHuman = h === null;
  for (const m of msgs) {
    if (!afterHuman) {
      const id: unknown = (m.info as { id?: unknown }).id;
      if ((typeof id === "string" ? id : "") === h) {
        afterHuman = true;
      }
      continue;
    }
    for (const p of m?.parts ?? []) {
      if (p.type === "tool" && p.callID) toolCalls++;
    }
  }
  return fnv1a(
    canonicalJSON({
      h,
      t: toolCalls,
      p: phase,
      e: evalCmd ?? "",
      o: evalFingerprint ?? "",
    }),
  );
}

/** 継続リマインダーを注入したことを記録する（次回 idle の skip 判定材料） */
export function noteContinuation(root: string, marker: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_continuation_marker: marker };
  writeState(root, next);
  return next;
}

/** 直近の eval 実行結果フィンガープリントを記録する */
export function noteEvalFingerprint(root: string, fp: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_eval_fingerprint: fp };
  writeState(root, next);
  return next;
}

/** loop 停止時に goal を pause する（自動継続を物理的に止める）。累積停止回数
 * （loop_stop_count）を加算し、loop_stopped イベントを記録する。
 * pause は human の resume でしか解除されない。 */
/** このプロセスの識別子。継続途中で落ちたかを判定する */
let BOOT_ID: string | null = null;
export function bootId(): string {
  return (BOOT_ID ??= globalThis.crypto.randomUUID());
}

/** 継続可否を判断する材料になる進捗キー（design g-mwoiwjif）。
 * 「進んだ」の証拠は差分の指紋と eval の合否だけ。測れない環境では従来の材料にフォールバックする。 */
export async function measureProgressKey(
  shell: Shell,
  root: string,
  goalId: string,
  s: LoopState,
): Promise<string> {
  const loaded = readTodosStatus(root, goalId);
  const items = loaded.valid ? loaded.store.items : [];
  const todosDone = items.filter((i) => i.status === "completed").length;
  let planSize: number | null = null;
  try {
    planSize = statSync(planPath(root, goalId)).size;
  } catch {
    planSize = null;
  }
  const baseline = await resolveBaseline(shell, root, s);
  const diffHash = await measureProgressEvidence(shell, root, baseline);
  const evalOk =
    s.last_eval_fingerprint === null ? null : s.last_eval_fingerprint.startsWith("true");
  return progressKeyOf({
    phase: s.phase,
    todosDone,
    evalFingerprint: s.last_eval_fingerprint,
    diffLines: s.last_diff_lines,
    planSize,
    diffHash,
    evalOk,
  });
}

/** ガード状態の部分更新 */
export function noteGuard(
  root: string,
  patch: Partial<LoopGuard>,
): ActiveLoop | null {
  return mutateActive(root, (_goal, state) => ({
    state: { guard: { ...state.guard, ...patch } },
  }));
}

export function stopLoopByPause(
  root: string,
  opts?: {
    /** 停止時点の進捗キー（resume 後に同じなら即 pause する。design g-mwokteud） */
    stuckKey?: string | null;
    /** true なら `loop_stopped` を記録しない（既に理由付きのイベントがある経路用） */
    silent?: boolean;
  },
): ActiveLoop | null {
  const state = readState(root);
  const count = state.loop_stop_count + 1;
  writeState(root, {
    ...state,
    loop_stop_count: count,
    ...(opts?.stuckKey !== undefined
      ? { guard: { ...state.guard, stuck_key: opts.stuckKey } }
      : {}),
  });
  const r = pauseGoal(root);
  if (r?.goal.id && !opts?.silent) {
    recordEvent(root, { type: "loop_stopped", goal: r.goal.id, count });
  }
  return r;
}

/** resume 直後に出す注意（止めたときと同じ状態のまま再開したとき）。null なら何も出さない */
export function stuckResumeNote(guard: LoopGuard | null | undefined): string | null {
  const key = guard?.stuck_key ?? null;
  if (!key) return null;
  return (
    `注意: 止めたときと同じ状態のまま resume しています（進捗キー ${key.slice(0, 24)}…）。` +
    "差分か eval の結果が変わらないと、次のターンでまた停止します（force: true の resume で解除できます）。"
  );
}

/** resume がブロックされているか（loop_stop_max に累積停止回数が達した） */
export function isResumeBlocked(root: string): boolean {
  const cfg = readConfig(root);
  if (cfg.loop_stop_max <= 0) return false;
  const state = readState(root);
  return state.loop_stop_count >= cfg.loop_stop_max;
}

/* ================================================================== *
 * stuck escalation: implementing での連続失敗を機械カウントし、
 * stuck_threshold に達したら graphhopper-oracle への相談を促す。
 * diffサイズ（router gate）とは別軸のタイミング判断——
 * 「詰まった回数」で上位モデルを呼ぶ graph engineering のもう1つの分岐点。
 * ================================================================== */

export interface AttemptResult {
  fail_streak: number;
  escalate: boolean;
  /** 連続失敗が max_eval_fails に達し、goal を pause すべきか */
  giveUp: boolean;
  /** eval_cmd があるため自己申告 ok ではカウンタを戻さなかった（design g-mwoiwjif） */
  kept_progress?: boolean;
}

export function setEvalCmd(root: string, cmd: string): LoopState {
  const state = readState(root);
  const next: LoopState = { ...state, eval_cmd: cmd || null };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, { type: "eval_set", goal: state.goal_id, cmd });
  return next;
}

export interface EvalResult {
  ok: boolean;
  output: string;
}

/* ==================================================================
 * 診断ファイル（design g-mwiocibp 判断2）
 * polish の verifier に渡す型・lint 診断の証拠。shell は execute から
 * 呼べないため tool 側で実行・保存し、path を返す（path の渡し忘れ防止）。
 * 実行するのは eval_cmd のみ（任意コマンドを許すと「通るだけのコマンド」で
 * clean な証拠を捏造できる）。合否は eval_cmd の exit code で決める。
 * ================================================================== */

/** 診断の上限。idle eval は上限なしだが、tool call の中で走る diag は
 * ハングするとモデルのバッチごと止めるため打ち切る */
export const DIAG_TIMEOUT_MS = 600_000;
/** 診断ファイルに残す出力の末尾行数（全文は読ませない） */
export const DIAG_TAIL_LINES = 200;

export function diagPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `diag-${goalId}.txt`);
}

/** 診断ファイルの掃除（complete/clear時。退避diffと同じタイミング） */
export function removeDiag(root: string, goalId: string): void {
  if (!/^g-[0-9a-z]+$/.test(goalId)) return;
  try {
    unlinkSync(diagPath(root, goalId));
  } catch {
    // 存在しない・権限なし等は無視
  }
}

export type DiagStatus = "passed" | "failed" | "unset" | "timeout";export interface DiagRun {
  status: DiagStatus;
  command: string | null;
  exitCode: number | null;
  output: string;
}

/** eval_cmd を実行する（diag 専用。fail_streak 等の eval 記録には触れない） */
export async function runDiagCommand(
  root: string,
  cmd: string | null,
  timeoutMs: number = DIAG_TIMEOUT_MS,
): Promise<DiagRun> {
  if (!cmd) return { status: "unset", command: null, exitCode: null, output: "" };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["sh", "-c", cmd], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    return {
      status: "failed",
      command: cmd,
      exitCode: null,
      output: e instanceof Error ? e.message : String(e),
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // kill失敗は無視（timeout の事実はファイルに残る）
    }
  }, timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  const output = [out, err].filter(Boolean).join("\n");
  if (timedOut) return { status: "timeout", command: cmd, exitCode: null, output };
  return { status: code === 0 ? "passed" : "failed", command: cmd, exitCode: code, output };
}

/** 診断結果を .graphhopper/tmp/diag-<goal>.txt に書く（verifier が読む）。
 * diff 指紋は実行後に取る（eval が整形・生成物で作業ツリーを変えても、
 * 直後の diff_stash と指紋が揃う）。 */
export function writeDiagFile(
  root: string,
  goalId: string,
  run: DiagRun,
  diffHash: string | null,
): { path: string; lines: number } {
  const path = diagPath(root, goalId);
  mkdirSync(dirname(path), { recursive: true });
  const tail = run.output.split("\n").slice(-DIAG_TAIL_LINES).join("\n");
  const body = [
    `# diagnostics: ${goalId} (${new Date().toISOString()})`,
    "",
    "## 実行",
    run.command ? `command: ${run.command}` : "command: (eval_cmd 未設定)",
    `status: ${run.status}`,
    run.exitCode === null ? "" : `exit=${run.exitCode}`,
    `diff_hash: ${diffHash ?? "(VCS不能)"}`,
    "",
    run.status === "unset"
      ? "## 診断未実行（eval_cmd 未設定）\n\nこの goal は機械判定のコマンドを設定していない。診断は証拠として使えない。"
      : `## 出力（末尾 ${DIAG_TAIL_LINES} 行）\n\n${tail}`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(path, body, "utf8");
  return { path, lines: body.split("\n").length };
}

export function readDiagDiffHash(root: string, goalId: string): string | null {
  try {
    const raw = readFileSync(diagPath(root, goalId), "utf8");
    const m = raw.match(/^diff_hash: ([0-9a-f]{40})$/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function diagExists(root: string, goalId: string): boolean {
  return existsSync(diagPath(root, goalId));
}

/* ==================================================================
 * verify の lens 結果 sidecar（design g-mwiocibp 判断3）
 * graphhopper_verify が lens ごとの判定を保存し、2回目以降の呼び出しで
 * 同じ diff 指紋なら合成して返す（モデルが前回の判定を書き写さないため）。
 * diff が変わっていたら合成しない（古い判定を新しい diff の証拠にしない）。
 * ================================================================== */

export interface SavedLensResult {
  lens: VerifierLens;
  level: VerdictLevel;
  target?: DriftTarget;
  model?: string;
  severity?: VerifierSeverityCounts;
  /** 前回の指摘の判定（持ち越した角度・siblings のみ） */
  prior?: { valid: number; invalid: number; unresolved: number };
  /** drift の本文（次の diff の指摘ファイルの元。clean は持たない） */
  body?: string;
  summary: string;
}

export interface SavedVerify {
  /** 2＝角度の計画つき（無い旧形式は読まずに捨てる。design g-mwmqmg6b 判断2） */
  v?: 2;
  diff_hash: string;
  plan?: import("./angles").AnglePlan;
  results: SavedLensResult[];
}

export function findingsPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `verify-${goalId}-findings.md`);
}

export function priorFindingsPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `verify-${goalId}-prior.md`);
}

export function verifyResultsPath(root: string, goalId: string): string {
  return join(dir(root), "tmp", `verify-${goalId}.json`);
}

export function removeVerifyResults(root: string, goalId: string): void {
  if (!/^g-[0-9a-z]+$/.test(goalId)) return;
  for (const p of [
    verifyResultsPath(root, goalId),
    findingsPath(root, goalId),
    priorFindingsPath(root, goalId),
  ]) {
    try {
      unlinkSync(p);
    } catch {
      // 存在しない・権限なし等は無視
    }
  }
}

/** 今回の 1 巡目の指摘の本文を書く（追い検証の siblings に渡す） */
export function writeFindings(root: string, goalId: string, text: string): string {
  const p = findingsPath(root, goalId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
  return p;
}

/** 前回の diff の指摘の本文を書く（null なら消す） */
export function writePriorFindings(root: string, goalId: string, text: string | null): void {
  const p = priorFindingsPath(root, goalId);
  if (text === null) {
    try {
      unlinkSync(p);
    } catch {
      // 無ければ何もしない
    }
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}

export function readSavedVerify(root: string, goalId: string): SavedVerify | null {
  try {
    const raw = JSON.parse(readFileSync(verifyResultsPath(root, goalId), "utf8")) as unknown;
    const v = raw as { diff_hash?: unknown; results?: unknown };
    if (typeof v.diff_hash !== "string" || !Array.isArray(v.results)) return null;
    const sv = v as unknown as SavedVerify;
    if (sv.v !== 2 || !sv.plan || !Array.isArray(sv.plan.entries)) return null;
    return sv;
  } catch {
    return null;
  }
}

export function writeSavedVerify(root: string, goalId: string, data: SavedVerify): void {
  const path = verifyResultsPath(root, goalId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/** eval_cmd をシェルで実際に実行し、exit codeで機械的に合否判定する（自己申告に依存しない） */
export async function runEval(
  shell: Shell,
  root: string,
  cmd: string,
): Promise<EvalResult> {
  try {
    const r = await shell`sh -c ${cmd}`.cwd(root).nothrow().quiet();
    const output = [r.stdout.toString(), r.stderr.toString()]
      .filter(Boolean)
      .join("\n");
    return { ok: r.exitCode === 0, output };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function recordAttempt(
  root: string,
  ok: boolean,
  note: string,
  opts?: {
    /** ツールの自己申告（graphhopper_attempt）か。idle の eval からの呼び出しは false */
    selfReported?: boolean;
  },
): AttemptResult {
  const state = readState(root);
  /* eval_cmd がある間は合否を eval が決める。自己申告の ok ではカウンタを戻さない
   * （attempt(ok:true) を 1 回呼ぶだけで eval の連続失敗を消せてしまうため。design g-mwoiwjif 決めたこと7） */
  const keepProgress = ok && opts?.selfReported === true && !!state.eval_cmd;
  const fail_streak = ok ? (keepProgress ? state.fail_streak : 0) : state.fail_streak + 1;
  // ok は進展の証拠: edit 堂々巡り・diff 停滞もリセットする
  // （idle の eval 経路と attempt(ok) 自己申告経路の両方に効く）
  writeState(root, {
    ...state,
    fail_streak,
    notes: note || state.notes,
    ...(ok && !keepProgress
      ? { edit_file: null, edit_streak: 0, diff_stall: 0 }
      : {}),
  });
  const cfg = readConfig(root);
  const escalate = !ok && fail_streak >= cfg.stuck_threshold;
  const giveUp =
    !ok && cfg.max_eval_fails > 0 && fail_streak >= cfg.max_eval_fails;
  if (state.goal_id) {
    recordEvent(root, {
      type: "attempt",
      goal: state.goal_id,
      ok,
      fail_streak,
      note,
    });
  }
  return { fail_streak, escalate, giveUp, kept_progress: keepProgress };
}

/* ================================================================== *
 * stuck 信号の追加: fail_streak（連続失敗）に加え、同一ファイル再編集と
 * diff 停滞を機械カウントし、いずれかが閾値で oracle への相談を促す。
 * 「相談」と「諦め (giveUp)」は別軸——こちらは pause しない。
 * ================================================================== */

/** 同一ファイル連続編集の純粋遷移。同一 → +1、別 → リセット */
export function nextEditStreak(
  prev: { file: string | null; streak: number },
  file: string,
): { file: string; streak: number } {
  if (prev.file === file) return { file, streak: prev.streak + 1 };
  return { file, streak: 1 };
}

/** edit/write 成功時に同一ファイル streak を更新する */
export function noteEdit(root: string, filePath: string): LoopState {
  const state = readState(root);
  const next = nextEditStreak(
    { file: state.edit_file, streak: state.edit_streak },
    filePath,
  );
  const updated: LoopState = {
    ...state,
    edit_file: next.file,
    edit_streak: next.streak,
  };
  writeState(root, updated);
  return updated;
}

/** ワーキングコピー差分（親比）の行数を測る。stateless 測定のため
 * baseline 不要。jj → git fallback。両失敗時は null（何もしない）。
 * `.graphhopper/` の作業ファイルは数えない（履歴が毎ターン伸びて停滞検知が効かなくなるため。
 * design g-mwiu6lcj）。設定 2 つは数える。 */
export async function measureWorkingCopyLines(
  shell: Shell,
  root: string,
): Promise<number | null> {
  try {
    const r = await shell`jj diff --stat -- ${[ghFileset()]}`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
      // stat 出力なし（差分ゼロ）の判定: 空出力なら 0
      if (r.stdout.toString().trim() === "") return 0;
    }
  } catch {
    // ignore
  }
  try {
    const all = await shell`git diff --shortstat -- ${ghAllSpec()}`.cwd(root).nothrow().quiet();
    const keep = await shell`git diff --shortstat -- ${ghKeepSpec()}`.cwd(root).nothrow().quiet();
    if (all.exitCode !== 0 || keep.exitCode !== 0) return null;
    // 空出力は 0、パース不能は測定不能（null）
    const one = (out: string): number | null => {
      const t = out.trim();
      return t === "" ? 0 : parseDiffShortstat(t);
    };
    const a = one(all.stdout.toString());
    const k = one(keep.stdout.toString());
    if (a === null || k === null) return null;
    return a + k;
  } catch {
    // ignore
  }
  return null;
}

/** diff 停滞の純粋遷移。同一行数 → +1、変化・測定不能 → リセット */
export function nextDiffStall(
  prev: { lines: number | null; stall: number },
  lines: number | null,
): { lines: number | null; stall: number } {
  if (lines === null) return { lines: prev.lines, stall: 0 };
  if (prev.lines === lines) return { lines, stall: prev.stall + 1 };
  return { lines, stall: 0 };
}

/** diff 停滞を更新する（測定不能時は現状維持） */
export function noteDiffLines(
  root: string,
  lines: number | null,
): LoopState {
  const state = readState(root);
  const next = nextDiffStall(
    { lines: state.last_diff_lines, stall: state.diff_stall },
    lines,
  );
  const updated: LoopState = {
    ...state,
    last_diff_lines: next.lines,
    diff_stall: next.stall,
  };
  writeState(root, updated);
  return updated;
}

export interface StuckStatus {
  escalate: boolean;
  reasons: string[];
}

/** 進捗停滞シグナルの集約判定（読み取り専用。書き込みは note 系に分離）。
 * 同一ファイル再編集・diff 停滞の OR。fail_streak は対象外:
 * 全 caller が r.escalate==false 時のみ参照し、その条件は fail_streak<閾値と
 * 同値のため fail 枝は到達不能（dead につき削除。fail は recordAttempt 側が担う）。
 * 実 history でも stuck_hint 発火は edit/diff 系のみ想定。 */
export function checkStuck(root: string): StuckStatus {
  const cfg = readConfig(root);
  const state = readState(root);
  const reasons: string[] = [];
  if (
    cfg.stuck_edit_repeat > 1 &&
    state.edit_streak >= cfg.stuck_edit_repeat
  ) {
    reasons.push(`edit_repeat(${state.edit_file}×${state.edit_streak})`);
  }
  if (
    cfg.stuck_diff_stall > 1 &&
    state.diff_stall >= cfg.stuck_diff_stall
  ) {
    reasons.push(`diff_stall×${state.diff_stall}`);
  }
  return { escalate: reasons.length > 0, reasons };
}

/** stuck 通知した理由集合を記録する。同一理由なら stuck_hint を出さず
 * false を返す（通知スキップ）。理由変化で true＋イベント記録。 */
export function noteStuckNotified(root: string, reasons: string[]): boolean {
  const state = readState(root);
  const prev = state.last_stuck_reasons;
  const same =
    prev.length === reasons.length && prev.every((r, i) => r === reasons[i]);
  if (same) return false;
  writeState(root, { ...state, last_stuck_reasons: [...reasons] });
  if (state.goal_id) {
    recordEvent(root, {
      type: "stuck_hint",
      goal: state.goal_id,
      reasons: [...reasons],
    });
  }
  return true;
}

/* ================================================================== *
 * design gate（C-2不変条件）: designing フェーズで edit/write を許可パス以外に通さない
 * tool.execute.before hook から呼ばれる純関数（副作用なし）
 * ================================================================== */

import { isAbsolute, normalize, relative, sep } from "node:path";

/** gate判定用に filePath を root 相対・正規化する（`..` 解消・区切り統一）。
 * root 外の絶対パスは `..` 始まりになり、許可prefixに一致しない（fail-closed）。
 * deep検知のパス照合でも使うためexportする（純関数）。 */
export function normalizeForGate(root: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  return normalize(rel).split(sep).join("/");
}

function matchesAllowed(normalized: string, prefix: string): boolean {
  const p = normalize(prefix).split(sep).join("/").replace(/\/+$/, "");
  return normalized === p || normalized.startsWith(`${p}/`);
}

/** `.graphhopper/` 配下か。状態ファイルが読めない間も、修復のためにここだけは書かせる */
export function isUnderGraphhopperDir(root: string, filePath: string): boolean {
  return matchesAllowed(normalizeForGate(root, filePath), ".graphhopper");
}

export function isDesignGateBlocked(
  root: string,
  cfg: GraphhopperConfig,
  phase: Phase,
  filePath: string,
): boolean {
  if (phase !== "designing") return false;
  const n = normalizeForGate(root, filePath);
  return !cfg.design_gate_allow.some((prefix) => matchesAllowed(n, prefix));
}

/** design doc不変化ゲート: designing終了後は該当goalのdesign docへの書き込みを常にブロックする
 * （graphhopper本体 hooks/design-gate.sh の事後編集ブロックと同じ思想）。verifierのdrift検出
 * アンカーとして読むため、実装に合わせて書き直せると「driftをdesign doc側の書き換えで消せる」
 * Goodhart's Lawの穴になる。決定の経緯・進捗は planLogPath（追記専用・ハードゲート無し）へ。
 * design_gate_allow とは独立（designing中はこの関数は常にfalseを返す）。 */
export function isDesignDocLocked(
  root: string,
  phase: Phase,
  goalId: string,
  filePath: string,
): boolean {
  if (phase === "designing") return false;
  // 正規化後の完全一致。`.log.md`（`${goalId}.log.md`）は対象外のまま。
  return (
    normalizeForGate(root, filePath) === `.graphhopper/plans/${goalId}.md`
  );
}

/* ================================================================== *
 * discover（loop-until-dry）: phase graph の外にあるオンデマンド探索。
 * round cap / dedupe を code側で強制する（opencodeにWorkflow相当が無いため、
 * 「尽きるまで周回・でも確実に止まる」の保証をTS toolに持たせる）。
 * dedupeは「既見全体」（reject/未採用も含む）に対して行う——確定済みだけに
 * 対すると、一度リジェクトされたfindingが毎ラウンド再発見されて無限空転する。
 * ================================================================== */

const MAX_DISCOVER_ROUNDS = 8;
const DRY_ROUNDS_TO_STOP = 2;

export interface DiscoverState {
  target: string;
  scope: string;
  round: number;
  dry_streak: number;
  seen: string[];
  confirmed: {
    title: string;
    severity: string;
    confidence: number;
    quote: string;
  }[];
  stopped_reason: "dry" | "max_rounds" | null;
  started_at: string;
  /** 紐付く goal（開始時点の active。無ければ null）。lineage が載せる */
  goal_id: string | null;
}

function discoverPath(root: string): string {
  return join(dir(root), "discover.json");
}

export function startDiscover(
  root: string,
  target: string,
  scope: string,
  goalId: string | null = null,
): DiscoverState {
  const s: DiscoverState = {
    target,
    scope,
    round: 0,
    dry_streak: 0,
    seen: [],
    confirmed: [],
    stopped_reason: null,
    started_at: new Date().toISOString(),
    goal_id: goalId,
  };
  atomicWrite(discoverPath(root), s);
  return s;
}

export function readDiscover(root: string): DiscoverState | null {
  if (!existsSync(discoverPath(root))) return null;
  return readJson<DiscoverState | null>(discoverPath(root), null);
}

export interface DiscoverFinding {
  title: string;
  severity: string;
  confidence: number;
  quote: string;
}

/**
 * 1ラウンド分のfindingsを渡してdedupe・round/dry_streak更新を行う。
 * round capとdry判定はここで機械的に強制する（呼び出し側の自己申告に依存しない）。
 */
export function tickDiscover(
  root: string,
  findings: DiscoverFinding[],
): DiscoverState {
  const s = readDiscover(root);
  if (!s)
    throw new Error("no active discover session. call startDiscover first.");
  if (s.stopped_reason) return s; // 既に停止済みなら何もしない（冪等）

  s.round += 1;
  const seenSet = new Set(s.seen);
  const newOnes = findings.filter((f) => !seenSet.has(f.title));
  for (const f of findings) seenSet.add(f.title); // reject/未採用も含め全件seenに入れる
  s.seen = Array.from(seenSet);

  if (newOnes.length === 0) {
    s.dry_streak += 1;
  } else {
    s.dry_streak = 0;
    const adopted = newOnes.filter(
      (f) =>
        f.confidence >= 80 &&
        (f.severity === "critical" || f.severity === "high"),
    );
    s.confirmed.push(...adopted);
  }

  if (s.dry_streak >= DRY_ROUNDS_TO_STOP) s.stopped_reason = "dry";
  else if (s.round >= MAX_DISCOVER_ROUNDS) s.stopped_reason = "max_rounds";

  atomicWrite(discoverPath(root), s);
  return s;
}

export function clearDiscover(root: string): void {
  if (existsSync(discoverPath(root))) atomicWrite(discoverPath(root), null);
}

/* ================================================================== *
 * lineage（作業グラフの第一歩）: goals.json + history.jsonl から
 * goal ごとの系譜を導出する。scoreboard（buildScoreboard）とテストが読む。
 * graft（コードの構造）に対する「作業の構造」側の edge 素材。
 * ================================================================== */

/** history.jsonl の1行（recordEvent が付与する ts 付き） */
export type HistoryRecord = HistoryEvent & { ts?: string };

export function readHistory(root: string): HistoryRecord[] {
  const p = historyPath(root);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryRecord);
  } catch {
    return [];
  }
}

export interface GoalLineage {
  id: string;
  title: string;
  status: GoalStatus;
  /** 訪れた phase（順序保持・重複なし。先頭は常に designing） */
  phases: Phase[];
  /** polish → implementing の巻き戻し回数（verifier drift の機械証跡） */
  rewinds: number;
  verifier: { level: VerdictLevel; target: DriftTarget | null; lens: VerifierLens[] }[];
  evalRuns: { pass: number; fail: number };
  maxFailStreak: number;
  gateBlocks: number;
  editedFiles: string[];
  routerChecks: { diff_lines: number; route: RouterRoute }[];
  /** complete時の機械採点（未completeは null） */
  score: GoalScore | null;
}

export function buildLineage(root: string): {
  goals: GoalLineage[];
  discover: DiscoverState | null;
} {
  const stored = readGoals(root);
  const byId = new Map<string, GoalLineage>();
  for (const g of stored.goals) {
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      status: g.status,
      phases: ["designing"],
      rewinds: 0,
      verifier: [],
      evalRuns: { pass: 0, fail: 0 },
      maxFailStreak: 0,
      gateBlocks: 0,
      editedFiles: [],
      routerChecks: [],
      score: g.score ?? null,
    });
  }
  const get = (goalId: string): GoalLineage | null => {
    let l = byId.get(goalId);
    if (!l) {
      // goals.json に無い（clear 済み等）が history に残る分は title 不明で計上
      l = {
        id: goalId,
        title: "(unknown)",
        status: "done",
        phases: ["designing"],
        rewinds: 0,
        verifier: [],
          evalRuns: { pass: 0, fail: 0 },
        maxFailStreak: 0,
        gateBlocks: 0,
        editedFiles: [],
        routerChecks: [],
        score: null,
      };
      byId.set(goalId, l);
    }
    return l;
  };
  for (const h of readHistory(root)) {
    const goalId = (h as { goal?: unknown }).goal;
    if (typeof goalId !== "string") continue;
    const l = get(goalId);
    if (!l) continue;
    switch (h.type) {
      case "phase":
        if (!l.phases.includes(h.to)) l.phases.push(h.to);
        if (h.from === "polish" && h.to === "implementing") l.rewinds += 1;
        break;
      case "verifier_verdict":
        l.verifier.push({ level: h.level, target: h.target, lens: h.lens });
        break;
      case "eval_run":
        if (h.ok) l.evalRuns.pass += 1;
        else l.evalRuns.fail += 1;
        break;
      case "attempt":
        if (h.fail_streak > l.maxFailStreak) l.maxFailStreak = h.fail_streak;
        break;
      case "design_gate_block":
      case "design_doc_locked_block":
        l.gateBlocks += 1;
        break;
      case "hash_edit_applied":
        if (!l.editedFiles.includes(h.path)) l.editedFiles.push(h.path);
        break;
      case "router_check":
        l.routerChecks.push({ diff_lines: h.diff_lines, route: h.route });
        break;
      default:
        break;
    }
  }
  return { goals: [...byId.values()], discover: readDiscover(root) };
}

/* ================================================================== *
 * 評価機能（成績表）: モデル×役割の成績表。verdictイベントの model 欄を
 * 集計する。帰属は記録値のみ（推測で紐付けない）。goal転帰は lineage 由来。
 * ================================================================== */

export interface ModelRoleStats {
  model: string;
  role: "verifier";
  verdicts: number;
  clean: number;
  drift: number;
  /** 混成fan-outへの参加数（単一model eventは0。hints注記用） */
  mixed: number;
}

export interface GoalOutcome {
  id: string;
  title: string;
  status: GoalStatus;
  rewinds: number;
  evalPass: number;
  evalFail: number;
  score: number | null;
}

export interface Scoreboard {
  models: ModelRoleStats[];
  goals: GoalOutcome[];
  /** 人間向けの検討事項（提案のみ・自動適用なし。根拠つきで書く） */
  hints: string[];
}

/* hintsのガード値。サンプル不足での断定を防ぐ */
const HINT_MIN_MODEL_SAMPLES = 5;
const HINT_LOW_SCORE = 70;
const HINT_MANY_REWINDS = 2;

export function buildScoreboard(root: string): Scoreboard {
  const byModel = new Map<string, ModelRoleStats>();
  const bump = (
    model: string | null | undefined,
    role: "verifier",
    level: VerdictLevel,
    mixed: boolean,
  ) => {
    const key = `${role}\0${model ?? "(unknown)"}`;
    let s = byModel.get(key);
    if (!s) {
      s = {
        model: model ?? "(unknown)",
        role,
        verdicts: 0,
        clean: 0,
        drift: 0,
        mixed: 0,
      };
      byModel.set(key, s);
    }
    s.verdicts += 1;
    if (level === "clean") s.clean += 1;
    else s.drift += 1;
    if (mixed) s.mixed += 1;
  };
  for (const h of readHistory(root)) {
    if (h.type === "verifier_verdict") {
      // 混成runはdistinct modelごとに行bump（単一modelは従来通り1 bump）。
      // levelは集約値（行内clean/drift整合は保たれる。hintsはper-row）。
      const models = h.models ?? [h.model];
      const distinct = [...new Set(models.map((m) => m ?? "(unknown)"))];
      const mixed = distinct.length > 1;
      for (const m of distinct) {
        bump(m === "(unknown)" ? null : m, "verifier", h.level, mixed);
      }
    }
  }
  const lin = buildLineage(root);
  const goals: GoalOutcome[] = lin.goals.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    rewinds: g.rewinds,
    evalPass: g.evalRuns.pass,
    evalFail: g.evalRuns.fail,
    score: g.score?.value ?? null,
  }));
  const models = [...byModel.values()].sort((a, b) => b.verdicts - a.verdicts);
  return { models, goals, hints: buildHints(models, goals) };
}

/* scoreboard連動のmapping提案（B）。自動適用はしない。
 * drift検出率の高低は「厳格さ」と「実装荒れ」の両義性があるため断定せず、
 * 切り分け材料の提示に留める。サンプル不足は判断保留と明記する */
function buildHints(models: ModelRoleStats[], goals: GoalOutcome[]): string[] {
  const hints: string[] = [];
  for (const m of models) {
    if (m.mixed > 0) {
      hints.push(
        `${m.role} ${m.model}: 混成run ${m.mixed}件含む（帰属は集約level。lens別内訳はhistory参照）`,
      );
    }
    if (m.verdicts < HINT_MIN_MODEL_SAMPLES) {
      hints.push(
        `${m.role} ${m.model}: データ不足（${m.verdicts}件 < ${HINT_MIN_MODEL_SAMPLES}件）。判断保留`,
      );
      continue;
    }
    if (m.role === "verifier") {
      const driftRate = m.drift / m.verdicts;
      if (driftRate >= 0.6) {
        hints.push(
          `${m.model}: drift検出率 ${Math.round(driftRate * 100)}%（${m.verdicts}件）。厳格さと実装荒れの切り分けを推奨`,
        );
      } else if (m.clean === m.verdicts) {
        hints.push(
          `${m.model}: 全clean継続（${m.verdicts}件）。甘い可能性あり。要スポット確認`,
        );
      }
    }
  }
  for (const g of goals) {
    if (g.status === "done" && g.score !== null && g.score < HINT_LOW_SCORE) {
      hints.push(`${g.id} "${g.title}": score ${g.score}（<${HINT_LOW_SCORE}）。要振り返り`);
    }
    if (g.rewinds >= HINT_MANY_REWINDS) {
      hints.push(`${g.id}: 巻き戻し${g.rewinds}回。設計乖離が大きい（決定記録側の要因確認）`);
    }
  }
  return hints;
}
