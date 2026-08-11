# notion-ops-mcp

`notion-ops-mcp` は、Notion 文書の読み取りと競合に強い公開処理を一回の Tool Call にまとめる、ローカル stdio MCP サーバーです。内部では公式ホスト版 Notion MCP に Streamable HTTP で接続し、検索・取得・更新・再取得検証を決定的に組み合わせます。

サーバー内部でモデルを呼ばず、Notion REST API の別実装や上流 Tool の透過プロキシも行いません。公開 Tool は `notion_read_document` と `notion_publish_document` の二つだけです。

## 必要環境

- Node.js 22 以上
- 公式 Notion MCP へ接続できるネットワーク
- `NOTION_TOKEN`、またはブラウザで完了できる Notion OAuth 認証

## セットアップ

インストールせず npm パッケージを直接起動できます。

Codex:

```bash
codex mcp add notion_ops -- npx -y notion-ops-mcp
```

`notion_ops` という固定名にすると、Codex 内部の完全修飾 Tool 名も安定します。初回の
`npx` 取得が10秒を超える環境では、`~/.codex/config.toml` の
`[mcp_servers.notion_ops]` に `startup_timeout_sec = 30` と `required = true` を追加してください。
セッション開始後は `/mcp` で接続状態を確認できます。Codex が同名のNotionプラグインを
選ぼうとする場合は、最初の依頼で
`mcp__notion_ops__notion_read_document` または
`mcp__notion_ops__notion_publish_document` を明示すると確実です。

Claude Code:

```bash
claude mcp add --transport stdio notion-ops -- npx -y notion-ops-mcp
```

ヘッドレス環境では MCP クライアントを起動するプロセスに PAT を渡します。

```bash
NOTION_TOKEN="your-token" npx -y notion-ops-mcp
```

引数なしがサーバー起動です。初期版に `serve`、`login`、`logout`、`status` サブコマンドはありません。stdout は MCP JSON-RPC 専用で、診断ログは stderr にだけ出力します。

## 認証

認証の優先順位は次のとおりです。

1. 環境変数 `NOTION_TOKEN`
2. OS 標準設定ディレクトリに保存した OAuth 資格情報
3. OAuth 2.0 Authorization Code + PKCE の開始

PAT 設定時は OAuth を開始しません。未認証の通常 Tool Call は `auth_required` と `authorization_url` を構造化結果として返します。URL をブラウザで開いて認可を完了し、元の Tool Call を再実行してください。ブラウザの自動起動や端末上の対話入力は行いません。

stdio サーバー起動時に PAT または保存済み OAuth 資格情報がすでにある場合は、上流接続と Tool catalog をバックグラウンドで準備します。資格情報がない場合、このウォームアップは上流へ接続せず、OAuth も開始しません。

OAuth 資格情報は所有者だけが読めるファイルへ原子的に保存し、期限の5分前から refresh します。refresh token rotation に対応し、`invalid_grant` や上流 401 では保存資格情報を破棄して再認証を要求します。詳しくは [認証フロー](docs/authentication.md) を参照してください。

## Tool

すべての入力は strict schema で検証され、未知フィールドは拒否されます。完全な JSON Schema は MCP の `tools/list` から取得できます。

### `notion_read_document`

ページ ID、Notion URL、検索条件のいずれか一つで対象を解決し、Markdown、最小限のメタデータ、後続更新用 revision を返します。ID/URL 指定時は検索しません。検索結果が0件なら `not_found`、タイトル完全一致が一意ならその候補を取得し、それ以外の複数候補は本文を取得せず `ambiguous` と候補一覧を返します。

```json
{
  "source": { "type": "search", "query": "運用 Runbook" },
  "max_output_bytes": 65536,
  "timeout_ms": 30000
}
```

`source` は次のいずれかです。

- `{ "type": "page_id", "page_id": "..." }`
- `{ "type": "url", "url": "https://www.notion.so/..." }`
- `{ "type": "search", "query": "..." }`

成功時の revision は `last_edited_time` と本文の SHA-256 を含み、本文そのものは含みません。返却本文は既定64 KiBまでで、切り詰め時は `truncated` と `original_bytes` を返します。

最大8文書をまとめて読む場合は、`source` の代わりに `sources` を指定します。結果順は入力順を保ち、文書ごとの成功・失敗と集計を一度に返します。`max_output_bytes` はバッチ全体の上限です。`page_id`、`url`、`query` のキーが一意なら selector の `type` は省略できます。明示形式も後方互換のため引き続き利用できます。

```json
{
  "sources": [
    { "type": "page_id", "page_id": "..." },
    { "type": "search", "query": "運用 Runbook" }
  ],
  "max_output_bytes": 65536
}
```

### `notion_publish_document`

新規ページを作成するか、既存ページの最新版へ限定更新を適用し、再取得して検証します。対象検索が曖昧な場合は書き込みません。

既存ページへの追記例:

```json
{
  "target": { "type": "page_id", "page_id": "..." },
  "operation": { "type": "append", "markdown": "## 2026-08-09\n\n作業完了" },
  "base_revision": {
    "version": 1,
    "last_edited_time": "2026-08-09T00:00:00.000Z",
    "content_sha256": "..."
  },
  "conflict_policy": "auto_rebase",
  "dry_run": false
}
```

