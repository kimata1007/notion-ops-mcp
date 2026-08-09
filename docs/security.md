# セキュリティモデル

## 保護対象

Notion token、OAuth client secret/refresh token、ページ本文、検索結果本文、未公開 URL を保護対象とする。
信頼するのはローカル OS account、公式 MCP endpoint、利用者が選んだ MCP client である。Notion から取得した
本文は prompt injection を含み得る非信頼入力として、そのまま命令として解釈しない。

## 制御

- stdout は stdio MCP JSON-RPC 専用。診断は構造化して stderr だけへ送る。
- logger と error normalizer は secret/token/header/本文を redaction する。
- Tool input は strict validation、byte/call/deadline 制限を適用する。
- URL allowlist と loopback callback の host/path/state を検証する。
- read/write を型と呼び出し budget で分離し、曖昧な対象へ write しない。
- 全文置換は明示確認が必須。子ページ削除を許可する上流 option は送らない。
- 429 の retry は read と async status poll だけ。write は盲目的に retry しない。
- cancellation を一つの AbortSignal に統合し、上流 transport へ伝播する。
- テスト fixture には実 ID、token、本文を含めない。

call-local な重複防止は、最新版に要求内容が一度だけ存在するかを操作別に判定して実装する。プロセス障害を
越える exactly-once は Notion MCP に idempotency key/CAS がないため保証しない。不明結果では write を
再送せず再取得検証を行い、判定不能なら failed を返す。

## 残るリスク

- 資格情報ファイルは暗号化されない。端末の disk encryption と OS account の保護が必要である。
- Notion の CAS 不在により、直前取得と write、write と検証取得の間に小さい競合窓が残る。
- 取得本文は呼び出し元モデルへ返るため、その MCP client とモデルのデータ取扱いも信頼境界に含まれる。
- `NOTION_MCP_URL` で指定した endpoint は明示的な信頼対象になる。既定の公式 endpoint を推奨する。
