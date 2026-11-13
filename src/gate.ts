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
import * as state from "./state";
import { parseTaskLines, todoGateError, todoStoreError } from "./todos";

/* フェーズごとの次のアクション指示文（plugin tool応答・MCP応答の単一源泉）。
 * plugin entry（index.ts）には置けない（loaderが非関数exportでload失敗するため）。
 * 内容を変えたらplugin/MCP両方の応答に反映される。 */
export const PHASE_ACTION: Record<state.Phase, string> = {
  designing:
    "goalを理解し、設計判断・実装タスク列を .graphhopper/plans/<goal-id>.md に書く。source編集はここではブロックされる。書けたら task(subagent_type: 'graphhopper-critic') で設計を1回敵対レビューし、指摘を design.md に反映してから graphhopper_phase(phase: 'implementing') へ（任意で graphhopper_critic_set に結果を記録できる。opt-inでphase遷移の前提条件ではない）。design.md はこのフェーズを抜けた後は不変になる（verifierのdrift検出アンカーのため）——決定の経緯・棄却した代替案・進捗はここで固めず、実装中は .graphhopper/plans/<goal-id>.log.md に追記すること",
  implementing:
    "design.md のタスクを実装する。進捗タスク（.graphhopper/todos/）は graphhopper_todo で完了・cancel を申告する（全タスクが completed か cancelled でないと polish へ進めない）。goal中のsource編集は graphhopper_edit（hash検証付き）を使え、素のedit/writeはフォールバック。まず graphhopper_set_eval(cmd) で合否を機械判定できるコマンド（テスト/lint/typecheck）を1度設定せよ。設定後はターン終了ごとに自動実行され、passならpolishへ自動遷移、failならfail_streakが機械カウントされ、escalateが返ったら task(subagent_type: 'graphhopper-oracle') に相談する。eval_cmdが無い（機械判定できない）場合のみ graphhopper_attempt(ok, note) の自己申告にフォールバックする。外部公式doc裏付けが必要なら task(subagent_type: 'graphhopper-librarian') を使える",
  polish:
    "graphhopper_router_check の route に従う。route=polish（大diff）ならまず simplify を実行する: メインが graphhopper_diff_stash で diff を退避し（verifierと同一ファイルを共用）、返却pathを task(subagent_type: 'graphhopper-simplify') に渡して提案を集める（3レンズ統合）。適用はメインが行う: 各 finding を Read で裏付け、critical は挙動不変・局所的なものだけ自動適用、high は人間確認、medium/note は報告のみ。適用後は eval_cmd を再実行して機械確認。route=advisor（小diff）なら simplify はスキップ。verifier 呼び出しの前にメインが型・lint診断を1回実行し .graphhopper/tmp/diag-<goal>.txt に保存してpathを渡す（verifierの個別実行は禁止。添付無しならverifierは「診断未実行」を明記）。その後 verifier: route=polish なら requirement/behavior/progress の3lensで、route=advisor なら general lens で task(subagent_type: 'graphhopper-verifier') を呼び、verifierは添付診断を裏付けに使え（診断クリーン≠driftなし）。周辺探索は graft-first（漁り読み禁止）。結果を graphhopper_verifier_set で記録。集約 clean で graphhopper_phase(phase: 'done') へ。集約 drift かつ target=implementing なら implementing に戻る。advisor でも第三者チェック（verifier）は省略不可",
  done: "完了済み。graphhopper_goal(action: 'complete') を確認",
};

/* continuation（turn 終了 → promptAsync）のuser向け表示用の1行要約。
 * LLM向けの詳細指示は PHASE_ACTION のまま chat.system.transform 側で注入する
 * （design g-mtwhdb4t）。done は continuation 自体が発火しない（idle ハンドラが
 * phase==="done" で早期return）ため実質未使用だが、Record の型完全性のために残す。 */
