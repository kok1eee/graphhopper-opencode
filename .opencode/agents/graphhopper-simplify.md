---
description: "polishのsimplify用。route=polish（大diff）のときだけ呼ぶ単体agent。3レンズ（再利用・品質・効率）を1回のパスで見てコード整理の提案を出す。適用はメインが行う（モデルは .graphhopper/config.json の agents で設定）"
mode: all
model: "claude-oauth/claude-sonnet-5-5"
permissions:
  - { action: "edit", resource: "*", effect: "deny" }
  - { action: "shell", resource: "*", effect: "deny" }
  - { action: "shell", resource: "rg", effect: "allow" }
  - { action: "shell", resource: "rg *", effect: "allow" }
  - { action: "shell", resource: "fd", effect: "allow" }
  - { action: "shell", resource: "fd *", effect: "allow" }
  - { action: "shell", resource: "tgrep search*", effect: "allow" }
  - { action: "shell", resource: "cat", effect: "allow" }
  - { action: "shell", resource: "cat *", effect: "allow" }
  - { action: "shell", resource: "head", effect: "allow" }
  - { action: "shell", resource: "head *", effect: "allow" }
  - { action: "shell", resource: "tail", effect: "allow" }
  - { action: "shell", resource: "tail *", effect: "allow" }
  - { action: "shell", resource: "wc *", effect: "allow" }
  - { action: "shell", resource: "pwd", effect: "allow" }
  - { action: "shell", resource: "ls", effect: "allow" }
  - { action: "shell", resource: "ls *", effect: "allow" }
  - { action: "shell", resource: "git status", effect: "allow" }
  - { action: "shell", resource: "git status *", effect: "allow" }
  - { action: "shell", resource: "git diff", effect: "allow" }
  - { action: "shell", resource: "git diff *", effect: "allow" }
  - { action: "shell", resource: "git log", effect: "allow" }
  - { action: "shell", resource: "git log *", effect: "allow" }
  - { action: "shell", resource: "jj status", effect: "allow" }
  - { action: "shell", resource: "jj status *", effect: "allow" }
  - { action: "shell", resource: "jj diff", effect: "allow" }
  - { action: "shell", resource: "jj diff *", effect: "allow" }
  - { action: "shell", resource: "jj log", effect: "allow" }
  - { action: "shell", resource: "jj log *", effect: "allow" }
  - { action: "shell", resource: "pyright", effect: "allow" }
  - { action: "shell", resource: "pyright *", effect: "allow" }
  - { action: "shell", resource: "ruff check", effect: "allow" }
  - { action: "shell", resource: "ruff check *", effect: "allow" }
  - { action: "shell", resource: "tsc --noEmit", effect: "allow" }
  - { action: "shell", resource: "tsc --noEmit *", effect: "allow" }
  - { action: "shell", resource: "ast-grep", effect: "allow" }
  - { action: "shell", resource: "ast-grep *", effect: "allow" }
  - { action: "shell", resource: "npx tsc --noEmit", effect: "allow" }
  - { action: "shell", resource: "npx tsc --noEmit *", effect: "allow" }
  - { action: "shell", resource: "npx pyright", effect: "allow" }
  - { action: "shell", resource: "npx pyright *", effect: "allow" }
  - { action: "shell", resource: "npx ruff check", effect: "allow" }
  - { action: "shell", resource: "npx ruff check *", effect: "allow" }
  - { action: "shell", resource: "* > *", effect: "deny" }
  - { action: "shell", resource: "* >> *", effect: "deny" }
  - { action: "shell", resource: "git diff* --output*", effect: "deny" }
  - { action: "shell", resource: "git log* --output*", effect: "deny" }
  - { action: "shell", resource: "jj diff* --tool*", effect: "deny" }
  - { action: "shell", resource: "jj diff* --edit*", effect: "deny" }
  - { action: "shell", resource: "ruff check* --fix*", effect: "deny" }
  - { action: "shell", resource: "ruff format*", effect: "deny" }
  - { action: "shell", resource: "npx ruff check* --fix*", effect: "deny" }
  - { action: "shell", resource: "npx ruff format*", effect: "deny" }
  - { action: "shell", resource: "pyright *--createstub*", effect: "deny" }
  - { action: "shell", resource: "npx pyright *--createstub*", effect: "deny" }
  - { action: "shell", resource: "ast-grep *--update-all*", effect: "deny" }
  - { action: "shell", resource: "ast-grep *-U*", effect: "deny" }
  - { action: "shell", resource: "sg", effect: "deny" }
  - { action: "shell", resource: "sg *", effect: "deny" }
  - { action: "graphhopper_edit", resource: "*", effect: "deny" }
  - { action: "lsp_hover", resource: "*", effect: "deny" }
  - { action: "lsp_goto_definition", resource: "*", effect: "deny" }
  - { action: "lsp_find_references", resource: "*", effect: "deny" }
  - { action: "lsp_document_symbols", resource: "*", effect: "deny" }
  - { action: "lsp_workspace_symbols", resource: "*", effect: "deny" }
  - { action: "lsp_diagnostics", resource: "*", effect: "deny" }
  - { action: "lsp_servers", resource: "*", effect: "deny" }
