# Creator Provenance Thesis

## Thesis

生成AIが大量のcontentを低costで作る時代では、完成物だけから「誰が考え、どこまで人間が関与し、どのsourceから派生したか」を判断することが難しくなります。個人のcreative contributionを守る最後の砦は、中央platformの自己申告だけではなく、複数主体が検証できる来歴の連鎖です。

## ただし、blockchain万能論にしない

on-chain recordが直接証明できること:

- 特定principalが特定hashをnetwork-ordered timeまでに登録した
- recordが後から無断変更されていない
- revocation/derivationの公開履歴
- canister code/module hashとgovernance condition

直接証明できないこと:

- principalの実世界氏名
- 法的著作者性
- contentが盗作でないこと
- 人間だけが作ったこと
- AI disclosureが真実であること
- off-chain fileが将来も取得可能なこと

## Defensible evidence stack

1. identity evidence: wallet、organization credential、recovery/delegation
2. creation evidence: source snapshots、local logs、tool attestations
3. commitment evidence: salted hash before publication
4. derivation evidence: parent graph、license、source disclosure
5. content credential: C2PA manifest or equivalent
6. verifiable credential: trusted organization assertions
7. availability evidence: content-addressed copies and checksums
8. dispute evidence: counterclaims、revocation、adjudication result

## Product position

「著作権を自動判定するblockchain」ではなく、次の表現が正確です。

> A tamper-evident, independently verifiable evidence network for creative provenance.

## Why ICP and Motoko

- actor単位でstate/authorizationを隔離
- persistent actorでupgrade-safe domain modelを短く書ける
- canister内でapplication logicとstateを共同管理
- Candidでlanguage-neutral verifierを作れる
- frontend/assetsとbackendを同じnetwork上に置ける

## Failure of the thesis

次の場合、productは価値を失います。

- verificationが特定websiteだけに依存
- source export不能
- key lossで全recordが無効
- false claimを訂正できない
- canonicalizationが実装ごとに異なる
- privacyを守れない
- creatorが証跡作成を面倒と感じる

したがって、UX、interoperability、recovery、disputeがcryptographyと同じくらい重要です。
