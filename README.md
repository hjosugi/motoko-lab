**Motoko Mastery Kit 2026**  
スナップショット: **2026-07-20 JST**  
このリポジトリは、Motokoを初級から本番運用、言語処理系への貢献まで一気通貫で学ぶための実践キットです。中心テーマは、AI時代のクリエイター来歴を記録する分散証跡サービスです。  
**このキットで達成すること**  
1. 現行Motokoの基本構文ではなく、actor、Candid、直交永続化、upgrade、inter-canister call、cycles、securityを実装できる。  
2. 5つの実用バックエンドを読み、変更し、ローカル配備し、本番設計へ進める。  
3. 「誰が、何を、いつ、どの生成過程で作ったか」を検証可能にするCreator Provenance Protocolを実装する。  
4. caffeinelabs/motokoのOCaml/Dune/Nix/Wasm構成を理解し、issue、documentation、tests、compiler fixへ段階的に貢献する。  
5. 公開情報を「Motoko実装」「ICP上のサービス」「マネタイズ実績」に分け、誇張せず事業判断する。  
**重要な結論**  
オンチェーンのハッシュと時系列は、強い**証拠**になります。しかし、それだけで法的著作者、完全な独創性、人間だけによる制作を証明することはできません。本キットの設計は、次を組み合わせます。  
- principalによる主体識別  
- commit-revealによる先行コミット  
- canonical manifestとcryptographic hash  
- AI利用開示とderivation graph  
- key rotation、delegation、revocation  
- Merkle batchingとcertified response  
- W3C Verifiable Credentials、C2PAとの相互運用  
- オフチェーン原本、再現情報、紛争処理  
**最短の開始手順**  
cd motoko-lab  
 python3 scripts/validate_kit.py  
 ./scripts/bootstrap_toolchain.sh  
 ./scripts/check_all_apps.sh  
 cd apps/01_creator_proof_registry  
 icp network start -d  
 icp deploy  
   
moc、Mops、icp-cliが未導入の場合はbootstrap_toolchain.shが公式のnpmパッケージを導入します。Node.js 22以上を前提にしています。Nixなどglobal npm prefixがread-onlyの環境では、`${XDG_DATA_HOME:-$HOME/.local/share}/motoko-lab/npm`へ自動的にフォールバックし、同梱scriptがそのtoolchainを検出します。  
**収録物**  
全体案内はCONTENTS.md、全ファイル一覧はFILE_INDEX.mdを参照してください。  
| | |  
|-|-|  
| **パス** | **内容** |   
| docs/ | 16週間ロードマップ、本番設計、セキュリティ、運用、事業、証跡プロトコル |   
| apps/ | 6つの独立したMotokoバックエンドプロジェクト |   
| protocol/ | provenance manifest schema、test vectors、off-chain verifier CLI |   
| labs/ | 段階的な演習とcompiler reading lab |   
| compiler/ | Motoko compilerメンテナへの実務ロードマップ |   
| career/ | 12か月計画、成果物scorecard、週次レビュー |   
| github/issues/ | そのままGitHub Issue化できる40件のbacklog |   
| github/ISSUE_TEMPLATE/ | bug、feature、research用Issue Forms |   
| scripts/ | 検証、toolchain導入、全app check、issue dry-run登録 |   
   
**推奨学習順**  
1. docs/00_START_HERE.md  
2. docs/01_16_WEEK_ROADMAP.md  
3. apps/01_creator_proof_registry/README.md  
4. docs/11_CREATOR_PROVENANCE_PROTOCOL.md  
5. docs/04_PRODUCTION_ARCHITECTURE.md  
6. docs/05_SECURITY_THREAT_MODEL.md  
7. compiler/README.md  
8. github/ISSUE_BACKLOG.md  
**バージョン方針**  
このZIPは日付固定のスナップショットです。VERSION_SNAPSHOT.mdに確認したversionと根拠を記録しています。公式ポータルのサンプルversionがrepositoryの最新releaseに遅れる場合があるため、導入前に次を再確認してください。  
- caffeinelabs/motoko Changelog / Releases  
- caffeinelabs/motoko-core README / Mops  
- ICP Developer Docsのicp-cli recipe version  
- Mops toolchain documentation  
**検証状態**  
構造、UTF-8/LF、TOML/JSON、JavaScript、Python、shell、静的整合性に加え、pinned `moc` 1.11.1 / `core` 2.6.0で全6アプリの`mops check`、Motoko test、Wasm build、Candid compatibilityを実行済みです。apps/06_distributed_llmはpocket-ic 14.0.0の実レプリカ上で6キャニスターの配備とinter-canister呼び出しまで確認済みです。apps/01-05のPocketIC、upgrade rehearsal、mainnet deployment、third-party security auditは未実行です。詳細はVALIDATION_STATUS.mdを参照してください。  
**ライセンス**  
本キットの独自コードと文書はApache License 2.0です。リンク先のソフトウェア、仕様、商標は各権利者に帰属します。  
   
   
   
