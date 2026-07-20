# Motoko Language Deep Dive

## 1. Type systemを先に使う

Motokoでは、records、variants、options、generics、structural typingをdomain modelに使います。文字列statusやnull前提の設計を避けます。

```motoko
public type Status = {
  #draft;
  #active;
  #revoked : { at : Nat; reason : Text };
};

public type Result<T> = {
  #ok : T;
  #err : Error;
};
```

### 実務原則

- recoverableな失敗は`Result`
- programmer invariant違反だけtrap候補
- optional dataは`?T`
- lifecycleはvariant
- moneyはFloatでなく最小単位のNat
- principalをTextに変換して認証しない

## 2. Actor model

canisterはprivate stateとpublic async interfaceを持つactorです。同一message内の同期処理は一貫して見えますが、`await`をまたぐと別messageが実行され得ます。

### await前後の規則

- await前に不可逆なstateを書かない、またはstatus machineで中間状態を明示する
- external callはduplicate/retryを想定する
- payment block indexやclient event IDでidempotencyを作る
- external failureをtrapへ変換せず、domain errorへ変換する

## 3. Persistence

新規actorは`persistent actor`を使います。actor bodyの`let`/`var`は原則persistされ、temporary helperやactor referenceは`transient`候補です。

### upgrade rule

- field rename/delete/type changeを軽く扱わない
- public Candid compatibilityとstable signature compatibilityは別々に確認する
- migrationを小さなstepに分ける
- production data copyでrehearsalする

## 4. `mo:core`

新規開発では`base`より`core`を優先します。

- `Map`: ordered B-tree、stable、worst-case O(log n)
- `Iter`: lazy transformationとbounded materialization
- `Principal`: caller、controller、comparison
- `Time`: canister内monotonic、wall-clock accuracyを法的timestampとして過信しない
- `Blob`: compact byte storage、cryptographic hashとは別物

`Blob.hash`はnon-cryptographicです。proof systemのSHA-256代替に使用してはいけません。

## 5. Candid

Candidは実装言語から独立したpublic contractです。

安全な変更の基本:

- response recordへのoptional field追加
- method追加
- variant tag削除を避ける
- numeric narrowingを避ける
- renameでは旧methodをdeprecate期間残す
- generated `.did`をversion controlしdiffする

## 6. Queryとupdate

- query: fast/read-only、inter-canister update call不可、certificationなしなら信頼境界に注意
- update: consensusでstate変更、latency/cyclesが高い
- composite queryやcertified queryは要件を明示して選ぶ

## 7. Data structure選択

| 要件 | 選択 |
|---|---|
| ID順pagination | `Map<Nat, T>` + `entriesFrom` |
| principal lookup | `Map<Principal, T>` |
| hash lookup | `Map<Blob, T>` + cryptographic 32-byte input validation |
| append-only log | monotonic ID + Map |
| bounded recent list | ring buffer or archive canister |
| huge blob | dedicated asset/storage canister; metadata only main registry |

## 8. Review checklist

- anonymous callerを許可する理由があるか
- authorizationがmethodごとに書かれているか
- unbounded array/text/blobを受けていないか
- list APIにlimit capがあるか
- duplicate requestが安全か
- await後にstateを再確認するか
- stable/public interfaceの変更をtestしたか
- errorにsecretやraw keyを含めていないか
