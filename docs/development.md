# 開発手順

## 環境

Node.js 22 以上と npm を使用する。依存関係は lockfile どおりに取得する。

```bash
npm ci
```

runtime dependency は二つだけである。

- `@modelcontextprotocol/sdk`: stdio server、Streamable HTTP client、MCP protocol schema
- `zod`: 外向き入力、上流 OAuth 応答、保存資格情報の runtime validation

TypeScript、Vitest、Biome と Node.js 型定義は開発時だけ使用する。

## 品質チェック

変更前後で次を実行する。

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` は実 token や実 workspace を必要としない。`FakeNotionMcp` は SDK の `McpServer` と
`InMemoryTransport` を使用し、製品コードと同じ initialize、`tools/list`、`tools/call` 境界を通す。
stdio テストは TypeScript を build し、`dist/cli.js` を子プロセスとして起動して stdout の各行が
JSON-RPC であることまで確認する。

主なテスト分類:

- `test/domain`, `test/notion`: revision、編集計画、URL、上流結果の単体テスト
- `test/auth`: discovery、PKCE/state、refresh、保存権限、非漏えい
- `test/upstream`: initialize、Tool catalog、error/retry 境界
- `test/tools`: search/fetch、create/update/verify、競合・失敗・保全ケース
- `test/server.test.ts`, `test/stdio.test.ts`: 外向き MCP と実 stdio process

## ローカル起動

build 後は次で stdio MCP サーバーを起動できる。stdout を人間向け出力へ redirect しないこと。

```bash
npm run build
NOTION_TOKEN="your-token" node dist/cli.js
```

OAuth を使う場合は `NOTION_TOKEN` を設定しない。未認証の最初の Tool Call が返す URL をブラウザで開く。
endpoint を変更する必要がある場合だけ `NOTION_MCP_URL` に HTTPS URL を設定する。

## 上流互換性の更新

公式 Notion MCP の Tool 名や schema が変わる可能性がある。更新時は次を守る。

1. Notion の Supported tools、MCP client integration、Markdown 更新仕様を一次資料で確認する。
2. runtime の `tools/list` 検査と `UpstreamToolCatalog` の対応を同時に更新する。
3. hosted output fixture と fake MCP schema を更新し、古い/新しい互換範囲を明記する。
4. 書き込みを blind retry しないことと、最終 fetch 検証を維持する。

実 token を fixture、snapshot、ログへ追加してはいけない。

## パッケージ確認

公開前の内容確認には次を使う。

```bash
npm pack --dry-run
```

`dist/cli.js`、型定義、README、LICENSE、docs だけが必要な内容とともに含まれることを確認する。npm 公開や
外部サービスへの deploy は、リポジトリ所有者の明示的な許可を得てから行う。