export const PHASE_ACTION_SHORT: Record<state.Phase, string> = {
  designing: "設計ドキュメントを書き、criticレビュー後にimplementingへ",
  implementing: "design.mdのタスクを実装し、eval_cmdを設定。タスク完了はgraphhopper_todoで申告",
  polish: "router_checkのrouteに従いsimplify/verifierを実行",
  done: "goalをcompleteする",
};

/* system注入の短縮版（2回目以降のターン用）。hard制約のみ残す。
 * 強制力はコード側ゲートが担うため、文面短縮は安全性を下げない。
 * ponytail短縮行と対で使う */
export const PHASE_ACTION_BRIEF: Record<state.Phase, string> = {
  designing: "design.mdを書け。source編集不可（plans/のみ）。詳細は初回指示参照",
  implementing: "実装続行。eval設定済みなら自動判定。詰まったらoracle。タスク完了はgraphhopper_todoで申告",
  polish: "router→verifier必須（verifier_set記録）。自己レビュー完結不可",
  done: "goalをcompleteする",
};

/** ponytail短縮行（implementing 2ターン目以降用） */
export const PONYTAIL_BRIEF =
  "ponytail継続適用: YAGNI・怠惰原則（詳細は初回注入参照）。interface変更はhigh扱いで人間に提示";

/* decide toolの5択criteriaは decision.ts DECISION_ROUTE_CRITERIA に一本化
 *（旧JEV_ROUTE_PROMPTの判定基準を移植）。gate.tsにはLLM用promptを残さない */

/* jev出力の厳密parse。未知値・非JSON・空はfullに倒す（fail-safe＝重い側）。
 * 旧A/B/C（bare・JSON内）も受理しfull/light/directに写像する。
 * 未呼び出し（null）はstate側でnull＝fullとして扱う */
export function parseEntryRoute(text: string | null | undefined): {
  route: state.EntryRoute;
  reason: string;
} {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { route: "full", reason: "未呼び出し→full" };
  }
  // bare入力（route_setのschemaが素の値を受け付けるため先に照合。旧A/B/C互換）
  const normalized = state.normalizeEntryRoute(text);
  if (normalized) {
    return { route: normalized, reason: "判定（bare）" };
  }
  const m = text.match(/\{[^{}]*"route"\s*:\s*"([A-Za-z]+)"[^{}]*\}/);
  const parsed = state.normalizeEntryRoute(m?.[1]);
  if (parsed) {
    return { route: parsed, reason: "判定" };
  }
  return { route: "full", reason: "parse失敗→full" };
}

/* route別phase指示（effective route）。light/advisedはcritic省略・verifier×1の注記を付与。
 * oracleは開始時相談の注記を付与。transform注入・tool応答の単一源泉 */
export function effectivePhaseAction(
  phase: state.Phase,
  entryRoute: state.EntryRoute | null,
): string {
  const base = PHASE_ACTION[phase];
  if (entryRoute === "light" || entryRoute === "advised") {
    const advisor =
      entryRoute === "advised"
        ? "implementing前にtask(graphhopper-advisor)／graphhopper_invoke(agent: 'graphhopper-advisor')で相談1回し、graphhopper_consult_set(kind: 'advisor')で記録（機械ゲート）。"
        : "";
    const note =
      `（entry_route=${entryRoute}軽量: designingは内容規約（判断の理由・代替案・反証条件、§5 触らないもの、§2 の file:line 証拠、§4 のタスク紐付け）を満たすこと。critic省略、` +
      `polishのverifierはgeneral×1。${advisor}` +
      "詰まったらgraphhopper_escalateでfullへ昇格）";
    // 単一源泉則: light/advised designingもPHASE_ACTION.designingを基にし、差分は例外条項で明示する
    return `${base}${note}`;
  }
  if (entryRoute === "oracle") {
    return (
      `${base}（entry_route=oracle多角: 開始時にtask(graphhopper-oracle)／` +
      "graphhopper_invoke(agent: 'graphhopper-oracle')で相談1回し、graphhopper_consult_set(kind: 'oracle')で記録（機械ゲート）。stuck時は同session継続）"
    );
  }
  return base;
}

