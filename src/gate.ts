/**
 * gate — design gate・hash検証editの純粋関数＋本体。
 *
 * src/index.ts（plugin entry）から分離したモジュール。
 * 背景: opencodeのplugin loaderはentry moduleの全export値を走査し、
 * 関数でない値（{server}オブジェクトでもない値）があると
 * "Plugin export is not a function" でplugin全体のloadに失敗する。
 * よってentryはplugin関数（Graphhopper）のみをexportし、
 * テスト対象のhelperはここに置く。hashedit.test.tsはここからimportする。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { applySingleEdit, decodeUtf8Strict, sha1Hex, verifyHash } from "./hashedit";
import { PONYTAIL_RULES } from "./ponytail-rules";
import * as state from "./state";
import { checkDecisionRecord } from "./record";
import { todoGateError, todoStoreError } from "./todos";

/* implementing・polish はターン終了で自動継続が積まれるため、本文で質問して止まっても待てない。
 * question ツールで聞けばターンが終わらないので、返事を待てる */
export const ASK_VIA_QUESTION =
  "ユーザーの返事が要るとき（場所・承認・選択）は本文で聞かず question ツールで聞く（本文で聞いてターンを終えると自動継続が空回りする）。";

const DESIGNING_ACTION =
  "ユーザーと合意を取る（grilling）。決める項目ごとに、推奨を添えた質問を本文に書き、答えを待つ（designing の間は自動継続が止まる）。" +
  "答えが出そろったら .graphhopper/plans/<goal-id>.md を「決めたこと／やらないこと／完了の確かめ方」の3見出しで埋め、" +
  "最終確認なしで graphhopper_phase(phase: 'implementing') へ進む。source編集はここではブロックされる。" +
  "判断に自信がなければ graphhopper_invoke(agent: 'graphhopper-advisor') に会話の path を渡して第二意見を取ってよい（任意）。" +
  "この文書は designing を抜けると不変になる（verifierのdrift検出アンカー）。経緯・進捗は .graphhopper/plans/<goal-id>.log.md に追記する。";

/* フェーズごとの次のアクション指示文（tool 応答・注入文の単一源泉）。
 * plugin entry（index.ts）には置けない（loaderが非関数exportでload失敗するため）。
 * 内容を変えたら tool 応答と注入文の両方に反映される。 */
export const PHASE_ACTION: Record<state.Phase, string> = {
  designing: DESIGNING_ACTION,
  implementing:
    "決定記録の「決めたこと」を実装する。長い作業のときは graphhopper_todo(add) で残り作業を置ける（任意）。置いた分は polish の前に done か cancel で閉じる（未完了が残ると polish へ進めない）。goal中のsource編集は graphhopper_edit（hash検証付き）を使え、素のedit/writeはフォールバック。まず graphhopper_set_eval(cmd) で合否を機械判定できるコマンド（テスト/lint/typecheck）を1度設定せよ。設定後はターン終了ごとに自動実行され、passならpolishへ自動遷移、failならfail_streakが機械カウントされ、stuck通知が来たら graphhopper_invoke(agent: 'graphhopper-oracle') に相談する。eval_cmdが無い（機械判定できない）場合のみ graphhopper_attempt(ok, note) の自己申告にフォールバックする。外部公式doc裏付けが必要なら graphhopper_invoke(agent: 'graphhopper-librarian') を使える。" + ASK_VIA_QUESTION,
  polish:
    "Code Mode のレシピを実行する: skills/graphhopper/refs/verifier.md の recipe: start → recipe: tail を上から順に execute に貼る（advisorは1バッチ、polishは start→simplify適用→tail の2バッチ）。simplify は route=polish のときだけ（router_check の simplify）。適用はメインが Read と edit で行い、critical は挙動不変・局所のみ自動、high は人間確認、medium/note は報告のみ。順序は diag → diff_stash → verify（graphhopper_verify が指紋3つを照合する）。第三者チェック（verifier）は省略不可、level/target の集約は verifier_set が機械で行う。" + ASK_VIA_QUESTION,
  done: "完了済み。graphhopper_goal(action: 'complete') を確認",
};

