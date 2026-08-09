# アーキテクチャ

## スコープ

`notion-ops-mcp` は、ローカル stdio の MCP サーバーである。同時に公式ホスト版 Notion MCP
（既定 `https://mcp.notion.com/mcp`）の MCP クライアントとして動作する。外部へ公開する Tool は
`notion_read_document` と `notion_publish_document` の二つだけで、上流 Tool の透過プロキシは行わない。

サーバー内部でモデル、Notion REST API、永続ジョブキュー、汎用ワークフロー実行基盤は使用しない。

## コンポーネント境界

```text
stdio MCP server
  -> strict input schemas
  -> read/publish application services
  -> McpUpstreamClient boundary
       -> authenticated Streamable HTTP MCP adapter
       -> protocol-level fake MCP server in tests
  -> compact result formatter
```

- `McpUpstreamClient` は connect/reconnect、`tools/list`、Tool 呼び出し、timeout/cancel、エラー正規化を担う。
- アプリケーションサービスは検索候補の確定、revision、決定的な文字列編集、検証を担う。
- 認証層は PAT/OAuth の選択、refresh、保存を担い、ページ本文を受け取らない。
- logger は Tool 名、状態、回数、retry、経過時間だけを stderr へ出す。

一回の外向き Tool Call に対して request scope を作り、上流呼び出し数、deadline、AbortSignal、retry 数を
保持する。状態は呼び出し終了時に破棄し、クロスランキャッシュは持たない。重複防止は最新版の本文と
要求操作を比較する call-local な判定で行う。

## 上流互換性

2026-08-10 時点の公式資料で使用する Tool は次のとおりである。

| 用途 | 公式 Tool | 主な入力 |
| --- | --- | --- |
| 検索 | `notion-search` | `query` |
| 取得 | `notion-fetch` | `id`（ページ ID または URL） |
| 作成 | `notion-create-pages` | `parent`, `pages[].properties.title`, `pages[].content` |
| 更新 | `notion-update-page` | `page_id`, `command`, command 固有の平坦な引数 |
| 非同期確認 | `notion-get-async-task` | `task_id` |

OpenAI MCP クライアントでは search/fetch の prefix が省略される場合があるため、アダプターは
`notion-search`/`search` と `notion-fetch`/`fetch` の既知 alias を扱う。ただし名前を思い込みで
呼ばず、接続ごとに `tools/list` の名前と JSON Schema を確認する。必須 Tool や必須プロパティが
なければ、書き込み前に `upstream_incompatible` として停止する。生の上流 Tool は外部へ公開しない。

上流結果は MCP content block から一個の JSON text block を取り出し、保守的な schema で正規化する。
未知フィールドは無視できるが、ID、本文、候補、非同期 task の必須値を推測しない。

## 制限

Tool 入力で timeout と返却本文上限を下方調整できるが、コード上の hard ceiling を超えられない。

- 外向き request deadline: 30 秒（hard ceiling 120 秒）
- 上流 Tool Call: 単一 read 4 回、単一 publish 10 回、batch read 24 回、batch publish 30 回
- バッチ幅: read 8文書、create 8ページ、同一ページ publish 10操作、上流並列度3
- 検索候補: 10 件
- 返却本文: UTF-8 64 KiB
- 入力 Markdown: UTF-8 1 MiB
- 自動 rebase: 2 回
- 読み取り retry: 2 回。429 の `Retry-After` を deadline 内で尊重する
- 書き込み retry: transport failure では 0 回。結果を再取得して適用済みか検査する

## 参照した一次資料

- [Notion MCP Supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Build an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Working with markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)
