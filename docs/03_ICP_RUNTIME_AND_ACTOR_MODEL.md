# ICP Runtime and Actor Model

## Message execution

update callはmessageとして処理されます。messageが成功するとstate changeがcommitされ、trapするとそのmessageの変更はcommitされません。ただし、既に送信したinter-canister callや、await以前に完了した別messageまで巻き戻るわけではありません。

## Reentrancyの実務的理解

Motoko actorはshared-memory threadのように同時実行されませんが、`await`でcontrolを手放します。再開時にはstateが変わっている可能性があります。

悪い流れ:

1. balanceを確認
2. external transferをawait
3. balanceを減らす

改善:

1. unique operation IDを作る
2. stateを`#pending`にする
3. external call
4. response後にoperation IDとstatusを再確認
5. `#settled`または`#failed`へ遷移

## Time

`Time.now()`はnanosecondsです。canisterから観測するtimeはmonotonicですが、異なるcanister間で同じclockとは限らず、現実時間への厳密一致もformal guaranteeではありません。

証跡systemでは次を分けます。

- network-ordered canister timestamp
- client-declared capture time
- external trusted timestamp token
- block height / certified state root

## Memory

current documentationではstable memoryは最大500 GiBです。しかし、単一canisterへ無制限に集約すべきという意味ではありません。

scale trigger:

- query/update latency上昇
- upgrade/rehearsal時間増大
- hot partition
- cycle burnの偏り
- backup/export window超過
- one-canister blast radius

## Cycles

productionでは、残cyclesをbusiness metricと同じ扱いにします。

- warning threshold
- critical threshold
- automatic top-up owner
- burn rate/day
- forecasted runway
- deployment/updateのreserve

## Controllers

- 個人principal 1つだけをcontrollerにしない
- production/staging/local identityを分離
- emergency controllerと通常deploy identityを分離
- controller変更をaudit logへ残す
- SNS移行はgovernance要件が固まってから行う

## HTTP and frontends

frontend assetをICPでhostすると、content certificationを利用できます。application dataのquery responseも、脅威modelに応じてcertified dataまたはupdate verificationを使います。
