# notion-ops-mcp 実装プロンプト

このリポジトリに、以下の要件を満たす本番品質の OSS を実装してください。MVP と称して要件を省略せず、一方で、現在必要のない汎用基盤を先回りして追加しないでください。

## 1. 目的

`notion-ops-mcp` は、Codex、Claude Code などの MCP クライアントからローカル stdio で利用する TypeScript 製 MCP サーバーです。

サーバー自身は MCP クライアントとして公式のホスト版 Notion MCP（既定値: `https://mcp.notion.com/mcp`）へ接続します。公式 Notion MCP の原子的な Tool Call をサーバー内部で複数回組み合わせ、モデルには一つの高水準 Tool と一つのコンパクトな最終結果だけを見せます。

主目的は、Notion の検索、取得、更新、検証の途中でモデルへ制御を戻す回数を減らすことです。Notion API リクエスト数や上流 MCP Tool Call 数をゼロにすることではありません。

```mermaid
flowchart LR
    Client["Codex / Claude Code"] -->|"local stdio"| Ops["notion-ops-mcp"]
    Ops -->|"Streamable HTTP + OAuth/PAT"| Official["Official Notion MCP"]
    Official --> Workspace["Notion Workspace"]
```

## 2. 固定する設計判断

- 実装言語は TypeScript、実行環境はサポート中の Node.js LTS とする。
- 外向きの初期トランスポートはローカル stdio のみとする。
- npm パッケージ名と実行コマンドは `notion-ops-mcp` とし、利用者が Git clone せず `npx -y notion-ops-mcp` で利用できるようにする。
- Notion との通信には、原則として公式のホスト版 Notion MCP を使う。Notion REST API を並行して独自実装しない。
- サーバー内部からモデルを呼び出さない。意味判断は呼び出し元モデルに残し、決定的な API 手順だけをまとめる。
- 上流 Notion MCP の全 Tool をそのまま外部公開しない。外部には、このプロジェクトが提供する複合 Tool だけを公開する。
- 汎用 Workflow IR、汎用オーケストレーター、DAG エンジン、QuickJS、任意 JavaScript 実行、プラグインシステムは実装しない。
- GitHub と Notion の同期機能は実装しない。
- 永続ジョブキュー、データベース、分散実行、クロスランキャッシュは実装しない。
- 公開 OSS を前提とし、秘密情報をコード、設定例、ログ、テスト fixture に含めない。

## 3. 外向きの利用方法

Codex では次のような形で追加できることを目標とします。

```bash
codex mcp add notion-ops -- npx -y notion-ops-mcp
```

Claude Code では次のような形です。

```bash
claude mcp add --transport stdio notion-ops -- npx -y notion-ops-mcp
```

標準出力には MCP JSON-RPC 以外を一切書かず、診断ログは標準エラーだけへ書いてください。引数なしのコマンドをサーバー起動とし、初期版では `serve`、`login`、`logout`、`status` の CLI サブコマンドを増やさないでください。

## 4. 上流 Notion MCP クライアント

公式 MCP TypeScript SDK を利用し、既定で `https://mcp.notion.com/mcp` へ Streamable HTTP 接続してください。

上流接続は専用の境界へ隔離し、少なくとも次の抽象を持たせてください。

- 接続と再接続
- Tool 一覧の取得と必要 Tool の存在確認
- Tool Call
- キャンセルとタイムアウト
- レート制限エラーの正規化
- 認証エラーの正規化
- テスト用 fake upstream への差し替え

公式 Tool 名やスキーマを思い込みで固定せず、実装開始時点の Notion 公式ドキュメントと、実際の `tools/list` を一次情報として確認してください。最低限、検索、取得、ページ作成、ページ更新に対応する公式 Tool を利用します。上流の互換性差分はアダプター内へ閉じ込めてください。

## 5. 認証