/* continuation（turn 終了 → promptAsync）のuser向け表示用の1行要約。
 * LLM向けの詳細指示は PHASE_ACTION を phase 案内（instructions.entry）で渡す
 * （design g-mwj6481n 判断4）。done は continuation 自体が発火しない（idle ハンドラが
 * phase==="done" で早期return）ため実質未使用だが、Record の型完全性のために残す。 */
export const PHASE_ACTION_SHORT: Record<state.Phase, string> = {
  designing: "ユーザーに質問して合意を取り、決定記録を書いてimplementingへ",
  implementing: "決定記録の「決めたこと」を実装し、eval_cmdを設定。足した進捗タスクの完了はgraphhopper_todoで申告",
  polish: "router_checkのrouteに従いsimplify/verifierを実行",
  done: "goalをcompleteする",
};

/* decide toolの2択criteriaは decision.ts DECISION_ROUTE_CRITERIA に一本化
 *（旧JEV_ROUTE_PROMPTの判定基準を移植）。gate.tsにはLLM用promptを残さない */

/** 現在の goal の phase 案内（instructions.entry の値）。design g-mwj6481n 判断4。
 *
 * - 対象は「active・phase が done 以外・そのセッションに bind 済み」のときだけ。それ以外は null
 *   （呼び出し側は remove する）。
 * - 中身は goal の題と id・phase・PHASE_ACTION の全文。implementing では
 *   PONYTAIL_RULES を後ろに付ける。
 * - 同じ phase の間は値が変わらない（fail_streak・notes・タスク件数を入れない）。
 *   変わると毎回全文が再送される（判断4）。 */
export function phaseGuideText(active: state.ActiveLoop | null, sessionID: string): string | null {
  if (!active) return null;
  if (active.goal.status !== "active") return null;
  if (active.state.phase === "done") return null;
  if (!sessionID || active.state.session_id !== sessionID) return null;
  const head = [
    "## graphhopper 次のアクション",
    "",
    `goal: "${active.goal.title}" (${active.goal.id}) / phase: ${active.state.phase}（新しい案内が来たらこちらが正）`,
    "",
    PHASE_ACTION[active.state.phase],
  ].join("\n");
  return active.state.phase === "implementing" ? `${head}\n\n${PONYTAIL_RULES}` : head;
}

/* stuck 時に oracle へ相談させる定型文（idle eval・attempt・stuck 検知の単一源泉）。
 * 相談は同期の graphhopper_invoke で行う（task() だと同じターンで助言を受け取れない）。 */
export const ORACLE_ASK =
  "graphhopper_invoke(agent: 'graphhopper-oracle') に相談せよ。これまでの失敗試行（何を試して何が起きたか）を prompt に渡すこと。";

/* （旧buildJevPromptは削除。入口判定は decision.ts のdecideRouteに移管） */

/* design gate・信号A計数の対象tool（D2a/D2b）。before/after両hookで共有する
 * 単一の真実源。3名のいずれかが漏れると新tool経由でgate/stuck検知が
 * バイパスされるため、hashedit.test.tsで機械検証する。 */
export const GATE_TARGET_TOOLS = ["write", "edit", "graphhopper_edit"] as const;

export function isGateTargetTool(toolName: string | undefined): boolean {
  return (
    typeof toolName === "string" &&
    (GATE_TARGET_TOOLS as readonly string[]).includes(toolName.toLowerCase())
  );
}

/* graphhopper_edit executeの事前判定（D2c＋goal外仕様）。純粋関数として
 * 分離し機械検証する。拒否はthrow（after計数に混入しない。万一afterが
 * throw時にも発火する実装でもstreak加算はfail-closed側＝早期escalateに倒れる）。 */
