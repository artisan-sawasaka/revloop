# レビュー判定と処理エラーの分離

2026-10-19。皇帝B案の画像レビューrun `1d12b7ae-c04e-4970-be6b-db5cb26aafe5` の報告を受け、保存済み入力・出力・状態とDerの規約を照合した。

## 調査結果

Claude CLI自体は終了コード0・subtype=success・is_error=false。回答はPASS、findingsにP3が2件、visual.status=REVIEWEDで全8画像の具体的な観察があった。revloopのparseReviewが「PASSにはfindingsを含めない」という整合性条件を例外にしていた。その例外が、実施済みの画像確認までNOT_RUNとする原因だった。

この応答は「視覚レビューに成功したが、全体判定と指摘の分類が整合していない」。CLI故障・画像未送信ではない。ERRORとして視覚実施を落とす分類は不適切だった。

2件の指摘は以下のとおり。

1. 切り出し境界: 回答自身が「今回の目視では欠け・隣の人物の混入はない」「確認済みの欠陥ではない」と記述している。今後の再生成に備えた数値検査・空白検出方式の推奨は、現在の受入条件に必須でなければ参考意見notesに分けるべき。今回の衣装込み外観図へTripo用の検査要件を自動追加しない。
2. 終了コード・証拠PNG hash: Derのdocs/29_CHARACTER_IMAGE_RULES.md §3は処理原文・入力/出力hash・コマンド・終了コードの記録を要求している。process.pyはexit_code=0を固定値として書き、validation.jsonのfilesは成果物フォルダー内のPNGだけで、証拠側PNGを含めていない。記録不足を理由に画像の見た目を不合格とはしないが、必要な証拠の補完は別に残る。歴史上の実行終了コードを今になって推測で作らない。

Derの規約を緩めて合格にする必要はない。画像・Unity・ルール・採用状態は変更していない。

## 新しい動作

JSONの構造検査と、レビュー内容の合否判定を分ける。

| 回答 | 実効判定・動作 |
|---|---|
| PASS、findingsなし、notesあり/なし | PASS。参考意見による自動修正はしない |
| PASS、要修正findingsあり | 生のPASSを保存し、実効FAILとしてNEEDS_FIXへ。上限・停滞条件は従来どおり |
| FAIL、findingsあり | FAILとして修正・再レビュー |
| FAIL、findingsなし | BLOCKED。修正内容がないので自動編集しない |
| BLOCKED | BLOCKEDのまま |
| JSON不正、CLI失敗、セッション不一致、入力改変など | ERROR |

findingsは受入前に直す必要がある確認済み不具合・未達要件。notesは任意の改善案、未確認の懸念、今後の課題。P3という重大度だけでは必須/任意を決めない。レビュアーへの指示とJSON Schemaにも区分を追加した。旧回答のnotes省略は互換読込する。

rawのreview.jsonはそのまま保存し、decision.jsonにreportedVerdict・effectiveVerdict・warningsを保存する。CLIはreviewDecisionを表示する。全画像の観察と入力の整合性が確認できれば、全体判定がFAIL/BLOCKEDでもvisualReviewはREVIEWEDを維持する。

## 今回の保存済み回答の再判定

[emperor-reassessment.json](evidence/verdict-20261019/emperor-reassessment.json) は追加推論なしのオフライン再判定。元のinput.jsonのSHA-256が記録済みfingerprintと一致、添付8画像のハッシュが全て一致、findingsの2パスが元の対象範囲内、8画像の観察が過不足なくあることを確認した。

- 生判定: PASS、P3×2。
- 自動的な実効判定: FAIL → このrunの残り回数条件ではNEEDS_FIX。
- 目視: REVIEWED（記録された8画像）。独立の再目視を実施したという意味ではない。
- 任意/必須の再分類は、保存済みのfindingsを機械的にnotesへ移していない。1件目を任意提案と扱う判断と、2件目の証拠補完を行うのは次の作業。
- 元のstate.json・stdout.txtはハッシュ/バイト列不変。旧runのERROR履歴を上書きしたり、終了済みrunを無断で再開したりしない。
- Derの現行画像全体を再評価したものではない。6倍QA・Unity/Player/Tripo・採用判断は従来の状態を維持。

## 検証

61テスト成功。PASS+P0/P3の要修正指摘でNEEDS_FIX、参考意見付きPASS、空findingsのFAILでBLOCKED、目視REVIEWEDの保持、修正後の同一セッションPASS、元の生判定と指摘の保存を確認。課金・権限・上限・停滞・停止の既存テストも成功。実際のClaude回答も新しいデコーダーで読み直して検証した。新たなモデル呼び出し・画像修正・課金設定の変更はない。