このサーバーはローカル stdio MCP なので、Codex や Claude Code が持つ「外向き MCP 接続用 OAuth」を、入れ子になった公式 Notion MCP 接続へ自動流用できると仮定してはいけません。`notion-ops-mcp` 自身が上流 Notion MCP の認証を担当します。

次の二つを提供してください。

1. 対話環境向け OAuth 2.0 Authorization Code + PKCE
2. ヘッドレス環境向け、環境変数から渡す Notion Personal Access Token

認証の優先順位、環境変数名、保存場所、権限、Token Refresh、期限切れ、再認証手順を文書化してください。

OAuth については次を守ってください。

- Notion 公式の MCP クライアント統合手順、OAuth discovery、PKCE、Dynamic Client Registration に従う。
- 初回の通常 Tool Call で未認証を検出した場合、プロトコルを壊すブラウザ出力や対話入力を行わず、構造化された `auth_required` 結果と認証 URL を返す。
- ローカル loopback callback を安全に扱い、state と PKCE verifier を検証する。
- 認証完了後は資格情報を安全に永続化し、次回起動から自動再接続する。
- Token を stdout、stderr、例外メッセージ、テレメトリーへ出さない。
- 保存ファイルを使う場合は OS の標準的なユーザー設定ディレクトリを使い、所有者だけが読める権限にする。保存層は後から OS Keychain へ差し替えられる境界にする。
- OAuth のユーザー操作が完了しなかった場合に、通常の MCP サーバー起動を永久にブロックしない。

PAT が設定されている場合は対話 OAuth を開始せず、上流 Notion MCP の Authorization header に使用してください。PAT の値自体は設定表示やログへ返さないでください。

## 6. 初期公開 Tool

初期版では、具体的な価値を説明できる次の二つに限定してください。公式 Notion MCP の単一 Toolを名前だけ変えて転送する Tool は追加しないでください。

### 6.1 `notion_read_document`

目的は「検索して対象を選び、内容を取得する」という複数ラウンドを一回へまとめることです。

要件:

- 入力はページ ID、URL、または検索条件のいずれかを明確に区別する。
- ID/URL が指定された場合は不要な検索をしない。
- 検索条件の場合は上流検索後に対象を決定し、対象が一意な場合だけ取得まで進む。
- 候補がゼロなら `not_found`、複数なら推測せず `ambiguous` と候補一覧を返す。
- ページ本文と必要最小限のメタデータを、モデルが扱いやすいコンパクトな構造で返す。
- 出力サイズに上限を設け、切り詰めた場合はその事実と元のおおよそのサイズを返す。
- 上流 Tool Call 数、処理時間、最終対象を秘密情報なしで summary に含める。

### 6.2 `notion_publish_document`

目的は「対象解決、既存内容確認、作成または更新、結果検証」という複数ラウンドを一回へまとめることです。

要件:

- Markdown の文書を受け取る。
- 既存ページの ID/URL、または明示的な親と新規タイトルを受け取れるようにする。
- 曖昧なタイトル検索の結果に対して書き込まない。
- 更新モードは少なくとも `append` と `replace` を区別する。
- `replace` は明示指定がなければ実行しない。
- `dry_run` を提供し、対象、予定操作、変更規模を返す。
- 書き込み後に上流から結果を確認し、確認できなければ成功として返さない。
- 上流が非同期タスクを返す場合は、公式仕様に従って期限付きで状態確認する。
- 書き込みを無条件に再試行して重複を作らない。読み取り再試行と書き込み再試行を分離する。
- 一回の呼び出し中の重複実行を防ぐ idempotency の考え方を設計し、可能な範囲で実装する。
- 返却値はページ ID、URL、実行モード、作成/更新、検証状態、上流 Tool Call 数、処理時間を含むコンパクトな summary とする。

## 7. 安全性と制限

