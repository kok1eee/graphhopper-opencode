/**
 * graphhopper の専用 subagent 定義（plugin の agent.transform と scripts/gen-agents.ts の bake で適用）
 *
 * graphhopper本体（Claude Code版）のtiering をそのまま踏襲する:
 *   researcher = 最下層コスト・高速（高頻度・事実収集専用・判断を含まない）
 *   verifier(polish) / oracle(stuck escalation) = 上位品質（判断node、常に最高品質を保証）
 *
 * oracleはpolishのdiffサイズ分岐（router gate）とは別軸のタイミング判断:
 * 「詰まった回数」（graphhopper_attemptのfail_streak）がstuck_thresholdに達したら
 * 呼ぶ、というgraph engineeringの分岐点。無条件で毎回上位モデルを呼ぶのではなく、
 * 本当に必要な時（手詰まり）にだけ上位モデルのコストを払う。
 *
 * モデルの実効値は割当表（global / project の `.graphhopper/config.json` の `agents`）が決め、
 * 下の `model` は割当が無いときの既定。既定は advisor=opus 5.5 / oracle=fable 5.2
 * （どちらも `claude-oauth` provider）。tier 思想（researcher=最下層 /
 * verifier・oracle=上位品質）はそのまま、具体モデルは割当表で差し替える。
 * 系列多様性の議論（flywheelの2-vendor構成）はgraphhopperの**判断node**には不要——
 * 判断は「メイン + verifier」の2層で足りるというgraphhopper自体の設計原則
 * （council再発防止）に合わせ、判断系でvendorを増やさない。
 * ただし設計段階の質チェックnode `graphhopper-critic` は実装前の計画検証で、
 * メインとは別ベンダー（例: Luna）を使うことで系列多様性を設計段階で得る
 * （verifier=実装後のdrift検出 / critic=実装前の計画検証 の役割分担）。
 *
 * 全て読み取り専用（edit deny + bash は `rg` / `fd` のみ許可）。実装はメインループ側だけが行う。
 * ユーザーが opencode.json(c) に同名 agent を定義している場合はそちらを優先する。
 * プロジェクト単位のモデル上書きは .graphhopper/config.json の agents で指定する。
 */
import { checkModelAllowed, toViolation, type ModelViolation } from "./model-policy";
import { VERIFIER_EFFICIENCY_RULE } from "./prompts";
import { readConfig } from "./state";

export interface PermissionRule { action: string; resource: string; effect: "allow" | "ask" | "deny"; }
export interface V2ModelRef { providerID: string; model: string; /** reasoning effort など（割当表の "provider/model#variant"） */ variant?: string; }
/** v2 static agent definition. Registered via agents/*.md defaults + ctx.agent.transform update() at runtime. */
export interface V2AgentDef {
  description: string;
  mode: "all";
  /** default model; the assignment table (.graphhopper/config.json agents) overrides it via collectAgentUpdates */
  model: V2ModelRef;
  system: string;
  /** v2 has no agent temperature field; carried as request.body (preserved, not yet sent by the runner) */
  temperature?: number;
  bash: Record<string, "allow" | "deny" | "ask">;
}

/**
 * 全subagent共通の探索ルール（graft-first）。
 * 背景: researcher/critic/verifier が Grep ツール連打・graft MCP 未使用で
 * トークンを浪費する事例が多発したため、prompt レベルで強制する。
 * tier: graft（意味・構造の入口）→ ast-grep（構造パターン）→ rg（テキスト最終手段）。
 *   tgrep は表現力が rg と同じで利点が「巨大repoでの速度」だけであり、index/serve を
 *   deny している（BYOS）以上・通常repoでは rg と等価で判定ノイズになるため tier から外した。
 *   逃走経路として SKILL.md の Gotchas にのみ記載し、allowlist には `tgrep search*` を残す
 *   （design g-mu4wradt D4 の事後改訂）。
 * - テキスト検索は plain grep ではなく必ず `rg`（bash経由）。
 * - 同じ概念の検索を繰り返さない。Read 全文取得の直後に同じファイルへ Grep しない。
 */
