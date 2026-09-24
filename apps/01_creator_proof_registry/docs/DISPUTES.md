# Counterclaims and disputes

Issue #8. Until now the only thing a record could say about itself was
`#revoked`, and only its owner could say it. A third party who believed a record
was wrong — someone else made the work, it existed before the commitment, it is
derived from something it does not list, its AI disclosure is false — had no
way to put that next to the record at all.

## Three rules

**The record is never touched.** A dispute is a side structure keyed by record
id. No dispute endpoint can change a `ProofRecord`, its status, or its certified
digest. What the creator committed to stays exactly what they committed to, and
a reader sees the counterclaim beside it. The replica suite checks that an
upheld counterclaim leaves the record digest byte-identical and still attested
by the subnet.

**Technical status and outcome are different things.** `#active` and
`#revoked` say what the *owner* did. A determination says what a named
authority concluded under its own published policy. The registry records both
and decides neither: it never marks a record false, and it never picks between
two authorities that disagree. A concession by the respondent is a statement,
not an outcome — it does not revoke the record (only `revokeRecord` does) and it
does not close the dispute.

**The state is a function of the log.** Every transition is an event in a
per-dispute hash chain, and a `Dispute` is nothing but `Dispute.apply` folded
over its events. The chain's head is certified. A reader holding an export can
replay the log, check it arrives at the state the canister served, and check
the head against a subnet signature — without trusting the canister, the
gateway, or whoever handed the export over.

## The model

| | |
|---|---|
| `Dispute` | one counterclaim against one record, by one claimant |
| `Ground` | what it asserts: `authorship`, `priorCreation`, `undisclosedDerivation`, `aiDisclosure`, `licensing`, `other` |
| `Evidence` | a 32-byte digest, a `Locator`, a short description |
| `Locator` | `#uri` for public evidence; `#sealed { custodian }` for private evidence |
| `Response` | the respondent's answer: `contest`, `concede` or `partial`, with a statement |
| `Determination` | an authority's `outcome` for a round, with a summary and an optional decision reference |
| `Appeal` | a party's request for another round |
| `DisputeAuthority` | a body whose determinations the registry records, with the policy it determines under |
| `DisputeEvent` | one transition, hash-linked to the previous one |

`counterRecord` lets a claimant point at their own record — the usual shape of
"I registered this first". It is a reference, not a verdict: a reader compares
the two records' commitment times.

## Lifecycle

```
            respond                     determine
  open ─────────────────▶ responded ─────────────────▶ determined ◀─┐
   │ │                        │                          │   │      │ determine
   │ └── determine ───────────┼──────────────────────────┘   │      │ (another authority,
   │     (after respondBy)    │                               │      │  same round)
   │                          │                       appeal │      │
   └── withdraw ──▶ withdrawn ◀── withdraw                    ▼      │
                                                           appealed ─┘
```

| Transition | Who | When |
|---|---|---|
| `fileDispute` | any authenticated principal except the respondent | record is active; limits below |
| `respondToDispute` | the respondent | once, while `#open` |
| `addDisputeEvidence` | claimant or respondent | while unresolved, up to 32 references per dispute |
| `determineDispute` | a registered, unretired authority that is not a party | after an answer or after `respondBy`; once per authority per round |
| `appealDispute` | claimant or respondent | once per side, within 30 days of the round's latest determination |
| `withdrawDispute` | the claimant | before any determination |

**Due process.** Nobody may determine an unanswered dispute while the
respondent's 14-day window is open, and silence does not block the process
forever: after `respondBy` an authority may proceed. Determination is
one-per-authority-per-round, so an authority cannot overwrite itself; a new
round only starts with an appeal.

**Conflicting authorities.** Any registered authority may determine a dispute,
and two may disagree. Both determinations are kept, `disputeSummary` counts the
dispute as `conflicting`, and the verifier says the authorities disagree. The
registry does not rank authorities — which one a reader relies on depends on
the reader's jurisdiction and policy, which is exactly the judgement a registry
is not in a position to make.

**Appeal.** Each side appeals at most once, so "determined" becomes a stable
state. Earlier rounds stay in the dispute and in the log; `Dispute.current` and
the summary look only at the current round.