/* 昇格後の次アクション定型文（plugin/MCPの昇格系3箇所の単一源泉） */
export const ESCALATE_NEXT =
  "次: design.mdを肉付けし、task(graphhopper-critic)／graphhopper_invoke(agent: 'graphhopper-critic')で1回レビューしてから implementing へ。polishでは verifier fan-out×3（requirement/behavior/progress）が必須。";

/* （旧buildJevPromptは削除。入口判定は decision.ts のdecideRouteに移管） */

/* （旧SELECTOR_PROMPT／buildSelectorPrompt／parseSelectorOutputは削除。
 * verifier編成selectorは decision.ts のselectLensesに移管＝d1の構造化応答で判定するためparse不要） */

/* stuck発火時のlight/advised自動昇格（designの二本立てトリガーの片方。もう片方はrouter_check）。
 * entry light/advised＋未昇格のときのみescalateEntryRouteし結果を返す。full/昇格済み/direct/oracle/nullはnull */
export function autoEscalateOnStuck(root: string): state.ActiveLoop | null {
  const active = state.getActive(root);
  if (
    !active ||
    (active.state.entry_route !== "light" &&
      active.state.entry_route !== "advised") ||
    active.state.escalated_at
  ) {
    return null;
  }
  return state.escalateEntryRoute(root);
}

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
export function readGraphhopperHash(root: string, filePath: string): string {
  const p = isAbsolute(filePath) ? filePath : join(root, filePath);
  const content = decodeUtf8Strict(readFileSync(p));
  const st = statSync(p);
  return JSON.stringify({
    path: filePath,
    sha1: sha1Hex(content),
    size: Buffer.byteLength(content, "utf8"),
    mtime: st.mtime.toISOString(),
  });
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
    return "error: no active goal (use plain edit as fallback, no event recorded)";
  }
  if (access === "subagent") {
    throw new Error(
      "Refused: graphhopper_edit from subagent session is blocked (read-only invariant)",
    );
  }
  if (!active) return "error: no active goal (unexpected)";
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

/* 拒否文の単一源泉（plugin hook の throw 文と MCP の error 返却で共有）。
 * 文面を変えると両方の応答に反映される。 */
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

/* eval_cmd運用中のattempt二重計数への注意文（prose→codeの一歩目。
 * 拒否ではなく注意に留める: attempt(ok:true)のリセットには意味があるため） */
export const EVAL_MANAGED_NOTE =
  "（note: eval_cmd設定中のためfail系はeval側でも計数される。evalかattemptのどちらかに寄せ、二重計上に注意せよ）";

/* 単一driver警告（TUI bind中のgoalへの別session操作）。
 * 拒否ではなく警告に留める: handoff等の正規フローがあるため */
export function foreignBoundNote(boundId: string): string {
  return (
    `（note: goal は別session（${boundId}）にbind中。二重駆動に注意。` +
    `意図的な引き継ぎなら session_id を指定して resume で bind し直せ）`
  );
}

/* design doc構造検証（exit gate用）。骨格の有無だけ見て質は見ない。
 * 質の厳格化は「薄く書いて回避する」自己判断エロージョンを再生産するため。
 * 既存docの見出し実態に合わせた寛容マッチ。欠落キー一覧を返す（空=通過） */
