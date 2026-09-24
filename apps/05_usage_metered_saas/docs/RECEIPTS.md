# Signed usage receipts and reporter controls

Issue #15. `recordUsage` trusted its caller completely: any principal on the
reporter list could bill any tenant, in any category, any number of units. A
reporter is a metering service, a gateway, a device fleet — the most exposed
part of a billing system — and one compromised reporter could exhaust every
tenant's quota or inflate every invoice.

## Two things to steal instead of one

A signed receipt separates:

- the **reporter principal**, which authenticates the call that submits
  receipts (`submitReceipts` accepts a receipt only from the principal it
  names), and
- a **signing key** registered for that reporter, which signs each receipt
  where the usage is observed — possibly offline, on a device that never talks
  to the IC.

Neither alone is enough. A stolen principal cannot forge a receipt: it has no
device key, and with `requireSignatures` the unsigned `recordUsage` path is
closed to it. A stolen device key cannot submit one: it is not the principal.
Each is revoked on its own — the principal with `setReporter(p, false)`, the key
with `markReporterKeyCompromised` — and a policy bounds what even both together
can do.

## The receipt

```
receipt = domain 0x00 canister reporter keyId tenant units category idempotencyKey observedAt
domain         = "icp-usage-receipt:v1"
canister       = u8 length, principal bytes     ; the metering canister it is for
reporter       = u8 length, principal bytes
keyId          = u64
tenant         = u8 length, principal bytes
units          = u64
category       = u32 length, UTF-8
idempotencyKey = u32 length, UTF-8
observedAt     = u64                            ; nanoseconds, signer's clock
integers are big-endian
signature      = ECDSA P-256 over SHA-256(receipt), r || s, 64 bytes, low-S
```

`canister` is bound so a receipt signed for staging cannot be replayed into
production, and one deployment's reporters cannot bill another's tenants. The
canister publishes its own id and every rule a signer follows in
`receiptSpec()`.

**P-256** because it is what signers actually have: WebCrypto, mobile secure
enclaves, TPMs and cloud HSMs all do P-256, and none of them does it the same
way twice by accident — the layout above is the whole contract.

**Low-S** because every ECDSA signature has a twin, `(r, n - s)`, that verifies
the same message. A registry that accepted both would hold two signatures for
one receipt, and anything deduplicating on signatures would count it twice. The
reference signer (`test/receipt.mjs`) normalizes; the canister refuses the high
form.

That refusal is enforced here, not by the library, and finding that out is what
the pinned high-S vector is for. `mo:ecdsa` rejects high `s` inside `verify`,
but it normalizes `s` to its low form when it *constructs* a `Signature`, so the
check inside `verify` only ever sees normalized values and a high-S signature
verifies. `Receipt.verifySignature` checks the range and the low-S bound on the
values as received, before calling the library.

## What the canister checks, in order

Cheap checks first, the signature once everything cheap has passed:

1. the caller is the receipt's `reporter`, and an enabled reporter — otherwise
   `#unauthorized`, and *not* counted against the named reporter: anyone can
   write any name into a receipt, and a reporter's health should not be
   something a stranger can spoil;
2. `canister` is this canister — `#wrongCanister`;
3. shape: 1 to 1,000,000,000 units, category 1–100 bytes, idempotency key
   1–200 bytes — `#invalidReceipt`;
4. the clock: `observedAt` at most 5 minutes ahead (`#future`) and at most 7
   days old (`#stale`);
5. the key: registered to this reporter (`#unknownKey`) and valid at
   `observedAt` (`#keyNotValid`, below);
6. a replay of an accepted receipt returns `#replayed` with the original event
   and records nothing;
7. the signature — `#badSignature`;
8. the reporter's policy: tenant and category in scope, units within the
   per-event cap (`#outOfScope`), and the window (`#windowExceeded`);
9. the tenant and its quota, exactly as for unsigned usage.

A batch holds up to 16 receipts and each is decided on its own: one bad
signature in an offline batch does not lose the rest.

### Replay

"The same receipt" means the same content. Resubmitting an accepted receipt —
a relay retrying after a dropped response, an offline batch sent twice —
returns the original event and records nothing, without re-verifying the
signature (the content was verified once, and the event is public anyway). A
*different* receipt reusing an idempotency key is `#conflict`, not a replay and
not silently deduplicated: two reports disagreeing about the same usage is a
signal, not noise.

### Clock and skew

Five minutes ahead is generous for NTP and useless for backdating. Seven days
old covers a device offline over a weekend and still lets a billing period
close. A key also cannot have signed anything before it was registered:
`observedAt` must be at or after `addedAt`, which bounds how far back a thief
holding a fresh key can reach.

## Keys