export type HashEditAccess = "ok" | "no-goal" | "subagent";

export function checkHashEditAccess(
  sessionID: string | undefined,
  mainSessionID: string | null | undefined,
  hasActiveGoal: boolean,
): HashEditAccess {
  if (!hasActiveGoal) return "no-goal";
  // 未バインド（session削除後等）はgoal外扱い。design D2の
  // 「active goalなし、または state.session_id がnull」条項。
  if (!mainSessionID) return "no-goal";
  if (!sessionID || sessionID !== mainSessionID) return "subagent";
  return "ok";
}

/* graphhopper_hash の本体（exportして機械検証する）。
 * hash基準は graphhopper_edit と揃えてutf8デコード文字列とする
 * （生バイトだと非UTF-8でペア不整合になる。F3対応）。 */
export interface FileHash {
  path: string;
  sha1: string;
  size: number;
  mtime: string;
}

/** hash の構造化版（plugin tool の output 用。design g-mwiocibp 判断1） */
export function readGraphhopperHashValue(root: string, filePath: string): FileHash {
  const p = isAbsolute(filePath) ? filePath : join(root, filePath);
  const content = decodeUtf8Strict(readFileSync(p));
  const st = statSync(p);
  return {
    path: filePath,
    sha1: sha1Hex(content),
    size: Buffer.byteLength(content, "utf8"),
    mtime: st.mtime.toISOString(),
  };
}

export interface HashEditArgs {
  filePath: string;
  expectedHash: string;
  oldString: string;
  newString: string;
}

/* graphhopper_edit の本体（exportして機械検証する）。
 * tool.execute の薄いラッパーにし、分岐→アクション対応
 * （no-goal→軟質return / subagent→throw / 拒否→記録+throw /
 * 成功→記録+新hash返却）をテストで固定する。 */
export function runGraphhopperEdit(
  root: string,
  sessionID: string | undefined,
  args: HashEditArgs,
): string {
  const active = state.getActive(root);
  const access = checkHashEditAccess(
    sessionID,
    active?.state.session_id,
    !!active && active.goal.status === "active",
  );
  if (access === "no-goal") {
    /* 状態ファイルが読めないときは「goal なし」と言わない（plain edit も止まっているため。g-mwoernih 決めたこと4） */
    return (
      state.unreadableStateNotice(root) ??
      "error: no active goal (use plain edit as fallback, no event recorded)"
    );
  }
  if (access === "subagent") {
    throw new Error(
      "Refused: graphhopper_edit from subagent session is blocked (read-only invariant)",
    );
  }
  if (!active) return state.unreadableStateNotice(root) ?? "error: no active goal (unexpected)";
  const p = isAbsolute(args.filePath)
    ? args.filePath
    : join(root, args.filePath);
  let content: string;
  try {
    content = decodeUtf8Strict(readFileSync(p));
  } catch (e) {
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason: e instanceof Error ? e.message : String(e),
    });
    throw new Error(
      `hash_edit_refused: cannot read ${args.filePath} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  try {
    verifyHash(content, args.expectedHash);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason,
    });
    throw e instanceof Error ? e : new Error(reason);
  }
  let next: string;
  try {
    next = applySingleEdit(content, args.oldString, args.newString);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason,
    });
    throw e instanceof Error ? e : new Error(reason);
  }
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, p);
  state.recordEvent(root, {
    type: "hash_edit_applied",
    goal: active.goal.id,
    path: args.filePath,
  });
  return JSON.stringify({
    path: args.filePath,
    sha1: sha1Hex(next),
    size: Buffer.byteLength(next, "utf8"),
  });
}

/* 拒否文の単一源泉（hook の throw 文と tool の error 返却で共有）。
 * 文面を変えると両方の応答に反映される。 */
/** 状態ファイルが読めない間の安全側ゲート（g-mwoernih 決めたこと3）。
 * phase を判断できないので、designing 中の編集ブロックを外さないよう source 編集を止める。
 * `.graphhopper/` 配下は修復用に通す（判定は hooks 側で isUnderGraphhopperDir）。 */
export function unreadableStateRefusal(
  toolName: string | undefined,
  filePath: string,
): string {
  return (
    `Refused: ${toolName} to ${filePath} is blocked because graphhopper's state files ` +
    `(.graphhopper/goals.json / state.json) are unreadable. The phase cannot be determined, ` +
    `so source edits are stopped instead of silently bypassing the designing gate. ` +
    `Fix or remove the broken file first.`
  );
}