**Withdrawal.** Only before any determination. Afterwards, the way to stop is
not to appeal; withdrawing then would present a determined dispute as one
nobody decided.

### Who answers for a record

Not simply its owner. A record attributed to a creator identity (#7) is
answered for by that creator's **current root**: the signer may have been a
delegate since revoked, or a key since rotated away, and neither should be able
to speak for the identity any more than it can register for it. A record with
no attribution whose owner later became a creator key follows the same rule
through the key history. Only a record whose owner never entered an identity is
answered for by that owner. The respondent cannot file against its own record;
it has `revokeRecord`.

### Authorities

Registered and retired by the canister's controllers (`addDisputeAuthority`,
`retireDisputeAuthority`). Which bodies may speak is a policy decision for the
operator; this document says so rather than pretending the registry is neutral
about it (#40 is where that power is meant to move). A retired authority keeps
every determination it made and records no new one, and is not reinstated —
reinstating would need `retiredAt` unset, and a history in which it was never
retired is not one that happened.

## Abuse controls

| Control | Limit | What it stops |
|---|---|---|
| anonymous caller | refused | unattributable filings |
| respondent filing against itself | refused | manufacturing a "rejected" counterclaim nobody raised |
| filing rate | 5 per claimant per rolling 24 h | bursts; withdrawing does not give a filing back |
| unresolved per claimant | 10 | one principal keeping many records under a cloud |
| unresolved per record | 20 | burying a record in noise |
| per claimant and record | 1 unresolved | splitting one case into many |
| strikes | 3 `#abusive` findings in 90 days suspend filing | repeat bad-faith filers |
| evidence | 8 per submission, 32 per dispute | unbounded state per dispute |

Refusals for volume return `#rateLimited { retryAt }`, a new result type rather
than a new tag on `Error` (a tag added to a released result type is decoded as
`null` by a client built against the release). Every refusal happens before
anything is written, and the counters only move on success.

`#abusive` is the one outcome that counts against a claimant, and it is kept
apart from `#dismissed`: a claim that was merely weak, out of scope, or
unsupported is not one filed in bad faith.

**What these do not stop.** Every limit is per principal, and principals are
free. A determined campaign with many principals is bounded per record (20
unresolved) but not in total. The control without that weakness is a bond —
a refundable deposit forfeited on an `#abusive` finding — and it needs verified
payments, which is #12, with the economics in #22. The rate limits here are the
controls that work with no payment rail at all.

## Privacy rules

- **Private evidence is a digest and a custodian, never a pointer.**
  `#sealed { custodian }` puts the evidence's SHA-256 on-chain and names who
  holds it; there is no field in which a URI can be left behind by mistake, and
  a custodian containing `://` is refused. Everything in canister state is
  readable by anyone who can query it, so "stored but private" is not an option.
- Statements, summaries and descriptions are public and bounded (2000, 1000 and
  200 characters). Clients should tell users not to put personal data in them;
  the canister cannot tell a name from a noun.
- Principals of claimants, respondents and authorities are public. That is the
  price of accountability for filings, and the reason sealed evidence exists.
- The export contains only what is already on-chain. Filtering sensitive
  pointers out of an export by policy is #19's concern; there are none here to
  filter because sealed references never had one.

## Audit: the event log

Every transition appends an event:

```
event   = domain 0x00 prev dispute seq at by action
domain  = "icp-creator-proof:dispute-event:v1"
prev    = 32 bytes            ; SHA-256 of the previous event, or 32 zero bytes
dispute = u64  seq = u64  at = u64            ; big-endian
by      = u8 length, principal bytes
action  = 0x00 u64:record u8:ground text:statement opt-u64:counterRecord evidence-list
        / 0x01 u8:stance text:statement evidence-list
        / 0x02 u8:party evidence-list
        / 0x03 u8:outcome text:summary opt-evidence:decision u64:round
        / 0x04 u8:party text:statement evidence-list u64:round
        / 0x05 text:reason
evidence-list = u32 count, evidence*
evidence      = 32 bytes digest, (0x00 text:uri / 0x01 text:custodian), text:description
text          = u32 length, UTF-8 bytes
opt-x         = 0x00 / 0x01 x
hash          = SHA-256(event)
```

Tags: ground `authorship`=0 … `other`=5 in the order of the table above; stance
`contest`=0, `concede`=1, `partial`=2; outcome `upheld`=0, `rejected`=1,
`settled`=2, `dismissed`=3, `abusive`=4; party `claimant`=0, `respondent`=1.
Same discipline as `RecordDigest.mo` and `protocol/COMMITMENT_V1.md`, and the
same primitives: a versioned domain separator, fixed-width integers, a length
prefix on every variable-length field, a present-flag on every optional.

The head — the last event's hash — is certified under `["dispute", id]` in the
same tree as the record digests under `["record", id]`. Altering, dropping or
reordering any event changes every hash after it, and the head no longer
matches.

The encoding exists twice on purpose: `backend/src/DisputeLog.mo` and
`test/dispute-log.mjs`, the second written from this grammar. The replica suite
rehashes every event the canister produced with the JavaScript implementation,
and `test/Dispute.test.mo` pins two events' bytes and hashes that the
JavaScript side generated.

## The portable export

`exportDispute(id)` returns a self-contained document:

```
format       "icp-creator-proof:dispute-export:v1"
canister     the registry's principal
record       the ProofRecord the dispute is about
dispute      the served state
events       the full log
authorities  every authority that determined it, retired or not, with its policy
certificate  the subnet certificate
witness      one pruned tree revealing ["record", r] and ["dispute", d]
```

A reader, with nothing but the export and the IC root key (`verifyExport` in
`test/dispute-log.mjs`):

1. recomputes the chain from genesis and obtains the head;
2. replays the events and checks the served `dispute` is exactly that state;
3. verifies the certificate, checks the witness root is the certified data, and
   checks the witness reveals the record's digest and the log head.

An export is a snapshot: one captured months ago still verifies on its own
terms, because its certificate attests the head it had then. What it cannot do
is pass for the current state — paired with a newer certificate, the chain is
intact and the record even matches, and only step 3's head comparison catches
it. The suite has exactly that case.

## What a verifier shows

`disputeSummary(recordId)` counts `total`, `unresolved`, `determined`,
`withdrawn` and `conflicting`. `describe` and `render` in
`test/dispute-log.mjs` are the reference wording:

```
Record 2: active (as set by its owner).
Counterclaim 1 (priorCreation): determined.
The respondent's answer: contest.
Mediation panel recorded "upheld" under https://panel.example/policy.
Arbitration court recorded "rejected" under https://court.example/rules.
The authorities disagree. The registry does not choose between them.
Determinations are statements by the named authorities under their published
policies. This registry records them; it does not decide authorship,
originality or rights, and a dispute never changes the record itself.
```

The suite asserts the rendering attributes every outcome to the authority that
made it, carries the disclaimer, and never calls the record invalid or false or
anyone liable.

## Test plan

| Case | Where |
|---|---|
| false report spam | replica: file-withdraw cycling hits the daily limit with `retryAt`; three `#abusive` findings suspend for the strike window while `#dismissed` does not count; another claimant is unaffected |
| private evidence pointer | interpreter and replica: a sealed reference is a digest and custodian only; a custodian carrying a URI is refused |
| appeal | replica: respondent appeals, round 1 is determined, earlier determinations are kept, each side appeals once, an appeal after 30 days is `#expired` |
| conflicting authorities | interpreter and replica: two authorities disagree, the summary and the rendering report it, one determination per authority per round, a retired authority records nothing new |
| due process | interpreter and replica: no determination inside the response window without an answer; after it, silence does not block |
| respondent identity | replica: the delegate who signed and the rotated-away root cannot answer; the current root can |
| record immutability | replica: record digest byte-identical and still certified after an upheld counterclaim |
| audit | interpreter: dropped, reordered, re-attributed and edited events break the chain; replica: every event rehashed by the JavaScript reader, and tampered exports rejected at the step that should catch them |
| upgrade | replica: an export after the upgrade verifies to the same certified head, a suspension survives, ids continue |

## Compatibility

Candid: fourteen new methods and their types, all additive; no existing type
changed. `check_candid_compat.py` passes drift and subtyping against
`v2026.09.22`. Stable data: new maps and one counter, added to a persistent
actor; nothing existing is migrated, and the certified tree gains a second
label beside `record`, so every record witness issued before this still
verifies against the tree it was issued from.