const SEARCH_RULES: readonly string[] = [
  "- コード探索は graft MCP を先に使う（graft_find_code({query})=定義・意味検索 / graft_find_all({pattern})=全出現 / graft_trace_calls({symbol, direction: \"in\"|\"out\"})=呼び出し元(in)・先(out)と blast radius / graft_file_api({file})=ファイルのAPI一覧 / graft_repo_map=未踏リポジトリの把握。引数名は推測しない）。graft で絞りきれない場合だけ ast-grep にフォールバックする",
  "- file＋line（col任意）が手元にある場合のみLSP点照会（lsp_hover/lsp_goto_definition/lsp_find_references/lsp_document_symbols/lsp_diagnostics）を先に使う。symbol名のみ・『どこにあるか』自体が問いならgraft-firstを維持する。graftの絞り込み前にlsp_workspace_symbolsを投げない",
  "- 構造パターン検索は `ast-grep` を使う（例: `ast-grep -p 'function $NAME($$$)' <path>`、YAMLルールは `ast-grep --rule rule.yaml`）。`sg` はLinuxで newgrp を指すため使わない",
  "- テキスト検索は最終手段として `rg` を使う（例: `rg -n <pattern> <path>`）。plain grep は使わない。同じ概念の検索を繰り返さない",
  "- ファイル名・ディレクトリ探索は `fd` を使う（例: `fd --type f <name> <path>`、`fd --max-depth 2 --type d <name>`）。単純なパターン一致は Glob ツールでも可。`find` は使わない",
  "- `.opencode/` 配下（plugin wiring・agent宣言）は graft の索引対象外（dot-dirは不可）かつ `rg`/`fd` の既定でも不可視（hidden）。探すときは `rg --hidden`/Glob で明示する。graft-first の裏付けに rg を使う際も `--hidden` を忘れると plugin 側の参照を見落とす",
  "- Read で全文取得した直後に同じファイルへ Grep しない（全文が手元にある）",
  "- shell は許可リストのコマンド（rg/fd/cat/head/tail/ls/git diff/jj diff 等）を1つずつ単体で打つ。`cd x;`・`;`/`&&` での連結・plain grep を含むと全体が拒否される。ファイルは絶対パスで指定し、読むだけなら Read/Grep/Glob ツールを使う",
];

/**
 * 読み取り専用を保ったまま検索・確認系コマンドだけ許可する bash 権限（design g-mtwlqzbb）。
 * 全subagentは edit deny + bash はこの許可リストのみ（plain grep・find 等の他コマンドは deny）。
 *
 * 重要: opencodeのbash permissionはfindLast（最後にマッチしたルールが勝つ）で評価される。
 * このオブジェクトの記述順がそのまま評価優先度になるため、以下の構造を厳守すること:
 *   1. base deny（"*": "deny"）— 先頭
 *   2. 個別allow群 — 中盤
 *   3. リダイレクト・引数注入対策のdeny群 — 必ずallow群より後方（末尾）
 * 将来コマンドを追記する際、allow行を末尾に追加すると3のdeny群より後に来てしまい、
 * リダイレクト対策が静かに無効化される。追記は必ず2の位置（deny群より前）に行うこと。
 */
