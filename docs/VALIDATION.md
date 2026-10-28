# 検証記録 — 2026-10-18 JST

デスクトップ起点の追加検証は [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md) を参照。CLIの作業担当smokeとは別に記録する。

**最新の条件付き課金ガード版も両デスクトップ起点で実機PASS。** [最新の条件・検証結果](BILLING_SAFETY.md)。以下の初期実機結果は履歴として区別する。

対象: Windows / Node 24.12.0 / Codex 0.153.4 / Claude Code 2.1.302（調査開始時2.1.296）。CLIの更新・ログインはユーザー操作。revloopによる認証の変更なし。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| TypeScript build | PASS | `npm run build` |
| 自動テスト | PASS: 37件 | 制御・環境変数・条件付き課金判定・端末パーサー・停止を検証。最新結果はBILLING_SAFETY.md |
| 生成Skillsの静的validator | PASS: 両方 | `skill-creator/scripts/quick_validate.py` |
| Codexの `$revloop` 候補表示 | PASS | 実TUIでrevloop [Skill]を表示しEnterで挿入。[menu probes](evidence/skill-menu-probes.txt) |
| Codexの `/revloop` | 非対応を確認 | 実TUIでUnrecognized command。[slash probe](evidence/codex-slash-probe.txt) |
| Claudeの `/revloop` 候補表示 | PASS | 実TUIで登録されたSkillの説明を表示 |
| Codexサブスクリプション推論 | PASS | ChatGPT認証、実execとresumeで同一ID・前ターンの内容を確認 |
| Claudeサブスクリプション推論 | PASS | 初回はOAuth期限切れ。ユーザー再ログイン後claude.aiで実推論成功 |
| Codexレビュー → fixture修正 → 同一ID再レビュー | PASS: FAIL→PASS | [最終smoke](evidence/codex-live-smoke-final.txt)、run `20c9903d-499b-4fbb-9f68-01e005bdac04` |
| Claudeレビュー → fixture修正 → 同一ID再レビュー | PASS: FAIL→PASS | [再ログイン後smoke](evidence/claude-live-smoke-authenticated.txt)、run `2237e671-828f-47ac-8d1c-d6a85a81cbb0` |
| レビューセッション同名化 | PASS: 両方 | Codex thread/read.name一致、Claude自身の検証用transcriptにcustom-titleあり |
| 元Claude AIの完全自動ループ | PASS | `/revloop`を入力した元ClaudeがCodexへレビュー依頼、FAIL、元Claudeで編集・テスト、同じrunの再レビューPASS。[worker smoke](evidence/claude-worker-smoke-final.txt) |
| Claudeデスクトップ `/revloop` からの自動ループ | PASS | 最終試験は追加続行指示なし。元UIの権限表示はユーザー許可後の「権限をバイパス」。[詳細と根拠](DESKTOP_VALIDATION.md) |
| Codexデスクトップ元チャットでのSkill実行 | PASS | 元チャット・reviewer ID維持、FAIL→修正→3テストPASS→再レビューPASS。[詳細と根拠](DESKTOP_VALIDATION.md) |
| この元Codexチャット → Claude → 元チャットで修正 → Claude | PASS | この開発チャットを維持してCLI連携を実行。FAIL→修正と3つのassert→同じClaude IDでPASS。[元チャット往復](evidence/codex-origin-chat.txt) |
| 別プロセスCodex作業担当の完全自動ループ | BLOCKED | workspace-writeを要求してもホストからread-only policyが適用され、Skill読取りが拒否された。権限緩和なし。run作成前に停止。[Codex worker](evidence/codex-worker-smoke.txt) |
| 強制停止・timeout・プロセスツリー | PASS | 自動テストで孫プロセスの終了も確認 |
| 入力不変性・不正JSON・範囲外指摘・排他 | PASS | 自動テスト。誤ったPASSを採用しない |
| npm配布内容の生成確認 | PASS | `npm pack --dry-run`。公開・アップロードは未実施 |
| Windows EXE / 署名 / 別PC | NOT RUN | 将来段階 |

## 元Claude AIの自動ループ

- source session: `097ded2b-65fa-4671-9a9b-3a6e12fe8747`
- reviewer session: `01a14c97-dbd4-7720-b203-3dadcfe8e548`
- run: `84501181-1c31-4b19-adce-b0262682c12b`
- 元チャットのprintプロセスが生きたまま、独立したCodexのCLIを2回呼び出した。元IDをmanifestに保存。
- `calc.ts` の `a - b` をレビューが検出し、元Claudeが `a + b` へ修正。2回目にPASS。
- 元Claudeはnodeで代表値 `[5, 0, 0.75]` を確認。レビュアー自身はテスト実行なし。TypeScript typecheckはfixtureに対してNOT RUN。
- 最初のworker試験では、設定読込みを全て無効化したためSkillが未登録となりファイル読取りで代替した。またstatusと編集を並行実行した。Skillを改善し、プロジェクトSkillを読込む構成で再試験。最終試験ではstatusの正常終了後に編集した。[元transcriptの順序検証](evidence/worker-order.json)でも、status結果(index 58)がEdit(index 69)より前であることを確認。
- 最終worker試験では、利用者の既存グローバル指示による統計footerコマンドが許可対象外で拒否された。レビュー・修正・再レビューは完了し、外部統計スクリプトは実行されなかった。

## 証拠の範囲

AIレビューのPASSはこの小さなfixtureの受入れ条件に対するもの。一般のコードに欠陥がないことや任意のホストで無人実行できることを保証するものではない。汎用性は状態機械のテストで補う。

Codexを作業担当とする場合のClaudeレビュアーは実CLIで検証済み。別プロセスCodexのホスト全体で `$revloop` → 自動修正まで通す実AI試験は実行したが環境ポリシーでBLOCKED。元AIの修正はホストの編集権限・許可・コンテキストに従う。stopコマンドだけで元AIの実行中編集を取り消すことはできず、ホストの停止操作が必要。

編集権限があるこの元Codexチャットからの往復はrun `b01f965b-f0ea-45fc-b023-8926389dae8a` でPASS。Claude reviewer IDは `5dbe44e5-8542-400c-82b1-27bc7efa84ac` を維持した。元チャットのIDが明示されていないためsourceSessionは省略。この経路はCLIコマンドを元AIが直接使用したものであり、Codex TUIのSkill自動読込みから全工程を完走した証拠とは区別する。

再現コマンド:

```powershell
npm test
node test/live-smoke.mjs codex
node test/live-smoke.mjs claude
node test/live-worker.mjs
node test/live-codex-worker.mjs
```

実CLI試験は利用枠を消費する。APIキーを新規発行せず、課金キーにフォールバックしなかった。Claude JSONのtotal_cost_usdはCLIが返すlist costの値で、実請求額の証拠として使っていない。