const REQUIRED_SECTIONS: { key: string; match: RegExp }[] = [
  { key: "goal理解", match: /goal理解|^##\s*goal\b/i },
  { key: "現状", match: /現状|背景/ },
  { key: "設計判断", match: /設計判断|決定事項/ },
  { key: "タスク列", match: /タスク/ },
  { key: "スコープ外", match: /触らない|スコープ外|非対象|棄却/ },
];

const TASK_LINE = /^\s*-\s*(\[[ x]\])?\s*\S/m;

export interface DesignTask {
  text: string;
  done: boolean;
}

export interface DesignProgress {
  total: number;
  done: number;
  items: DesignTask[];
}

/* design.md のタスク列抽出（progress素材）。チェックボックス行のみ。
 * 素朴な行パースであり、ネスト・改行またぎは対象外。読取専用。
 * 行の解釈は src/todos.ts の parseTaskLines に集約（進捗ストアと同じ解釈を使う） */
export function extractTasks(root: string, goalId: string): DesignProgress {
  let raw: string;
  try {
    raw = decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return { total: 0, done: 0, items: [] };
  }
  const items = parseTaskLines(raw).map((t) => ({ text: t.text, done: t.done }));
  return { total: items.length, done: items.filter((i) => i.done).length, items };
}

/** 骨格検査の本体（生テキストを受ける）。checkPhaseMove が1回だけ読んだ raw を共用するため分離 */
function checkDesignDocFromRaw(raw: string): string[] {
  const headers = raw
    .split("\n")
    .filter((l) => l.startsWith("##"))
    .join("\n");
  const missing = REQUIRED_SECTIONS.filter((s) => !s.match.test(headers)).map(
    (s) => s.key,
  );
  if (!TASK_LINE.test(raw)) missing.push("タスク行（- ...）");
  return missing;
}

/** 骨格検査（ファイルから読む薄いラッパ）。読めなければ「無い」を返す */
export function checkDesignDoc(root: string, goalId: string): string[] {
  const raw = readDesignRaw(root, goalId);
  return raw === null ? ["design doc自体が無い"] : checkDesignDocFromRaw(raw);
}

/* ───────── design doc 規約（内容）─────────
 * 骨格（checkDesignDoc）とは別レイヤー。構造で判定できる規約だけを見る:
 * 判断の4点セット（理由/代替案/反証条件）、§5 触らないものの非空、
 * §2 の file:line 証拠2箇所、§4 タスクの判断番号紐付けと判断網羅。
 * 意味の判定（仕様書化していないか等）は critic の領分であり、ここでは見ない。 */

/** 規約の単一源泉（テストもここを参照する） */
export const DESIGN_RULES = {
  /** 判断の4点セット（「決定」は項目自体なので語では見ない） */
  reason: /理由|なぜ|棄却理由/,
  alternative: /代替案|代替|他案/,
  falsify: /反証条件|反証|崩れる条件|失敗条件/,
  /** 免除マーカー: タスクを持たない判断（「今回入れない」等）に付ける */
  exempt: /[（(]タスク不要[）)]/,
  /** 免除マーカーの案内文（エラーメッセージ用） */
  exemptLabel: "（タスク不要）",
  /** §2 の証拠アンカー（file:line） */
  evidence: /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|toml|ya?ml|sh):\d+/g,
  evidenceMin: 2,
  /** 実質内容の最小文字数（プレースホルダ判定の閾値。3文字でラベルだけ/括弧だけを弾く） */
  minContent: 3,
  /** §5「触らないもの」の最小文字数（設計判断4: 8文字以上の実質行を要求） */
  scopeMinContent: 8,
} as const;

const SECTION_HEADING = /^##\s+(.*)$/;
const JUDGMENT_LINE = /^(\d+)\.\s+\S/;
/** タスク行。先頭空白を許す（seed 側 src/todos.ts の parseTaskLines と揃える） */
const TASK_ITEM_LINE = /^\s*-\s*\[[ x]\]\s+\S/;
const TASK_REF = /判断\s*(\d+(?:\s*[,、]\s*\d+)*)/;
const PLACEHOLDER = /^[（(].*[）)]$/;
const TABLE_SEP = /^\|?[\s:|-]+$/;
const TABLE_HEAD = /^\|\s*(対象|項目|内容|スコープ)/;

/** 節の本文（見出しの次の行から、次の `##` まで）。無ければ null */
function sectionBody(raw: string, match: RegExp): string[] | null {
  // CRLF の doc でも見出しが一致するよう \r を落として分割する
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex((l) => {
    const m = SECTION_HEADING.exec(l);
    return m !== null && match.test(m[1]);
  });
  if (i === -1) return null;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (SECTION_HEADING.test(l)) break;
    out.push(l);
  }
  return out;
}

