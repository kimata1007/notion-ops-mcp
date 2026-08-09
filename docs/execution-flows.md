# 実行フローと競合分類

## Read

1. deadline と call budget を作る。
2. credential を解決し、接続して `tools/list` を検査する。
3. ID/URL は直接 fetch。検索は search し、0/複数候補を終了状態にする。
4. 一件だけ fetch して本文 SHA-256 と `last_edited_time` から revision を作る。
5. byte 上限を適用し、メタデータと計測値だけを返す。

従来 `model -> search -> model -> fetch -> model` の二回のモデル往復を、
`model -> notion_read_document(search + fetch) -> model` の一回に畳み込む。

## Publish

1. 対象を確定する。検索の 0/複数候補には書き込まない。
2. 新規作成は dry-run でなければ一回だけ create し、fetch で検証する。
3. 既存更新は書き込み直前に fetch し、revision と操作対象の一意性を検査する。
4. request fingerprint と最新版から `already_applied` を判定する。
5. 決定的な予定本文と、上流の対象限定 command を作る。
6. 書き込みは一回だけ行う。不明な transport failure は再送せず fetch して適用済みか判定する。
7. fetch した最新版で要求が一度だけ反映され、書き込み前の非対象部分が保持されたことを検証する。

従来 `model -> resolve -> model -> fetch -> model -> write -> model -> verify -> model` を、
`model -> notion_publish_document(resolve + fetch + write + verify) -> model` に畳み込む。

## 決定的な rebase

- append/prepend は常に書き込み直前の最新版へ適用する。
- insert は最新版で anchor が一意なら再計算する。消失・複数一致は conflict。
- replace_text は最新版で old_text が一度だけ一致するときだけ更新する。0/複数一致は conflict。ただし
  old_text がなく new_text が一度だけあれば already_applied。
- replace_document は revision 変化時に停止する。
- base revision が変化し、policy が `fail_on_change` なら限定操作でも停止する。
- `auto_rebase` でも同じ対象箇所が双方で変化した可能性を決定的に否定できない場合は停止する。

Notion MCP/Markdown API に compare-and-swap はない。直前取得と直後検証の間の競合窓は残るため、検証不能
なら成功を返さない。rebase/再取得は各二回までで、同じ指紋の write を無条件に再送しない。

## 非同期処理

大きい Markdown では create/update に `allow_async: true` を付けられる。`async_task` が返った場合だけ
`notion-get-async-task` を `poll_after_seconds` 以上の間隔、全体 deadline 内、回数上限内で poll する。
`succeeded` の result を通常応答として処理し、`failed` や deadline 超過を成功扱いしない。

