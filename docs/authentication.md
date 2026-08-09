# 認証フロー

## 優先順位

1. `NOTION_TOKEN` の PAT。設定時は OAuth を開始せず、保存もしない。
2. OS 標準設定ディレクトリに保存された OAuth access/refresh token。
3. 未認証なら OAuth Authorization Code + PKCE を開始し、`auth_required` と URL を Tool 結果で返す。

環境変数の値、Authorization header、access/refresh token、client secret、PKCE verifier はログ、例外、
stdout、Tool 結果へ含めない。

## OAuth 状態遷移

```text
unauthenticated
  -> discover (RFC 9470 -> RFC 8414)
  -> dynamic client registration (RFC 7591)
  -> pending(state + PKCE + loopback callback, 10 minute expiry)
  -> authenticated
  -> refreshing
  -> authenticated | reauth_required
```

初回 Tool Call は loopback の空き port に callback server を短時間だけ bind する。認証 URL を構造化結果
として返して Tool Call 自体は終了するため、stdio サーバーをブロックしない。callback は `127.0.0.1`
だけで listen し、固定 path、state の timing-safe 比較、一回限りの code、PKCE verifier、10 分の期限を
検証する。完了または期限切れで listener と pending secret を破棄する。ブラウザは自動起動しない。

access token は期限の5分前から refresh する。refresh token rotation に対応し、応答に新 token が
含まれたら credential 一式を原子的に置換する。`invalid_grant`、期限切れ、401 は保存資格情報を無効化し、
新しい `auth_required` を返す。

## 保存

保存境界 `CredentialStore` を設け、初期実装は JSON file store とする。

- macOS: `$XDG_CONFIG_HOME/notion-ops-mcp/credentials.json`、未設定時
  `~/Library/Application Support/notion-ops-mcp/credentials.json`
- Linux: `$XDG_CONFIG_HOME/notion-ops-mcp/credentials.json`、未設定時
  `~/.config/notion-ops-mcp/credentials.json`
- Windows: `%APPDATA%\\notion-ops-mcp\\credentials.json`

directory は `0700`、一時ファイルと最終 file は `0600`。同一 directory で rename して原子的に保存し、
symlink は拒否する。この境界は将来 Keychain 実装へ差し替えられる。ローカル file は平文のため、端末の
disk encryption と OS account 保護が信頼境界に含まれる。

`invalid_grant` や上流 401 の場合はサーバーが保存ファイルを破棄する。手動で再認証する場合も上記の
`credentials.json` を削除して次の Tool Call を行う。初期版に CLI subcommand は設けない。

## OAuth を完了する手順

1. 未認証状態で `notion_read_document` または `notion_publish_document` を呼ぶ。
2. `auth_required` 結果の `authorization_url` を10分以内にローカルのブラウザで開く。
3. Notion で対象 workspace へのアクセスを許可する。ブラウザは loopback callback へ戻る。
4. 認証完了後、元の Tool Call を再実行する。

サーバーはブラウザを自動起動せず、認証 URL を stdout の通常ログにも書かない。callback が完了しない
場合も Tool Call はすでに終了しており、stdio サーバーの初期化や別 request を永久にブロックしない。

## 上流 endpoint

既定値は `https://mcp.notion.com/mcp` である。明示的な互換性検証や proxy が必要な場合だけ
`NOTION_MCP_URL` で変更できるが、userinfo と fragment を含まない HTTPS URL に限る。保存資格情報は
endpoint と紐付け、別 endpoint へ自動流用しない。