export const SEARCH_ONLY_BASH: Record<string, "allow" | "deny" | "ask"> = {
  "*": "deny",
  // 1. 個別allow群（検索・確認系のみ。書き込み・外部実行系オプションを持つコマンドは
  // 引数注入対策(下記3)と対で追加する）
  rg: "allow",
  "rg *": "allow",
  fd: "allow",
  "fd *": "allow",
  "tgrep search*": "allow", // 逃走経路（巨大repoのみ・SKILL.md Gotchas参照）。index/serveは状態変更のためdeny
  cat: "allow",
  "cat *": "allow",
  head: "allow",
  "head *": "allow",
  tail: "allow",
  "tail *": "allow",
  "wc *": "allow",
  pwd: "allow",
  ls: "allow",
  "ls *": "allow",
  "git status": "allow",
  "git status *": "allow",
  "git diff": "allow",
  "git diff *": "allow",
  "git log": "allow",
  "git log *": "allow",
  "jj status": "allow",
  "jj status *": "allow",
  "jj diff": "allow",
  "jj diff *": "allow",
  "jj log": "allow",
  "jj log *": "allow",
  pyright: "allow",
  "pyright *": "allow",
  "ruff check": "allow",
  "ruff check *": "allow",
  "tsc --noEmit": "allow",
  "tsc --noEmit *": "allow",
  // 構造検索は canonical 名の `ast-grep` のみ許可する。`sg` は macOS では ast-grep の
  // deprecated shim だが、Linux（Amazon Linux 等）では newgrp への symlink であり
  // 「別グループでの任意コマンド実行」になる。機械依存の穴を作らないため sg は deny（下記）。
  "ast-grep": "allow",
  "ast-grep *": "allow",
  "npx tsc --noEmit": "allow",
  "npx tsc --noEmit *": "allow",
  "npx pyright": "allow",
  "npx pyright *": "allow",
  "npx ruff check": "allow",
  "npx ruff check *": "allow",
  // 2. リダイレクト対策（allow群より後方。空白ありの `>`/`>>` のみ対象。
  // 無空白リダイレクト(`2>/dev/null`等)は受容リスクとして残る）
  "* > *": "deny",
  "* >> *": "deny",
  // 3. 引数注入対策。--output/--tool等の危険フラグはコマンド名直後より後ろの
  // 任意位置に来るため、コマンド名の直後に `*` を挟んで前方一致にする
  "git diff* --output*": "deny",
  "git log* --output*": "deny",
  "jj diff* --tool*": "deny",
  "jj diff* --edit*": "deny",
  "ruff check* --fix*": "deny",
  "ruff format*": "deny",
  "npx ruff check* --fix*": "deny",
  "npx ruff format*": "deny",
  "pyright *--createstub*": "deny",
  "npx pyright *--createstub*": "deny",
  "ast-grep *--update-all*": "deny",
  "ast-grep *-U*": "deny",
  // Linux では sg = newgrp（別グループで任意コマンド実行）。allow群より後方で明示deny。
  sg: "deny",
  "sg *": "deny",
};

/* verifier専用bash権限: SEARCH_ONLY_BASH＋診断系deny。
 * 診断はmainが1回実行して添付するためverifierの個別実行は禁止（重複排除）。
 * spread順序維持でdeny群を末尾追加し、findLastでdeny勝ちさせる。
 * opencodeのマッチ方式（exact優先/glob）不定のため、exact keyとwildcardの両方をdenyする */
export const VERIFIER_BASH: Record<string, "allow" | "deny" | "ask"> = {
  ...SEARCH_ONLY_BASH,
  "tsc --noEmit": "deny",
  "tsc --noEmit *": "deny",
  "npx tsc --noEmit": "deny",
  "npx tsc --noEmit *": "deny",
  "npx tsc*": "deny",
  pyright: "deny",
  "pyright *": "deny",
  "npx pyright": "deny",
  "npx pyright *": "deny",
  "npx pyright*": "deny",
  "ruff check": "deny",
  "ruff check *": "deny",
  "npx ruff check": "deny",
  "npx ruff check *": "deny",
  "npx ruff*": "deny",
};