/** 行から記号・ラベル・括弧内プレースホルダを除いた実質文字列。
 * ラベルは「行頭〜最初のコロン」を丸ごと落とす（代替案/理由/反証条件などの語自体を
 * 内容と誤認しないため。ラベルだけの行は 0 文字になる） */
function substantive(line: string): string {
  let s = line.trim();
  s = s.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
  s = s.replace(/^[*_`#\s]+/, "");
  s = s.replace(/^[^:：]{1,16}[:：]\s*/, "");
  s = s.replace(/[*_`]/g, "");
  s = s.replace(/[（(][^）)]*[）)]/g, "");
  return s.replace(/\s/g, "");
}

/** 語が「実質行」として現れるか（プレースホルダだけの行は数えない） */
function hasSubstantive(lines: string[], label: RegExp): boolean {
  return lines.some(
    (l) => label.test(l) && substantive(l).length >= DESIGN_RULES.minContent,
  );
}

/** §5 触らないものが実質空か（プレースホルダ・表ヘッダ・区切りだけ） */
function isEmptyScope(lines: string[]): boolean {
  return !lines.some((l) => {
    const t = l.trim();
    if (!t) return false;
    if (TABLE_SEP.test(t) || TABLE_HEAD.test(t)) return false;
    // ここでラベル（行頭〜最初のコロン）を落とさない: §5 は「型定義: 変更なし」のように
    // ラベル自体が情報であり、落とすと正当な行が 8 文字未満になって誤って空判定になる
    const body = t.replace(/^[-*]\s+/, "");
    if (PLACEHOLDER.test(body)) return false;
    return body.replace(/\s/g, "").length >= DESIGN_RULES.scopeMinContent;
  });
}

/** 判断ブロック（番号付き項目の行から、次の項目の手前まで） */
function judgmentBlocks(lines: string[]): { num: number; lines: string[] }[] {
  const out: { num: number; lines: string[] }[] = [];
  lines.forEach((l, i) => {
    const m = JUDGMENT_LINE.exec(l);
    if (!m) return;
    const block = [l];
    for (const n of lines.slice(i + 1)) {
      if (JUDGMENT_LINE.test(n)) break;
      block.push(n);
    }
    out.push({ num: Number(m[1]), lines: block });
  });
  return out;
}

/** design doc の生テキスト（読めなければ null） */
function readDesignRaw(root: string, goalId: string): string | null {
  try {
    return decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return null;
  }
}

