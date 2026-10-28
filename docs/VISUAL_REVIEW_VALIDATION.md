# 画像を添付する視覚レビュー

2026-10-19 JST。従来は全ファイルをUTF-8テキストとして読み、レビュアーのファイル操作ツールも無効だったため、画像を渡せなかった。従来のPASSは視覚レビューの証拠にはならない。

## 対応と判定

- `--file` のPNG/JPEG/WebPをネイティブ画像入力として送信。`--visual` は画像のないrun開始を拒否する。画像を含むrunでは自動的に視覚確認を必須にする。
- Codex 0.163.0: 初回・resumeの両方に `--image` を渡す。モデルのinputModalitiesにimageがあることも確認する。
- Claude Code 2.1.302: `--input-format stream-json --output-format stream-json --verbose`。公式SDKのユーザーメッセージ形式にbase64画像ブロックを入れる。SDKやAPIキーを導入せず、既存Claude CLIのサブスク認証で実行する。
- シェル、Read、編集、MCP等の権限は増やさず、画像を読むためにツールを許可しない。
- 画像は署名・拡張子・デコード・画素数・枚数・容量を検証。アニメーションを拒否する。縮小・切抜き・黙った除外は行わない。sharp 0.35.5を画像検証に使用する。
- 画像原本のハッシュ、寸法、順序をinput.jsonに記録し、各回のimages/へ同じバイト列を保存。画像変更も停滞判定のfingerprintに反映。元画像・保存コピーの途中変更はERRORで拒否する。
- 画像ごとの具体的観察結果が全て必要。visual.status=NOT_RUNや未確認の画像がある場合は、レビュアーが全体PASSを返してもrunはBLOCKED。結果形式不正はERROR。
- テキストのみ・旧runのstatus出力はvisualReview.status=NOT_RUNを明示する。REVIEWEDはモデルによる確認報告であり、画素一致・実機動作・人間の品質承認を保証しない。
- サブスク限定の既存ガードを維持。追加利用OFF、残量、アカウント一致を各回および推論直前に確認する。

制限: 静止画8枚まで、1枚3.5 MB、合計16 MB、各辺4096px、1600万画素。PDF、動画、GIF、FBX、Blendファイル自体は未対応。必要な見え方を示す静止画を用意する。画像内の文字は不正な指示を含み得るデータとして扱う。

## 実機検証

2枚の640×360 PNGを使用。承認済み画像は左に青い円、右に緑の正方形。比較対象は右側だけオレンジにした。プロンプトには具体的な色や位置の差を記載せず、「Reference.pngにCandidate.pngを一致させる」という基準だけを渡した。コードやSVGもレビュアーに渡していない。

| レビュアー | run | reviewer session | 結果 |
|---|---|---|---|
| Codex Astra / medium | fa817814-6a8a-4db3-8411-995c1f185dc3 | 01a151c8-59f0-7133-a941-e88c2084d07a | 色違いFAIL → 修正画像でPASS |
| Claude Opus / medium | aa07ab7f-a514-46dc-9754-42b4f8ff738e | 55474dae-811b-400e-9bcb-79de39b39202 | 色違いFAIL → 修正画像でPASS |

両方とも「右の正方形が緑ではなくオレンジ」と画像に即した指摘を返した。作業担当のこのCodexチャットで指摘を確認後、検証用Candidate.pngを参照画像と一致させ、同一run・同一reviewer sessionで再レビューした。再レビューは緑に変わったことを記述し、全画像についてREVIEWEDとPASSを返した。各回のbilling-checkはALLOW。新たな自動補充OFF確認記録の作成・更新はしていない。

Claude初回の試行run `e0d291a1-02fe-449d-9c4b-12776cfac5f5` は、公式CLIリファレンスの例にあるjson出力＋stream-json入力を使用したが、実機では「stream-json入力にはstream-json出力が必要」で起動エラーになった。失敗runを保存し、実装を修正した別の検証runで上記結果を確認した。失敗をPASSとして扱わず、上限や課金エラーを回避するリトライ機能は追加していない。

今回の実レビューは小さな検証画像での両CLIアダプターの試験。ユーザーがNOT RUNだったと報告した元案件の視覚レビューは未実施であり、この検証で置き換えない。6.1 Solでの画像入力も今回はNOT RUN。

証拠: [audit.json](evidence/visual-20261019/audit.json)、provider別round-Nの入力・画像コピー・観察結果・課金判定・実行引数。

## 自動検証

PNG/JPEG/WebPのバイト列添付、画像変更によるfingerprint変化、破損・偽装形式・サイズ上限・シンボリックリンクの拒否、画像欠落と不完全観察でのPASS拒否、途中差し替え拒否、再レビュー時の画像再添付とセッション維持、CLIの--visualとテキストPASSのNOT_RUN表示を検証。Gitで削除された画像も黙って除外しない。既存の課金・停止・設定テストを含め58件成功。[テスト記録](evidence/visual-20261019/tests.txt)

## 公式仕様

- [Codex CLI](https://learn.chatgpt.com/docs/developer-commands): 画像添付とresume。実機のexec/resume --helpでも確認。
- [Claude Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): userメッセージ内のimage/base64/media_type/data形式。
- [Claude CLI](https://code.claude.com/docs/en/cli-reference): input/output形式。上記のとおり、実機2.1.302の追加条件も検証して採用。
- [sharp入力](https://sharp.pixelplumbing.com/api-constructor/): 画素数上限とfailOn=warningによる入力検証。