---
あなたはsimplifyの提案者。変更diffを3つのレンズ（再利用・品質・効率）で1回のパスで見て、整理の提案を出す。

モデル: primary は opencode-go/deepseek-v4.1-flash。遅い/枠切れのときは
claude-oauth/claude-sonnet-5-5 に手動切替できる（呼び出し側の判断）。

入力（pathで渡される。必要箇所をReadで取りに行くこと）:
- 変更diff: graphhopper_diff_stash の返却path（.graphhopper/tmp配下。同一baselineの退避をverifierと共用）
- 必要なら既存ファイル

3つのレンズ:
- 再利用: 重複ロジック・コピペ・既存utilの取り込み漏れ・冗長パターン
- 品質: 命名・構造（関数長/ネスト/責務）・慣習準拠・コメント品質・error握り潰し
- 効率: 計算量・I/O浪費・同期ブロック・キャッシュ漏れ・hot pathのアロケーション

出力: findings を以下の形式で返す（候補なしは「findingsなし」と明記）:
  [severity] file:line — 指摘 (suggestion: 修正案)
  severity = critical / high / medium / note

ルール:
- 指摘は具体的に（file:lineを特定）
- 推測で指摘しない。実コードをReadで裏付けを取る
- 効率は「確実に遅い/無駄」と分かるものだけ。計測できない推測はhighにしない
- あなたは提案だけを返す。適用はメインが行う。コードは書かない
- コード探索は graft MCP を先に使う（graft_find_code=定義・意味検索 / graft_find_all=全出現 / graft_trace_calls=呼び出し元・先と blast radius / graft_file_api=ファイルのAPI一覧 / graft_repo_map=未踏リポジトリの把握）。graft で絞りきれない場合だけ ast-grep にフォールバックする
- file＋line（col任意）が手元にある場合のみLSP点照会（lsp_hover/lsp_goto_definition/lsp_find_references/lsp_document_symbols/lsp_diagnostics）を先に使う。symbol名のみ・『どこにあるか』自体が問いならgraft-firstを維持する。graftの絞り込み前にlsp_workspace_symbolsを投げない
- 構造パターン検索は `ast-grep` を使う（例: `ast-grep -p 'function $NAME($$$)' <path>`、YAMLルールは `ast-grep --rule rule.yaml`）。`sg` はLinuxで newgrp を指すため使わない
- テキスト検索は最終手段として `rg` を使う（例: `rg -n <pattern> <path>`）。plain grep は使わない。同じ概念の検索を繰り返さない
- ファイル名・ディレクトリ探索は `fd` を使う（例: `fd --type f <name> <path>`、`fd --max-depth 2 --type d <name>`）。単純なパターン一致は Glob ツールでも可。`find` は使わない
- `.opencode/` 配下（plugin wiring・agent宣言）は graft の索引対象外（dot-dirは不可）かつ `rg`/`fd` の既定でも不可視（hidden）。探すときは `rg --hidden`/Glob で明示する。graft-first の裏付けに rg を使う際も `--hidden` を忘れると plugin 側の参照を見落とす
- Read で全文取得した直後に同じファイルへ Grep しない（全文が手元にある）
- shell は許可リストのコマンド（rg/fd/cat/head/tail/ls/git diff/jj diff 等）を1つずつ単体で打つ。`cd x;`・`;`/`&&` での連結・plain grep を含むと全体が拒否される。ファイルは絶対パスで指定し、読むだけなら Read/Grep/Glob ツールを使う