/** design doc の規約検査。空配列なら適合。違反は「何をどこに足すか」を返す */
export function checkDesignContent(raw: string): string[] {
  const problems: string[] = [];

  // §3: 判断の4点セット（決定＝項目自体、理由・代替案・反証条件を語で見る）
  const judges = judgmentBlocks(sectionBody(raw, /設計判断|決定事項/) ?? []);
  if (judges.length === 0) {
    problems.push("§3 設計判断に番号付きの判断が無い（1. **決定**: … の形で書く）");
  }
  for (const j of judges) {
    if (!hasSubstantive(j.lines, DESIGN_RULES.reason)) {
      problems.push(`設計判断${j.num} に「理由」が無い（§3 に「理由: …」を足す）`);
    }
    if (!hasSubstantive(j.lines, DESIGN_RULES.alternative)) {
      problems.push(`設計判断${j.num} に「代替案」が無い（§3 に「代替案: …」を足す）`);
    }
    if (!hasSubstantive(j.lines, DESIGN_RULES.falsify)) {
      problems.push(`設計判断${j.num} に「反証条件」が無い（§3 に「反証条件: …」を足す）`);
    }
  }

  // §2: file:line の証拠（出現回数で数える）
  const current = sectionBody(raw, /現状|背景/);
  // プレースホルダ（例示）行は証拠に数えない。テンプレの `src/foo.ts:123` が
  // そのまま 1 件として数えられると、実質 1 箇所でも通ってしまう
  const evidenceLines = (current ?? []).filter(
    (l) => !PLACEHOLDER.test(l.trim().replace(/^[-*]\s+/, "")),
  );
  const evidenceCount = (evidenceLines.join("\n").match(DESIGN_RULES.evidence) ?? []).length;
  if (evidenceCount < DESIGN_RULES.evidenceMin) {
    problems.push(
      `§2 現状に file:line の証拠が${DESIGN_RULES.evidenceMin}箇所未満（現在${evidenceCount}）。` +
        "`src/foo.ts:123` の形で根拠を付ける",
    );
  }

  // §4: タスク行の判断番号紐付け（走査は §4 内のみ。§3 の箇条書きをタスクと誤認しない）
  const tasks = sectionBody(raw, /タスク/) ?? [];
  const refs = new Set<number>();
  for (const l of tasks) {
    if (!TASK_ITEM_LINE.test(l)) continue;
    const m = TASK_REF.exec(l);
    if (!m) {
      problems.push(
        `タスク行に判断番号が無い（§4 の「${l.trim().slice(0, 20)}…」に「（判断N）」を足す）`,
      );
      continue;
    }
    for (const n of m[1].split(/[,、]/)) refs.add(Number(n.trim()));
  }

  // §4: 判断の網羅（免除マーカー付きの判断は除く）
  for (const j of judges) {
    if (j.lines.some((l) => DESIGN_RULES.exempt.test(l))) continue;
    if (!refs.has(j.num)) {
      problems.push(
        `設計判断${j.num} に対応するタスクが無い（§4 に「（判断${j.num}）」を付けたタスクを足すか、判断に「${DESIGN_RULES.exemptLabel}」を付ける）`,
      );
    }
  }

  // §5: 触らないものの非空
  const scope = sectionBody(raw, /触らない|スコープ外|非対象|棄却/);
  if (scope === null || isEmptyScope(scope)) {
    problems.push("§5 触らないもの（スコープ外）が空（この goal で変えないものを具体的に書く）");
  }

  return problems;
}

/* phase遷移前の機械チェック（plugin/MCP両callerで共有）。
 * 通れば null、ダメならそのまま返す error 文。 */
