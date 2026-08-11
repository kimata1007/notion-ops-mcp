# Tool 入出力契約

入力はすべて strict schema で検証し、未知フィールドを拒否する。以下は意味上の契約であり、実際の
JSON Schema はサーバーの `tools/list` が返す。

## `notion_read_document`

`source` は次の discriminated union で、同時指定できない。

- `{ type: "page_id", page_id }`
- `{ type: "url", url }`
- `{ type: "search", query }`

複数文書は `source` の代わりに同じ union の `sources` を1〜8件指定する。結果の `results` は入力順を
保ち、各要素が単一読み取りと同じ終了状態を持つ。`summary` は状態別件数を集計し、
`max_output_bytes` はバッチ全体へ公平に配分する。

ID/URL は検索せず取得する。検索は候補がちょうど一件の場合だけ取得する。結果は次の状態を取る。

- `success`: `page`, `revision`, `summary`
- `not_found`: 候補なし
- `ambiguous`: 本文を含まない候補一覧
- `auth_required`, `rate_limited`, `failed`

`revision` は `{ version: 1, last_edited_time, content_sha256 }` で、本文や資格情報を含まない。
本文を UTF-8 byte 境界で切り詰めた場合、`truncated: true` と `original_bytes` を返す。

## `notion_publish_document`

`target` は次の union である。

- 既存: page ID、Notion URL、または検索条件
- 新規: `title` と任意の `parent`（page/data source）。`parent` を省略するとプライベートページとして作成
- 複数新規: `type: "create_batch"`、任意の共通 `parent`、1〜8件の `pages[{ title, markdown }]`

検索候補が一件でなければ書き込まない。既存ページに対する `operation` は次の union である。

- `append` / `prepend`: `markdown`
- `insert_after` / `insert_before`: `anchor` と `markdown`
- `replace_text`: `old_text` と `new_text`
- `replace_document`: `markdown` と `confirm_replace_document: true`

同じページへ複数操作を行う場合は `operation` の代わりに `operations` を1〜10件指定する。操作は配列順に
評価する。独立した対象限定操作は一回の `update_content` にまとめ、依存する操作は順番に実行する。
`replace_document` は他の操作と混在できない。競合した操作は0始まりの `operation_index` で示す。

anchor は `{ kind: "heading" | "context", text }` で、最新版本文中で一度だけ一致しなければならない。
見出し anchor は Markdown 見出し行全体、context anchor は指定文字列全体を対象にする。

任意の `base_revision` と `conflict_policy`（既定 `fail_on_change`、または `auto_rebase`）、
`dry_run` を受け取る。`replace_document` は base revision から変化があれば policy にかかわらず停止する。

結果状態は `success`, `partial`, `already_applied`, `dry_run`, `not_found`, `ambiguous`, `conflict`,
`auth_required`, `rate_limited`, `failed`。summary は page ID/URL、作成/更新、操作、rebase、検証状態、
操作数、上流 Tool Call 数、retry 数、wall time を含み、本文を含まない。`partial` は複数ページ作成が
完了した後、一部の取得検証に失敗した状態であり、作成要求を盲目的に再送してはならない。

## URL

HTTPS の `notion.so`, `www.notion.so`, `notion.com`, `www.notion.com` のページ URL だけを受理する。
userinfo、非標準 port、fragment は拒否する。上流 MCP URL は別設定で、既定値以外を使う場合も HTTPS
（テスト時だけ loopback HTTP）に限定する。