新規作成例:

`parent` を省略すると、接続ユーザーのプライベートページとして作成します。既存ページやデータソース配下に作る場合だけ `parent` を指定します。

```json
{
  "target": {
    "type": "create",
    "parent": { "type": "page_id", "page_id": "..." },
    "title": "Release plan"
  },
  "markdown": "# Release plan\n\nShip safely.",
  "dry_run": true
}
```

同じ既存ページへ最大10操作を順番に適用する場合は `operation` の代わりに `operations` を指定します。互いに独立した対象限定編集は一回の上流更新へまとめ、前の編集結果に依存する操作は指定順に実行します。競合結果の `operation_index` は0始まりです。

```json
{
  "target": { "type": "page_id", "page_id": "..." },
  "operations": [
    { "type": "replace_text", "old_text": "Draft", "new_text": "Approved" },
    { "type": "append", "markdown": "## Decision\n\nApproved" }
  ],
  "conflict_policy": "auto_rebase"
}
```

同じ親の下へ最大8ページを一回の上流作成要求で作る場合は `create_batch` を使います。作成自体は再送せず、各ページを取得して検証します。

```json
{
  "target": {
    "type": "create_batch",
    "parent": { "type": "page_id", "page_id": "..." }
  },
  "pages": [
    { "title": "Plan A", "markdown": "# Plan A" },
    { "title": "Plan B", "markdown": "# Plan B" }
  ]
}
```

既存ページの操作は `append`、`prepend`、`insert_after`、`insert_before`、`replace_text`、`replace_document` です。insert は一意な heading/context anchor、replace は一意な `old_text` を必要とします。`replace_document` には `confirm_replace_document: true` が必須です。

`conflict_policy` の既定は `fail_on_change` です。`auto_rebase` は最新版で再評価できる限定操作だけに使い、anchor の消失・複数一致、同一箇所の双方編集、変更後の全文置換は `conflict` で停止します。要求がすでに一度だけ反映済みなら書き込まず `already_applied` を返します。

結果状態と詳細な契約は [Tool 入出力契約](docs/tool-contracts.md)、更新アルゴリズムは [実行フロー](docs/execution-flows.md) を参照してください。

## モデル往復の削減

検索から取得までをモデルが逐次選ぶ場合:

```text
model -> search -> model -> fetch -> model
```

`notion_read_document` では次の一往復です。

```text
model -> notion_read_document(search + fetch) -> model
```

公開処理も同様に、対象解決・最新版取得・更新・検証の途中でモデルへ制御を戻しません。

```text
従来: model -> resolve -> model -> fetch -> model -> write -> model -> verify -> model
本ツール: model -> notion_publish_document(resolve + fetch + write + verify) -> model
```

これはモデル往復を減らすもので、Notion API や上流 MCP Tool Call をゼロにするものではありません。各結果の `summary` には read/publish の別、上流 Tool Call 数、retry 数、wall time、最終状態が含まれます。

## 安全性と制限

- 曖昧な検索結果へ書き込まない
- 読み取りだけを最大2回再試行し、書き込みは盲目的に再送しない
- 書き込み直前の最新版を使い、書き込み後も再取得して検証する
- request timeout は既定30秒・最大120秒
- 単一処理の上流 Tool Call 数は read 4回・publish 10回、バッチ処理は read 最大24回・publish 最大30回
- 一回の入力は read 最大8文書、create 最大8ページ、同一ページ更新は最大10操作
- 入力 Markdown は最大1 MiB、返却本文は最大64 KiB、検索候補は最大10件
- Notion ページ URL は許可 origin、HTTPS、ページ ID を検証する
- Token、Authorization header、検索 query、Markdown/本文をログへ出さない

Notion MCP に compare-and-swap や永続 idempotency key がないため、プロセス障害を越える exactly-once は保証しません。不明な書き込み結果は再送せず、最新版の再取得で適用済みかを判定します。脅威モデルと残る制約は [セキュリティモデル](docs/security.md) に記載しています。

## 非目的

- 上流 Notion MCP Tool の透過公開
- Notion REST API の並行実装
- サーバー内部からのモデル呼び出し
- GitHub/Notion 同期、汎用ワークフロー、任意コード実行
- 永続ジョブキュー、DB、分散実行、クロスランキャッシュ

## 開発

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## リリース

`main` への変更は Release Please が Release PR にまとめます。そのPRをマージすると、
GitHub Releaseの作成、npm Trusted Publishingによる公開、`.tgz`とSHA-256チェックサムの
Releaseへの添付までGitHub Actionsが実行します。初回設定と復旧手順は
[`docs/releasing.md`](docs/releasing.md)を参照してください。

テストは実資格情報を使わず、同じ MCP プロトコル境界を通る in-memory fake Notion MCP と実 stdio 子プロセスで実行します。詳しくは [開発手順](docs/development.md) を参照してください。

## 設計資料

- [アーキテクチャ](docs/architecture.md)
- [認証フロー](docs/authentication.md)
- [Tool 入出力契約](docs/tool-contracts.md)
- [実行フローと競合分類](docs/execution-flows.md)
- [セキュリティモデル](docs/security.md)
- [開発手順](docs/development.md)

## License

[MIT](LICENSE)
