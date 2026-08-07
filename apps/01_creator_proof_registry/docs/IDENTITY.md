# Creator identity, rotation and delegation

Issue #7. Until now a record's creator *was* the principal that signed it. One
principal, forever, with no way to change it. That makes a lost key a lost body
of work, gives an organization no way to offboard a member without abandoning
everything they registered, and gives a creator no way to say "this assistant
may publish for me, on this project, until March".

## The one decision everything follows from

**A record keeps the principal that signed it, permanently.**

The obvious implementation of rotation is to rewrite old records to point at the
new key. That is falsifying provenance. At the moment of registration, the old
key really was the signer, and a verifier reading a years-old record needs to
see what was true then, not what is true now. A registry that quietly rewrites
its own history is worth less than one that has none.

So rotation *appends* to a key history, and attribution is resolved by reading
that history rather than by trusting a mutable field:

```
Creator 1
  keys[0]  carol   activeFrom 100  retiredAt 500   "registered"
  keys[1]  bob     activeFrom 500  retiredAt null  "scheduled rotation"
  root     bob

Record 12  owner carol            <- unchanged, forever
Attribution 12  creator 1, signer carol, authority #root
```

`Identity.keyAt` answers "which key held this identity at time t". `retiredAt`
is exclusive and `activeFrom` inclusive, so no instant is covered by two keys
and none by zero.

## The model

| | |
|---|---|
| `Creator` | a long-lived identity. The id never changes; the root principal can. |
| `KeyRecord` | one entry per principal that has ever been root, with its window. |
| `Collection` | a project a creator groups records under, and the unit a delegation can be scoped to. |
| `Delegation` | another principal may register under this identity, within a scope, until a deadline, revocably. |
| `RecoveryPolicy` | who may recover this identity, and after how long — declared in advance. |
| `Attribution` | per record: which creator, which signer, under what authority, in which collection. |

Attribution is a side index rather than a field on `ProofRecord`. That keeps
records written before identity existed byte-identical, needs no stable-data
migration, and leaves the certified record digest from #6 untouched. Records
registered by a principal holding no identity simply have no attribution, and
`attribution` returns `null` rather than inventing one.

## Identity is opt-in; being governed by one is not

A principal with no creator and no delegation registers exactly as it did
before any of this existed. That is deliberate — the registry should not require
an identity ceremony to record a proof.

What is *not* optional is that a principal already entangled with an identity
stays governed by it. `resolveAuthority` refuses:

- a **rotated-away key**, which is in the key history but no longer root;
- a **revoked delegate**;
- an **expired delegate**;
- a delegate acting **outside its scope**.

Without that, every one of those principals could simply fall back to
registering as itself, and revocation and rotation would be decorative.

The refusal does not say which of the four applied. A caller probing for
delegations it does not hold should not learn their status from the error.

## Scope

`#all` or `#collection(id)`. A boolean could only express "the whole identity",
which is exactly what an organization delegating one project does not want to
hand over.

A collection-scoped delegate registering **outside any collection** is out of
scope, not in it. Reading `null` as "any collection" would leave the scope for
the delegate to honour, which is the opposite of what a scope is for.

## Expiry

Absolute, in nanoseconds, and mandatory. There is no "never expires": a
delegation nobody has to renew is one nobody remembers to withdraw.

Capped at 365 days from creation. A cap rather than a default, because a
ten-year delegation is indistinguishable from an unbounded one in every way
that matters for offboarding.

Expiry is a deadline, not a status change. An expired delegation still reads as
`#active` — nothing sweeps it — and `authorizes` refuses it on the clock. The
replica suite asserts that, because a reader that treated `#active` as "usable"
would be wrong.

## Recovery cannot silently transfer identity

Three properties, and each of them is load-bearing:

1. **Declared in advance, by the root, while it still holds the key.** A
   recovery path that could be *added* later would be a takeover path: whoever
   compromised the key would name themselves the guardian.
2. **Delayed, minimum seven days.** The delay is what gives the current root
   time to notice a recovery it did not ask for. Both parties can cancel — the
   root because that is the defence, the guardian because a recovery begun by
   mistake should not have to wait out its own delay.
3. **Visible the whole time.** `getRecovery` reports the pending request, who
   asked, and when it becomes effective, from the moment it starts.

The guardian cannot be the key it would recover. A recovery completes by
retiring the old key into the history exactly as a rotation does, so records
signed under it stay attributable.

Recovery targets a principal that has never held an identity. Re-pointing a key
that already belongs to a creator would let one principal answer to two.

## Evidence

`node tools/pocket-ic/run.mjs 01`, pocket-ic 14.0.0. App 01 goes from 66 to 118
checks. Against the acceptance criteria and test plan in #7:

| Case | Check |
|---|---|
| Old records remain attributable after rotation | a record registered before the rotation still names its signer, and still resolves to the creator |
| Revoked delegate cannot create new records | refused with `#unauthorized`; the record it already registered is untouched |
| Delegation scope enforced | refused for another collection, and for no collection |
| Delegation expiry enforced | the clock is advanced past the deadline; the delegation still reads `#active` and authorizes nothing |
| Recovery cannot silently transfer identity | guardian must be pre-declared; delay is enforced; the root cancels one it did not ask for and the identity does not move |
| Expired delegation | `pic.advanceTime` past the deadline |
| Compromised key | rotate away; the retired key can still commit but cannot register |
| Organization member removal | revoke the delegation |
| Concurrent rotations | a second rotation from the retired key is refused — the first moved the identity out from under it |

`test/Identity.test.mo` covers the authorization rules in the interpreter, where
every combination is cheap: the expiry boundary, revoked-beats-unexpired,
expired-beats-active, each scope case, and the key-history windows.

## Candid and stable data

Additive on both sides. `RevealInput` gains an optional `collection`; the
service gains nine methods and the identity types. `ProofRecord` is unchanged,
so the certified digest from #6 is unchanged and no migration is needed. The new
maps are new stable variables, which enhanced orthogonal persistence initializes
empty.

## Still open

- Organization membership as a first-class concept, rather than an
  organization being a creator whose delegates are its members — #27.
- Delegation of anything other than registration. Revocation and rotation are
  still root-only, deliberately: a delegate that could revoke would be a
  delegate that could destroy.
- W3C Verifiable Credentials as the interchange format for delegations — #11.