export const GRAPHHOPPER_AGENTS: Record<string, V2AgentDef> = {
  /* modeは "all"（design g-mu5d6avj A1）。
   * `opencode run --agent` はsubagent modeを拒否してdefault agentにフォールバックするため、
   * graphhopper_invoke で --agent 指定できるよう "all" にする。
   * Task経路のsubagent利用・read-only権限は不変。副作用: TUIのTab切替候補に載る。 */
  "graphhopper-researcher": {
    description:
      "コードベース事実収集エージェント（graft-first）。ファイル検索・構造把握・呼び出し関係の特定。高頻度に呼ばれるためコストティア最下層で使う（モデルは .graphhopper/config.json の agents で設定）。外部公式ドキュメント調査は graphhopper-librarian に委ねる",
    mode: "all",
    model: { providerID: "minimax", model: "MiniMax-M3.1-Flash" },
    temperature: 0.1,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたは調査専門家。与えられた問いに対し、コードベースを探索して根拠（ファイル:行）付きの回答を返す。",
      "",
      "ルール:",
      "- 推測で答えない。必ず graft MCP / ast-grep / rg / glob / read で裏付けを取る",
      "- 外部公式ドキュメント・仕様調査が必要なら、その旨を明記して graphhopper-librarian への委譲を提案する（自分でwebfetchしない。コードベース事実収集に専念する）",
      ...SEARCH_RULES,
      "- 回答は「結論 → 根拠 → 不明点」の形式",
      "- 見つからなかった場合は見つからなかったと言う",
      "- コードは書かない。調査と報告だけ",
    ].join("\n"),
  },

  "graphhopper-librarian": {
    description:
      "外部公式ドキュメント・仕様調査専用の安価エージェント。公式doc・仕様・横断的意味質問の事実収集。判断は含まない（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    model: { providerID: "minimax", model: "MiniMax-M3.1-Flash" },
    temperature: 0.1,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたはlibrarian。外部公式ドキュメント・仕様を調査して根拠（URL・引用）付きの事実を返す。",
      "判断は含まない。判断が必要なら「判断が必要」と明記して呼び出し側に返す。",
      "",
      "ルール:",
      "- 推測で答えない。公式doc・一次情報を優先し、URLと引用を付ける",
      "- ライブラリ・フレームワークの最新仕様は context7 MCP（resolve-library-id → get-library-docs）を公式docと併せて使う。context7 に無いもの（issue・blog・changelog・コード例）は websearch MCP（Exa・一般web）と grep.app MCP（コード例検索）にフォールバックする",
      "- コードベースの探索は graft-first で行い、必要なら ast-grep / rg を使う",
      ...SEARCH_RULES,
      "- 回答は「結論 → 根拠 → 不明点」の形式",
      "- 見つからなかった場合は見つからなかったと言う",
      "- コードは書かない。調査と報告だけ",
    ].join("\n"),
  },

  "graphhopper-advisor": {
    description:
      "気軽な相談専用。セカンドオピニオン・advised入口の相談・full の designing で判断の第二意見を取りたいときに使う（モデルは .graphhopper/config.json の agents で設定）。入口トリアージ（graphhopper_decide）はd1 toolに移管済み（agent不要）。stuck時はgraphhopper-oracle（advisorで代替しない）。最終決定は呼び出し側",
    mode: "all",
    model: { providerID: "claude-oauth", model: "claude-opus-5-5" },
    temperature: 0.2,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたはadvisor。相談・判定の助言者。",
      "",
      "役割:",
      "- 問いに対し選択肢・トレードオフ・推奨1つを返す",
      "- typed choice形式の問いには1行JSONのみで返す（説明・理由文は出さない）",
      "- 最終決定は呼び出し側。あなたは拘束しない",
      "",
      "ルール:",
      "- 推測で答えない。必要ならReadで裏付けを取る",
      "- stuck案件（fail_streak到達）はあなたの領分外。graphhopper-oracleに回す旨を返せ",
      "- コードは書かない。助言だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-critic": {
    description:
      "designingフェーズのdesign.mdを敵対レビューする。要件漏れ・設計の穴・スコープ逸脱を検出する安価な常設チェックnode（モデルは .graphhopper/config.json の agents で設定。haiku級で安価・高速に回し、見逃し率はscoreboardで監視）。verifierとは対照的に実装前の計画のみを対象とする",
    mode: "all",
    model: { providerID: "claude-oauth", model: "claude-haiku-5-5" },
    /* temperature未指定: criticは既定温度で回す（敵対レビュー用途ではばらつき許容）。
     * verifier等は維持 */
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたはcritic。実装前に、設計ドキュメントの質を敵対的に検証する。",
      "",
      "対象: .graphhopper/plans/<goal-id>.md（designドキュメント）",
      "goal開始時の会話を保存した意図ログ .graphhopper/plans/<goal-id>.intent.md があれば必ず読み、",
      "design の前提がユーザーの意図（me: の発言）からズレていないかを追加で見る。",
      "intent.md は goal 開始時の一次情報であり、design を正とするために読み替えない。",
      "検証する3観点:",
      "- 要件漏れ: goalから要件理解・設計判断・実装タスク列に欠落はないか",
      "- 設計の穴: トレードオフが明示されているか、タスク列で実行可能か",
      "- スコープ逸脱: goalと無関係な作業・過剰設計・ゴールドプレーティングがないか",
      "",
      "機械的に確認できる観点（各項目を yes/no で判定し、no のものだけ finding にする）:",
      "1. 各設計判断に代替案と棄却理由が書かれているか",
      "2. 各設計判断に反証条件（この観測が出たら間違い）が書かれているか",
      "3. 「触らないもの」は具体的か（「必要に応じて」「適宜」などの逃げがないか）",
      "4. §2 現状の主張に file:line の証拠が付き、主張と対応しているか",
      "5. §3 の各判断に対応するタスクが §4 にあるか（漏れ、判断に無いタスク）",
      "6. 判断が実装詳細（定数・関数名の列挙・手順）に踏み込みすぎていないか",
      "",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければ「driftなし」と明記する。",
      "",
      "ルール:",
      "- 指摘は具体的に（該当セクション・該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-usability": {
    description:
      "AIが読んで従うルール文書（AGENTS.md・skills/**.md・src/agents.ts）の usability をレビューする。初見の実行者として、手順の実行可能性・矛盾・曖昧さを検出する（design g-mwfltxyt）。判断nodeなので sonnet を使う。コードは書かない",
    mode: "all",
    model: { providerID: "claude-oauth", model: "claude-sonnet-5-5" },
    temperature: 0.1,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたは usability reviewer。AI が読んで従うルール文書の変更を、初見の実行者として検証する。",
      "",
      "入力: 変更された文書の diff・全文・（あれば）goal の意図ログ。",
      "見る観点:",
      "- 初見で実行できるか（前提知識・暗黙の文脈に依存していないか）",
      "- 矛盾・曖昧な語・未定義の用語・古い記述との衝突",
      "- 手順の順序・条件分岐・例外が実行可能か",
      "- 変更の意図（intent があれば）と文書の内容が一致しているか",
      "",
      "出力の1行目に必ず `level: clean` または `level: drift` を書く（main がそのまま記録できるように）。",
      "drift（実行不能・誤解を招く箇所）は全件報告する（severity/confidence 付き）。",
      "drift が無ければ level: clean と明記する。",
      "",
      "ルール:",
      "- 指摘は該当行を引用して具体的に",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-simplify": {
    description:
      "polishのsimplify用。route=polish（大diff）のときだけ呼ぶ単体agent。3レンズ（再利用・品質・効率）を1回のパスで見てコード整理の提案を出す。適用はメインが行う（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
    temperature: 0.2,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたはsimplifyの提案者。変更diffを3つのレンズ（再利用・品質・効率）で1回のパスで見て、整理の提案を出す。",
      "",
      "モデル: primary は opencode-go/deepseek-v4.1-flash。遅い/枠切れのときは",
      "claude-oauth/claude-sonnet-5-5 に手動切替できる（呼び出し側の判断）。",
      "",
      "入力（pathで渡される。必要箇所をReadで取りに行くこと）:",
      "- 変更diff: graphhopper_diff_stash の返却path（.graphhopper/tmp配下。同一baselineの退避をverifierと共用）",
      "- 必要なら既存ファイル",
      "",
      "3つのレンズ:",
      "- 再利用: 重複ロジック・コピペ・既存utilの取り込み漏れ・冗長パターン",
      "- 品質: 命名・構造（関数長/ネスト/責務）・慣習準拠・コメント品質・error握り潰し",
      "- 効率: 計算量・I/O浪費・同期ブロック・キャッシュ漏れ・hot pathのアロケーション",
      "",
      "出力: findings を以下の形式で返す（候補なしは「findingsなし」と明記）:",
      "  [severity] file:line — 指摘 (suggestion: 修正案)",
      "  severity = critical / high / medium / note",
      "",
      "ルール:",
      "- 指摘は具体的に（file:lineを特定）",
      "- 推測で指摘しない。実コードをReadで裏付けを取る",
      "- 効率は「確実に遅い/無駄」と分かるものだけ。計測できない推測はhighにしない",
      "- あなたは提案だけを返す。適用はメインが行う。コードは書かない",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-verifier": {
    description:
      "verifier用。graphhopper_verify が、変更ごとに選んだ角度（疑うこと・見る範囲つき）を1角度ずつ呼ぶ。角度を選ぶ役としても呼ばれる。判断nodeなので上位品質モデルを使うが、モデルは .graphhopper/config.json の agents と model_allow/model_deny に従う（invoke の明示指定は deny で拒否される）。実装者本人（メインエージェント）とは独立した第三者チェックであることが呼び出しの目的そのもの",
    mode: "all",
    model: { providerID: "claude-oauth", model: "claude-sonnet-5-5" },
    temperature: 0.2,
    bash: VERIFIER_BASH,
    system: [
      "あなたは敵対的レビューアー。実装者ではなく第三者の立場でdiffのdrift（乖離）を検証する。",
      "",
      "呼び出し側が渡す指示（角度・疑うこと・見る範囲、または角度を選ぶ依頼）に従う。担当の角度だけに集中する。",
      "",
      "進捗タスク（source of truth）:",
      "- 進捗の source of truth は .graphhopper/todos/<goalId>.json（design.md は designing 終端で immutable のため進捗の計測源にできない）",
      "- goalId の解決: `.graphhopper/state.json` の `goal_id` を読む。取れなければ `.graphhopper/todos/` 配下のファイル名（通常1つ）を使う",
      "- 進捗を見る指示のときは必ずこのストアを読む。未完了タスクが残っていないか、cancelled の理由が妥当かを見よ",
      "- ストアが 0 件ならタスクなしとして扱い、進捗起因の drift は報告しない",
      "- ストアが壊れて読めない場合は『進捗は確認できなかった』と evidence_state に明記する（0件扱いしない）",
      "",
      VERIFIER_EFFICIENCY_RULE,
      "",
      "drift（乖離）を検出したら全件報告する（confidence/severity付き、閾値カットしない）。",
      "無ければfindings: []とsummaryに「driftなし」と明記する。",
      "",
      "診断証拠:",
      "- 型・lint診断は自分で実行しない（診断系コマンドは shell で許可されていない）。呼び出し側添付の診断ファイル（.graphhopper/tmp/diag-<goalId>.txt）をReadして裏付け・反証に使え",
      "- 添付が無ければ「診断未実行（理由）」を明記し、診断不在をcleanの根拠にしない",
      "- 診断クリーンはdriftなしの根拠にならない（挙動driftは診断に出ない）。診断結果は補助証拠として扱う",
      "",
      "ルール:",
      "- 指摘は具体的に（ファイル:行を特定、該当行を引用）",
      "- 迎合して指摘を捏造しない。問題が無ければはっきりそう言う",
      "- コードは書かない。読み取りと指摘だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },

  "graphhopper-oracle": {
    description:
      "手詰まり時の相談役。graphhopper_attemptのfail_streakがstuck_thresholdに達した時に呼ぶ。アーキテクチャ判断・複雑なデバッグ・不慣れなパターンについて助言する（モデルは .graphhopper/config.json の agents で設定）",
    mode: "all",
    model: { providerID: "claude-oauth", model: "claude-fable-5-2" },
    temperature: 0.2,
    bash: SEARCH_ONLY_BASH,
    system: [
      "あなたはoracle。実装者が手詰まりになった時に相談される賢者。",
      "",
      "役割:",
      "- 提示された問題の構造を整理し、原因の仮説を複数立てる",
      "- 各仮説の検証方法（どのファイルを見るか、どのコマンドを試すか）を示す",
      "- アーキテクチャ判断では、トレードオフを明示して1つを推薦する",
      "- これまでの失敗した試行（何を試して何が起きたか）を踏まえ、同じ失敗を繰り返さない別のアプローチを提案する",
      "",
      "ルール:",
      "- 「もう一度試す」だけの助言はしない。具体的に何を変えるかを示す",
      "- 不明点は不明点として明示する。分からないことを断定しない",
      "- コードは書かない。診断と助言だけ",
      ...SEARCH_RULES,
    ].join("\n"),
  },
};

/**
 * LSP読取7件の公開範囲（design g-mu5atclj D5）。
 * main＋researcher＋verifier＋oracleに公開し、
 * critic/simplify/librarian/advisorには明示denyする（deny-guard方式）。
 */
const LSP_TOOLS = [
  "lsp_hover",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_diagnostics",
  "lsp_servers",
] as const;

const LSP_DENY_AGENTS: ReadonlySet<string> = new Set([
  "graphhopper-critic",
  "graphhopper-simplify",
  "graphhopper-librarian",
  "graphhopper-advisor",
]);

/**
 * "provider/model" 形式の割当文字列を v2 model ref に分解する。
 * variant 付き ("provider/model#variant") も受け付ける。
 */
export function parseModelRef(s: string): V2ModelRef {
  const [providerModel, variant] = s.split("#", 2);
  const slash = (providerModel ?? "").indexOf("/");
  if (slash <= 0) throw new Error(`invalid model ref: ${s}`);
  return {
    providerID: providerModel.slice(0, slash),
    model: providerModel.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/** V2ModelRef → "provider/model"（variant があれば "#variant" を付ける）。
 * 許可判定用に variant を落とすのは model-policy.ts の stripModelVariant */
export function formatModelRef(ref: V2ModelRef): string {
  return `${ref.providerID}/${ref.model}${ref.variant ? `#${ref.variant}` : ""}`;
}

/**
 * agent の v2 permissions 配列を組み立てる (順序維持。v2 も last-match-wins)。
 * - edit 全 deny (v1 の read-only 不変条件)
 * - bash allowlist (SEARCH_ONLY_BASH / VERIFIER_BASH。v1 の findLast 前提の記述順をそのまま保つ)
 * - 状態機械 driving 用 tool の明示 deny: graphhopper_edit は全 agent、
 *   lsp_* 7件は LSP_DENY_AGENTS のみ (deny-guard 方式は v1 と同じ)。
 *   v2 の `<server>_<tool>` action 規約に載せた best-effort deny。
 *   未知 action は無視されるため無害。edit-deny が主防御。
 */
export function buildPermissions(def: V2AgentDef, name: string): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "edit", resource: "*", effect: "deny" }];
  for (const [resource, effect] of Object.entries(def.bash)) {
    rules.push({ action: "shell", resource, effect });
  }
  rules.push({ action: "graphhopper_edit", resource: "*", effect: "deny" });
  if (LSP_DENY_AGENTS.has(name)) {
    for (const t of LSP_TOOLS) rules.push({ action: t, resource: "*", effect: "deny" });
  }
  return rules;
}

export interface AgentUpdate {
  model: V2ModelRef;
  permissions: PermissionRule[];
  temperature?: number;
}

/** config の agents 上書きが model_allow / model_deny で拒否されたときの警告 */
export type AgentAssignmentWarning = ModelViolation;

/**
 * 割当表を解決する。拒否された上書きは built-in 既定へ落とし、警告として返す。
 * 注意: これは実行時 transform 用の best-effort であり、task() の実効ゲートではない
 * （transform は catalog 発見より先に走るため no-op。ゲートは scripts/gen-agents.ts の
 * bake。design g-mw8rlbjr 判断6）。
 */
export function resolveAgentAssignments(root: string): {
  updates: Record<string, AgentUpdate>;
  warnings: AgentAssignmentWarning[];
} {
  const cfg = readConfig(root);
  const updates: Record<string, AgentUpdate> = {};
  const warnings: AgentAssignmentWarning[] = [];
  for (const [name, def] of Object.entries(GRAPHHOPPER_AGENTS)) {
    const override = cfg.agents[name];
    let model = def.model;
    if (override) {
      let ref: V2ModelRef | null = null;
      try {
        ref = parseModelRef(override);
      } catch {
        ref = null;
      }
      if (!ref) {
        // 形式不正を黙って既定へ落とすと設定ミスが見えない（bake は invalid で止める）
        warnings.push({ agent: name, model: override, kind: "invalid" });
      } else {
        // bake と同じく variant を落とした provider/model で判定する（effort で差を作らない）
        const normalized = `${ref.providerID}/${ref.model}`;
        const v = toViolation(
          name,
          normalized,
          checkModelAllowed(normalized, { allow: cfg.model_allow, deny: cfg.model_deny }),
        );
        if (v) warnings.push(v);
        else model = ref;
      }
    }
    updates[name] = {
      model,
      permissions: buildPermissions(def, name),
      ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
    };
  }
  return { updates, warnings };
}

/**
 * v2 plugin の `ctx.agent.transform(editor => editor.update(...))` に渡す更新集合。
 * 8→7 agent は `agents/*.md` で静的宣言済み (v2 の AgentEditor に add は無い) が前提。
 * 割当表 (.graphhopper/config.json の agents。global＋project マージ済み) の model が
 * 静的宣言の既定より優先される (v1 K10/K11 の教訓: 割当は update で必ず適用する)。
 * 後方互換ラッパー（実質テスト用。plugin は resolveAgentAssignments を使う）。
 */
export function collectAgentUpdates(root: string): Record<string, AgentUpdate> {
  return resolveAgentAssignments(root).updates;
}