export function designGateRefusal(
  toolName: string | undefined,
  filePath: string,
  allow: string[],
): string {
  return (
    `Refused: ${toolName} to ${filePath} is blocked because the goal is in the "designing" phase. ` +
    `Only paths under ${allow.join(", ")} may be written while designing. ` +
    `Write the design doc first, then graphhopper_phase(phase: "implementing") before editing source.`
  );
}

/** AI が読んで従うルール文書か（usability 確認の対象。design g-mwfltxyt 判断1）。
 * 生成物 .opencode/agents/*.md は含めない（src/agents.ts が単一源泉） */
export function isPolicyDocPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/(^|\/)AGENTS\.md$/.test(p)) return true;
  if (/(^|\/)skills\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return true;
  if (/(^|\/)src\/agents\.ts$/.test(p)) return true;
  return false;
}

/** 変更ファイルからルール文書だけを抽出する（goal 開始前からの dirty は除外。判断8） */
export function policyDocsChanged(
  files: string[],
  initialFiles: string[] | null | undefined,
): string[] {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const init = new Set((initialFiles ?? []).map(norm));
  return [...new Set(files.map(norm))].filter(
    (f) => isPolicyDocPath(f) && !init.has(f),
  );
}

/** usability ゲート（design g-mwfltxyt 判断4, 5）。
 * 対象文書が変わっていなければ null。記録なし・drift・レビュー後の変更は拒否文。 */
export function usabilityGateRefusal(
  review: {
    level: "clean" | "drift" | "skipped";
    reason: string;
    files: string[];
    doc_hash: string | null;
  } | null,
  docsChanged: string[],
  currentHash: string | null,
): string | null {
  if (docsChanged.length === 0) return null;
  const list =
    docsChanged.slice(0, 5).join(", ") +
    (docsChanged.length > 5 ? ` ほか${docsChanged.length - 5}件` : "");
  if (!review) {
    return (
      `error: ルール文書が変更されています（${list}）。` +
      "graphhopper-usability で確認して graphhopper_usability_set に記録するか、" +
      "不要と判断した理由を skipped で記録してください（force: true で完了も可）。"
    );
  }
  if (review.level === "drift") {
    return `error: usability レビューが drift です（${review.reason}）。指摘を直して再実行し、graphhopper_usability_set で clean を記録してください。`;
  }
  const uncovered = docsChanged.filter((f) => !review.files.includes(f));
  if (uncovered.length > 0) {
    return `error: usability レビューの対象に含まれない文書が変更されています（${uncovered.join(", ")}）。再実行して記録し直してください（force: true で完了も可）。`;
  }
  if (!review.doc_hash) {
    return "error: usability レビューの指紋が記録されていません。再実行して記録し直してください（force: true で完了も可）。";
  }
  if (currentHash && review.doc_hash !== currentHash) {
    return "error: usability レビューの後にルール文書が変わっています。再実行して記録し直してください（force: true で完了も可）。";
  }
  return null;
}

/** status 用の1行（文言の単一源泉）。stale＝レビュー後に文書が変わった */
export function formatUsabilityLine(
  review: { level: string; reason: string; files: string[] } | null,
  stale: boolean,
): string {
  if (!review) return "usability: (none)";
  const files = review.files.length ? ` (${review.files.join(", ")})` : "";
  return `usability: ${review.level}${stale ? "（レビュー後に変更あり）" : ""} — ${review.reason}${files}`;
}