export function checkPhaseMove(
  root: string,
  to: state.Phase,
): string | null {
  const active = state.getActive(root);
  if (!active) return "error: no active goal";
  if (!state.isLegalPhaseTransition(active.state.phase, to)) {
    return (
      `error: 非法遷移 ${active.state.phase} -> ${to}。` +
      `合法遷移: ${state.LEGAL_TRANSITIONS[active.state.phase].join(", ")}。` +
      `doneへは graphhopper_goal(complete) のみ（verifier cleanガード付き）。`
    );
  }
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    state.readConfig(root).require_critic &&
    !active.state.critic_review
  ) {
    return (
      "error: require_critic=true のため designing→implementing には critic_review 記録が必要。" +
      "graphhopper_critic_set で記録してから遷移せよ（opt-in運用なら config で require_critic=false）。"
    );
  }
  // light/advisedのdesigning巻き戻しはescalate経路に限定（escalated_at無しの素の巻き戻しだと
  // ratchet（critic1回＋fan-out×3前提）が成立しない。full/oracleの巻き戻しは許可）
  if (
    to === "designing" &&
    (active.state.phase === "implementing" || active.state.phase === "polish") &&
    (active.state.entry_route === "light" ||
      active.state.entry_route === "advised") &&
    !active.state.escalated_at
  ) {
    return (
      "error: entry_route=light/advised の designing巻き戻しは graphhopper_escalate を使え" +
      "（素の phase 遷移では escalated_at が立たず昇格条件が成立しない）。"
    );
  }
  // 昇格後はcritic1回が必須（escalateの実効条件。proseだけだと素通りするため機械化。
  // legacy（escalated_at null）・fullには影響なし）
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    active.state.escalated_at &&
    !active.state.critic_review
  ) {
    return (
      "error: light/advised→full昇格後は designing→implementing に critic_review 記録が必要。" +
      "task(graphhopper-critic)／graphhopper_invoke(agent: 'graphhopper-critic')で肉付けdesignを1回レビューし、graphhopper_critic_set で記録してから遷移せよ。"
    );
  }
  // entry相談ゲート（D/E実効化。proseだけだと素通りするため機械化。
  // 昇格済みはfull扱い＝critic gateのみ。legacy（entry_route null）・full/lightには影響なし）
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    !active.state.escalated_at &&
    active.state.entry_route === "advised" &&
    !active.state.advisor_consult
  ) {
    return (
      "error: entry_route=advised の designing→implementing には advisor相談の記録が必要。" +
      "task(graphhopper-advisor)／graphhopper_invoke(agent: 'graphhopper-advisor')で相談1回し、graphhopper_consult_set(kind: 'advisor')で記録してから遷移せよ。"
    );
  }
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    !active.state.escalated_at &&
    active.state.entry_route === "oracle" &&
    !active.state.oracle_consult
  ) {
    return (
      "error: entry_route=oracle の designing→implementing には oracle相談の記録が必要。" +
      "task(graphhopper-oracle)／graphhopper_invoke(agent: 'graphhopper-oracle')で相談1回し、graphhopper_consult_set(kind: 'oracle')で記録してから遷移せよ。"
    );
  }
  // scaffoldが自動生成するため、骨格不足で失敗するのは骨格を削った場合のみ。
  // route による内容規約の特別扱いはしない（light/advised も同じ規約。規模差は判断の数で吸収する）
  if (to === "implementing" && active.state.phase === "designing") {
    // design.md は1回だけ読む（骨格と内容で同じ raw を使う。途中で変わると判定が割れる）
    const designRaw = readDesignRaw(root, active.goal.id);
    const missing =
      designRaw === null ? ["design doc自体が無い"] : checkDesignDocFromRaw(designRaw);
    if (missing.length > 0) {
      return (
        `error: design.md の骨格不足（${missing.join("・")}）。` +
        `scaffold（.graphhopper/plans/${active.goal.id}.md）を埋めてから遷移せよ。` +
        `質の指摘はcriticの領分であり、このゲートは骨格の有無だけを見る。`
      );
    }
    // 内容規約（全 route）。構造で判定できる規約だけを見る。
    const violations = checkDesignContent(designRaw ?? "");
    if (violations.length > 0) {
      return (
        `error: design.md が規約に違反（${violations.length}件）。\n- ` +
        violations.join("\n- ") +
        "\n修正してから implementing へ遷移せよ（意味の指摘は critic の領分で、このゲートは構造規約だけを見る）。"
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
    // ストアが空なら移行救済として design.md から seed する（design 判断2）
    const store =
      loaded.store.items.length === 0
        ? state.ensureTodos(root, active.goal.id, { warn: true })
        : loaded.store;
    // design.md が「あるが読めない」場合は進捗が不明なので fail-closed
    if (store.items.length === 0 && state.planReadState(root, active.goal.id) === "unreadable") {
      return (
        "error: design.md を読み込めません（不正なエンコーディングの可能性）。" +
        "進捗を機械的に強制できないため polish への遷移を拒否します（fail-closed）"
      );
    }
    const err = todoGateError(store);
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
      "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
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
    `- 次のアクション: ${effectivePhaseAction(s.phase, s.entry_route)}`,
    s.notes ? `- notes: ${s.notes}` : null,
    s.eval_cmd ? `- eval_cmd: ${s.eval_cmd}` : null,
    progress ? `- ${progress}` : null,
    open.length ? `- 未完了タスク:\n${open.join("\n")}` : null,
    s.fail_streak > 0 ? `- fail_streak: ${s.fail_streak}` : null,
    s.last_verifier ? `- last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})` : null,
    `- design doc: .graphhopper/plans/${goal.id}.md（designing終了後は不変）`,
    s.intent_path
      ? `- intent log: ${s.intent_path}（goal開始時の会話。critic/requirement/general lens 用）`
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