- 入力は Zod 等で厳密に検証し、未知フィールドの扱いを決める。
- URL は Notion の許可された origin と形式を検証する。
- リクエスト全体のタイムアウト、上流 Tool Call 回数、出力バイト数、検索候補数に上限を設ける。
- 読み取りと書き込みをコード上で区別する。
- 書き込み前に対象を確定し、曖昧な候補へ書き込まない。
- キャンセルを上流呼び出しへ伝播する。
- レート制限では Retry-After を尊重し、上限付きバックオフを使う。ただし副作用のある処理を盲目的に再送しない。
- ログには Tool 名、状態、回数、時間などのメタデータだけを残し、ページ本文、検索結果本文、Token、Authorization header を残さない。
- 依存関係を最小限にし、採用理由を文書化する。

## 8. モデル呼び出し削減の検証

「高速そう」ではなく、各複合 Tool が何回のモデル往復を一回へ畳み込むのかを README に明記してください。

例:

```text
従来:
model -> search -> model -> fetch -> model

notion_read_document:
model -> notion_read_document(search + fetch) -> model
```

サーバーはモデルを呼ばないため、計測対象は少なくとも次とします。

- 一つの外向き Tool Call に含まれた上流 Tool Call 数
- wall time
- retry 回数
- read/write の別
- 成功、not_found、ambiguous、auth_required、rate_limited、failed

## 9. テスト

実資格情報や実ワークスペースに依存しない自動テストを用意してください。

- 単体テスト: 入力検証、曖昧性判定、出力上限、エラー正規化、Retry 判定、Token の redaction
- OAuth テスト: state/PKCE 検証、期限切れ、refresh、保存権限、Token 非漏えい
- 結合テスト: fake MCP server に対する initialize、tools/list、search + fetch、create/update + verify
- stdio MCP テスト: initialize、tools/list、Tool Call、stdout が JSON-RPC のみであること
- 失敗テスト: 上流タイムアウト、429、401、Tool 不足、曖昧検索、非同期タスク失敗、キャンセル

テスト用 fake upstream は、実装本体と同じ MCP プロトコル境界を通してください。実装詳細を直接モックして結合境界を迂回しないでください。

## 10. OSS と配布

- MIT License
- `README.md`: 目的、非目的、アーキテクチャ、Codex/Claude Code 設定、認証、Tool リファレンス、セキュリティ、モデル往復削減例
- `docs/`: 認証フロー、実行フロー、セキュリティモデル、開発手順
- npm package の `bin` を正しく設定する
- `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` を用意する
- GitHub Actions で上記を実行する
- npm 公開や外部サービスへのデプロイは、明示的な許可を得るまで実行しない

## 11. 実装の進め方

1. 実装前に、Notion 公式 MCP の最新 Tool、認証、非同期処理仕様を一次資料で確認する。
2. まずアーキテクチャ、Tool 入出力、認証状態遷移、エラー分類を文書として確定する。
3. 上流 MCP client と fake upstream を作る。
4. 読み取り複合 Tool を実装して結合テストする。
5. 書き込み複合 Toolを dry-run、対象確定、検証付きで実装する。
6. OAuth/PAT、永続化、refresh を完成させる。
7. stdio 結合テスト、セキュリティテスト、全品質チェックを通す。
8. README と docs が実装と一致することを最終確認する。

既存の設計から離れる必要が生じた場合は、黙って拡張せず、変更理由、増える責務、代替案を示してください。特に汎用ワークフロー機能を追加してはいけません。

## 12. 完了条件

- 一般利用者が Git clone せず、npm パッケージとして起動できる。
- Codex と Claude Codeからローカル stdio MCPとして初期化できる。
- サーバーが公式 Notion MCP へ接続し、認証状態を安全に処理できる。
- `notion_read_document` が検索と取得をモデルへ戻らず完了できる。
- `notion_publish_document` が対象確定から検証までをモデルへ戻らず完了できる。
- 曖昧な対象や未認証を安全で構造化された結果として返す。
- stdout にログや認証 URL を直接混ぜない。
- Token やページ本文をログへ漏らさない。
- fake upstream を使う全自動テストと、format/lint/typecheck/build が成功する。
- 実装と日本語ドキュメントが一致している。