/** 意図ログは goal 開始時の一次情報なので、全 phase で編集を拒否する（design g-mwebh9vl） */
export function isIntentLogPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  return /(^|\/)\.graphhopper\/plans\/[^/]+\.intent\.md$/.test(p);
}

export function designDocLockedRefusal(
  toolName: string | undefined,
  filePath: string,
  goalId: string,
): string {
  return (
    `Refused: ${toolName} to ${filePath} is blocked because the design doc is immutable once the "designing" phase ends ` +
    `(it anchors verifier drift detection — rewriting it to match the implementation would let drift be erased by editing the doc instead of fixing the code). ` +
    `Record decisions/rejected alternatives/progress in .graphhopper/plans/${goalId}.log.md instead (no gate on that path).`
  );
}

/* eval_cmd運用中のattempt二重計数への注意文（prose→codeの一歩目。拒否ではなく注意に留める）。
 * eval_cmd 設定中の attempt(ok:true) はもはやカウンタを戻さない（design g-mwoiwjif）ので、
 * 害が残るのは fail 系の二重計上だけ */
export const EVAL_MANAGED_NOTE =
  "（note: eval_cmd設定中のためfail系はeval側でも計数される。evalかattemptのどちらかに寄せ、二重計上に注意せよ）";

function readDesignRaw(root: string, goalId: string): string | null {
  try {
    return decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return null;
  }
}

/* phase遷移前の機械チェック（hook と tool の両 caller で共有）。
 * 通れば null、ダメならそのまま返す error 文。 */
export function checkPhaseMove(
  root: string,
  to: state.Phase,
): string | null {
  const active = state.getActive(root);
  if (!active) return state.unreadableStateNotice(root) ?? "error: no active goal";
  if (!state.isLegalPhaseTransition(active.state.phase, to)) {
    return (
      `error: 非法遷移 ${active.state.phase} -> ${to}。` +
      `合法遷移: ${state.LEGAL_TRANSITIONS[active.state.phase].join(", ")}。` +
      `doneへは graphhopper_goal(complete) のみ（verifier cleanガード付き）。`
    );
  }
  if (to === "implementing" && active.state.phase === "designing") {
    const problems = checkDecisionRecord(readDesignRaw(root, active.goal.id));
    if (problems.length > 0) {
      return (
        `error: 決定記録（.graphhopper/plans/${active.goal.id}.md）が検査を通らない。\n- ` +
        problems.join("\n- ") +
        "\n3つの見出しを埋めてから implementing へ遷移せよ（検査は見出しと空でないことだけ）。"
      );
    }
  }
  // 進捗ゲート: implementing→polish は未完了タスクを残さない。
  // 実効ゲートは state.setPhaseChecked（eval 自動遷移経路を含む）だが、
  // 手動遷移は checkPhaseMove を先に通るためここで同じ判定を見る（文言は同一の純粋関数）。
  if (to === "polish" && active.state.phase === "implementing") {
    const loaded = state.readTodosStatus(root, active.goal.id);
    const storeErr = todoStoreError(loaded);
    if (storeErr) {
      state.recordEvent(root, {
        type: "todo_seed_warning",
        goal: active.goal.id,
        reason: `polish への遷移を拒否した（fail-closed）: ${storeErr}`,
      });
      return `error: ${storeErr}`;
    }
    const err = todoGateError(loaded.store);
    if (err) return `error: ${err}`;
  }
  return null;
}

/* continuation文面の単一源泉（plugin idle注入用）。長いという指摘に応え、
 * 状態で3段階に変える（hand-back待ち/静穏時/通常）。長いフィールドは丸める。
 * 詳細は graphhopper_status / resources で引けるため、注入文は喚起に徹する */