| | |
|---|---|
| `addReporterKey` | controllers only. A reporter that could add its own keys would let a stolen principal mint one. At most 8 active keys per reporter; the key must be a valid P-256 point (33 or 65 bytes), checked at registration rather than discovered when every receipt fails. |
| `retireReporterKey` | rotation. Receipts observed before the retirement still verify, so an offline batch signed before a rotation is not lost to it. |
| `markReporterKeyCompromised` | a controller or the reporter itself — the reporter can only make its key less useful, never more. Nothing signed by a compromised key is accepted any more, whatever time it claims: a thief chooses `observedAt`. Receipts already recorded stay recorded and stay in the audit trail. |

## Policies

`setReporterPolicy(reporter, policy)`, controllers only:

| Field | |
|---|---|
| `tenants` | `#any` or up to 100 tenants |
| `categories` | `#any` or up to 100 categories |
| `maxUnitsPerEvent` | the largest single report |
| `maxUnitsPerWindow`, `windowSeconds` | units per tumbling window across all tenants — the ceiling on what a compromised reporter with a working key can inflate before someone notices, and the number an operator should size this by |
| `requireSignatures` | closes the unsigned `recordUsage` path to this reporter |

The policy applies on **both** paths: a reporter with a policy that uses
`recordUsage` is held to the same scope and window. A reporter without a policy
behaves exactly as before this change — existing integrations keep working —
and should be given one. Controllers are operators, not reporters, and are not
policy-bound.

The window is tumbling rather than rolling so the state per reporter is two
numbers, not a list of every event it ever recorded.

## Observability

`getReporter(reporter)` returns the policy, every key with its status, and the
reporter's health: the current window's units and rejections, lifetime
accepted / replayed / rejected counts, rejections by reason (`badSignatures`,
`outOfScope`, `windowExceeded`), the last rejection and its reason, and an
`anomalous` flag. The flag is raised by three rejections in one window or by
80% of the window limit used — worth a human looking before the limit itself
starts refusing real usage. The reason counts are the signal: a burst of
`badSignature` is someone guessing, a burst of `windowExceeded` is a reporter
billing more than it should.

## Audit export

`exportUsageAudit(start, limit)` returns each usage event with the signed
receipt it came from and the public key that signed it (`null` for events from
the unsigned path). `verifyAuditEntry` in `test/receipt.mjs` re-verifies an
entry with nothing but `node:crypto` and checks the event says what the receipt
says; an auditor can re-check an invoice without trusting this canister.

## Cost

Measured on pocket-ic 14.0.0: verifying one receipt costs about **0.7 billion
cycles**, roughly 1.8 billion instructions at the application-subnet rate,
against about 0.7 million cycles for a replayed one. Almost all of it is the
elliptic-curve arithmetic in `mo:ecdsa`; the IC offers no system call for
verifying an arbitrary P-256 signature. Two consequences:

- `maxBatch` is 16. An update message may use 40 billion instructions, and 16
  receipts is about 28 billion; the suite submits a full batch to prove it fits.
- A receipt should carry aggregated usage — a minute of API calls, not one call.
  At roughly a thousandth of a dollar per verification, one receipt per request
  would cost more than most requests are billed for.

## Test plan

| Case | Where |
|---|---|
| invalid signature rejected | replica: an altered receipt, an unregistered key and a high-S twin are `#badSignature`; interpreter: the pinned vector with each bound field changed |
| replay returns the original event only | replica: resubmission, a duplicate inside one batch, and a replay after an upgrade all return the original event; a different receipt on the same key is `#conflict` |
| reporter cannot write outside scope | replica: another tenant, another category, an oversized event, another deployment's canister; the unsigned path is closed under `requireSignatures` |
| rate anomaly is observable | replica: three bad signatures flag the reporter; a burst stops at exactly the window limit and is counted and named |
| key rotation | replica: the retired key's earlier receipt verifies, its later one does not, the new key works |
| offline batch | replica: receipts signed over three days relayed together, one stale, one duplicated |
| future timestamp | replica and interpreter: ten minutes ahead refused, one minute tolerated, both boundaries exact |
| reporter compromise | replica: a compromised key is refused even for backdated receipts and after an upgrade; a stranger relaying a stolen receipt is refused without touching the reporter's health |

## Compatibility

Candid: new methods and types, all additive; `recordUsage` keeps its signature
and its behaviour for reporters without a policy. Stable data: new maps and a
key counter; `UsageEvent` is unchanged, and the receipt is a side index keyed
by event id, so events recorded before this need no migration. New dependency:
`mo:ecdsa` 8.0.1 (Apache-2.0), with its own `core@2.5.0`, `sha2@0`, `asn1`,
`base-x-encoder`, `xtended-numbers` and `xtended-iter`.