const TRUNC_EVAL_CMD = 120;
const TRUNC_REASON = 200;

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function continuationText(goal: state.Goal, s: state.LoopState): string {
  const head = `[graphhopper] Goal: "${goal.title}" | phase: ${s.phase}`;
  const notes = s.notes ? `notes: ${s.notes}` : null;
  const v = s.last_verifier;
  // hand-back待ち（drift→design/requirements）: 要旨のみ。詳細はstatusで
  if (v && v.level === "drift" && v.target && v.target !== "implementing") {
    return [
      head,
      `→ 人間の hand-back 待ち (drift -> ${v.target})`,
      trunc(v.reason, TRUNC_REASON),
      notes,
      ASK_VIA_QUESTION,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const busy = s.fail_streak > 0 || v || s.router.route || s.eval_cmd;
  // 静穏時（進捗も異常もなし）: 最小表示
  if (!busy) {
    return [
      head,
      notes,
      `Next: ${PHASE_ACTION_SHORT[s.phase]}`,
      `フェーズのexit条件を満たしたら graphhopper_phase で遷移する。${ASK_VIA_QUESTION}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  // 通常: 現行項目＋長いフィールドは丸める
  return [
    head,
    notes,
    s.eval_cmd ? `eval_cmd: ${trunc(s.eval_cmd, TRUNC_EVAL_CMD)}` : null,
    s.router.route
      ? `router: route=${s.router.route} diff_lines=${s.router.diff_lines}${s.router.deep ? " deep" : ""}`
      : null,
    v ? `last_verifier: ${v.level} (${trunc(v.reason, TRUNC_REASON)})` : null,
    s.fail_streak > 0 ? `fail_streak: ${s.fail_streak}` : null,
    `Next: ${PHASE_ACTION_SHORT[s.phase]}`,
    "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
    "ブロックしたら回らずに理由を述べて停止。完了したら graphhopper_goal(complete)。無駄な空転は禁止。",
    ASK_VIA_QUESTION,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * goal の再開文脈（compact・handoff 共通の単一源泉）。
 * 要約や別セッションへ渡しても、続きに必要な事実（phase・次の手・残タスク・文書の場所）を失わせない。
 */
export function goalResumeContext(
  root: string,
  opts: { includeLoop?: boolean } = {},
): string | null {
  const active = state.getActive(root);
  if (!active || active.goal.status !== "active") return null;
  const { goal, state: s } = active;
  const progress = state.todoSummaryLine(root, goal.id);
  const store = state.readTodosStatus(root, goal.id);
  const open = store.valid
    ? store.store.items
        .filter((i) => i.status === "pending" || i.status === "in_progress")
        .slice(0, 8)
        .map((i) => `  - ${i.id}: ${i.text}`)
    : [];
  return [
    `- goal: "${goal.title}" (${goal.id}) [${goal.status}]`,
    `- phase: ${s.phase}`,
    `- 次のアクション: ${PHASE_ACTION[s.phase]}`,
    s.notes ? `- notes: ${s.notes}` : null,
    s.eval_cmd ? `- eval_cmd: ${s.eval_cmd}` : null,
    progress ? `- ${progress}` : null,
    open.length ? `- 未完了タスク:\n${open.join("\n")}` : null,
    s.fail_streak > 0 ? `- fail_streak: ${s.fail_streak}` : null,
    s.last_verifier ? `- last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})` : null,
    `- design doc: .graphhopper/plans/${goal.id}.md（designing終了後は不変）`,
    s.intent_path
      ? `- intent log: ${s.intent_path}（goal開始時の会話と designing 中の質問と答え。agreement 角度と advisor 用）`
      : null,
    state.planLogExists(root, goal.id)
      ? `- log: .graphhopper/plans/${goal.id}.log.md（決定の経緯・棄却した代替案）`
      : null,
    opts.includeLoop
      ? `- loop: stop_count=${s.loop_stop_count}/${state.readConfig(root).loop_stop_max} resume_blocked=${state.isResumeBlocked(root)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}
