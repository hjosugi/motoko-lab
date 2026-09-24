// Replica suite for the license marketplace.
//
// This one is about money that has already moved somewhere else. The canister
// never sees a transfer; it sees a claimed `(ledger, paymentBlock)` and must
// make sure the same one cannot be spent twice, that only the seller settles an
// order, and that a grant is issued exactly once. All of that is caller- and
// state-dependent, so none of it is reachable from `moc -r`.
//
// Since #12 a listing whose ledger is registered takes the other path: the
// canister asks the ledger. `payments()` below runs that against
// `test/fixtures/MockLedger.mo`, a local ICRC-1/ICRC-3 ledger, with real
// transfers made by the buyer — and every way a receipt can lie.
//
//   node tools/pocket-ic/run.mjs 03

import { createHash } from 'node:crypto';

import { bigintSafe, buildCanister, digest, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';

export const name = '03_license_marketplace';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/// `Payment.intentMemo`, independently: the value a wallet puts in the memo.
function intentMemo(marketplace, intentId) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64BE(BigInt(intentId));
  return new Uint8Array(createHash('sha256')
    .update('icp-license-intent:v1').update(Buffer.from([0]))
    .update(Buffer.from(marketplace.toUint8Array())).update(Buffer.from([0]))
    .update(id)
    .digest());
}

export async function suite({ appDir, pic, createIdentity, checks: c }) {
  const { wasm, idl } = await buildCanister({
    appDir,
    name: 'license_marketplace',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);

  const deployer = createIdentity('deployer');
  const sender = deployer.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender });
  const actor = fixture.actor;

  const seller = createIdentity('seller');
  const buyer = createIdentity('buyer');
  const other = createIdentity('other');
  // Stand-ins for canisters this app only ever references by principal.
  const ledger = createIdentity('ledger').getPrincipal();
  const otherLedger = createIdentity('other-ledger').getPrincipal();
  const proofCanister = createIdentity('proof-canister').getPrincipal();

  const listingInput = (seed, overrides = {}) => ({
    proofCanister,
    proofRecordId: BigInt(seed),
    artifactHash: digest(seed),
    title: `licence ${seed}`,
    termsHash: digest(seed + 50),
    termsUri: `ipfs://terms-${seed}`,
    price: 1_000n,
    currencyLedger: ledger,
    supply: [],
    ...overrides,
  });

  const purchase = (listingId, block, overrides = {}) => ({
    listingId,
    ledger,
    paymentBlock: BigInt(block),
    receiptHash: digest(block + 200),
    ...overrides,
  });

  // -------------------------------------------------------- anonymous caller
  actor.setPrincipal(null);
  c.expectErr(await actor.createListing(listingInput(1)), 'anonymousNotAllowed',
    'createListing refuses the anonymous principal');
  c.expectErr(await actor.submitPurchase(purchase(1n, 1)), 'anonymousNotAllowed',
    'submitPurchase refuses the anonymous principal');

  // -------------------------------------------------------------- validation
  actor.setIdentity(seller);
  c.expectErr(await actor.createListing(listingInput(1, { price: 0n })),
    'invalidInput', 'a listing cannot be free');
  c.expectErr(await actor.createListing(listingInput(1, { supply: [0n] })),
    'invalidInput', 'a listing cannot have zero supply');
  c.expectErr(await actor.createListing(listingInput(1, { termsHash: new Uint8Array(8) })),
    'invalidInput', 'termsHash must be a 32-byte digest');

  // ---------------------------------------------------------------- listing
  const open = c.expectOk(await actor.createListing(listingInput(1)), 'the seller creates an unlimited listing');
  c.ok(open.seller.toText() === seller.getPrincipal().toText(), 'the listing seller is the caller');
  c.ok(open.sold === 0n && open.active, 'a fresh listing is active with nothing sold');

  // ------------------------------------------------------------- purchasing
  actor.setIdentity(buyer);
  c.expectErr(await actor.submitPurchase(purchase(9999n, 1)), 'notFound', 'buying an unknown listing is notFound');
  c.expectErr(await actor.submitPurchase(purchase(open.id, 1, { ledger: otherLedger })),
    'invalidInput', 'the payment ledger must match the listing');
  c.expectErr(await actor.submitPurchase(purchase(open.id, 1, { receiptHash: new Uint8Array(4) })),
    'invalidInput', 'receiptHash must be a 32-byte digest');

  const order = c.expectOk(await actor.submitPurchase(purchase(open.id, 1)), 'the buyer submits a payment receipt');
  c.ok('paymentSubmitted' in order.status, 'a fresh order is awaiting settlement');

  // The idempotency claim. `(ledger, paymentBlock)` identifies a transfer, so
  // replaying it must not produce a second order — otherwise one payment buys
  // two licences.
  c.expectErr(await actor.submitPurchase(purchase(open.id, 1)),
    'duplicate', 'the same payment block cannot be submitted twice');
  actor.setIdentity(other);
  c.expectErr(await actor.submitPurchase(purchase(open.id, 1)),
    'duplicate', 'not even by a different buyer claiming the same payment');

  // ------------------------------------------------------------- settlement
  c.expectErr(await actor.acceptPurchase(order.id), 'unauthorized', 'a stranger cannot settle the order');
  actor.setIdentity(buyer);
  c.expectErr(await actor.acceptPurchase(order.id), 'unauthorized', 'nor can the buyer settle their own order');

  actor.setIdentity(seller);
  const grant = c.expectOk(await actor.acceptPurchase(order.id), 'the seller accepts the payment');
  c.ok(grant.buyer.toText() === buyer.getPrincipal().toText(), 'the grant names the buyer, not the caller');
  c.ok(grant.price === open.price && grant.termsUri === open.termsUri,
    'the grant copies the terms in force at purchase');

  // A grant is issued once. Accepting again would mint a second licence from
  // one payment.
  c.expectErr(await actor.acceptPurchase(order.id), 'conflict', 'an order cannot be accepted twice');
  c.expectErr(await actor.rejectPurchase(order.id, 'changed my mind'),
    'conflict', 'an accepted order cannot then be rejected');

  const settled = await actor.getOrder(order.id);
  c.ok('accepted' in settled[0].status && settled[0].status.accepted.grantId === grant.id,
    'the order carries the id of the grant it produced');
  c.ok((await actor.getListing(open.id))[0].sold === 1n, 'the listing counts the sale');

  // --------------------------------------------------------------- rejection
  actor.setIdentity(buyer);
  const rejected = c.expectOk(await actor.submitPurchase(purchase(open.id, 2)), 'a second buyer order');
  actor.setIdentity(seller);
  c.expectErr(await actor.rejectPurchase(rejected.id, ''), 'invalidInput', 'rejection needs a reason');
  const done = c.expectOk(await actor.rejectPurchase(rejected.id, 'receipt did not verify'),
    'the seller rejects an order');
  c.ok('rejected' in done.status, 'the order is rejected');
  c.expectErr(await actor.acceptPurchase(rejected.id), 'conflict', 'a rejected order cannot then be accepted');
  c.ok((await actor.getListing(open.id))[0].sold === 1n, 'a rejected order does not count as a sale');

  // ------------------------------------------------------------ supply cap
  const limited = c.expectOk(await actor.createListing(listingInput(2, { supply: [1n] })),
    'the seller creates a single-copy listing');
  actor.setIdentity(buyer);
  const only = c.expectOk(await actor.submitPurchase(purchase(limited.id, 3)), 'the buyer takes the only copy');
  actor.setIdentity(seller);
  c.expectOk(await actor.acceptPurchase(only.id), 'the seller accepts it');
  const closed = await actor.getListing(limited.id);
  c.ok(!closed[0].active && closed[0].sold === 1n, 'the listing closes itself once supply is exhausted');

  actor.setIdentity(buyer);
  c.expectErr(await actor.submitPurchase(purchase(limited.id, 4)),
    'conflict', 'an exhausted listing refuses further purchases');

  // ------------------------------------------------------ seller can pause
  actor.setIdentity(other);
  c.expectErr(await actor.setListingActive(open.id, false), 'unauthorized', 'only the seller can pause a listing');
  actor.setIdentity(seller);
  c.expectOk(await actor.setListingActive(open.id, false), 'the seller pauses the listing');
  actor.setIdentity(buyer);
  c.expectErr(await actor.submitPurchase(purchase(open.id, 5)), 'conflict', 'a paused listing refuses purchases');

  const before = await actor.stats();
  // Three orders were created: accepted, rejected, and the single-copy sale.
  // The refused submissions never became orders, which is the point.
  c.ok(before.listings === 2n && before.orders === 3n && before.grants === 2n, 'stats count each entity');

  // ---------------------------------------------------------------- upgrade
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');
  c.ok((await actor.getGrant(grant.id))[0].buyer.toText() === buyer.getPrincipal().toText(),
    'an issued grant still names its buyer after the upgrade');

  // The receipt index is the anti-double-spend control. If it did not survive,
  // an upgrade would silently re-open every past payment for replay.
  //
  // The listing has to be re-opened first: `submitPurchase` checks the listing
  // is active before it looks at the receipt, so a paused listing would refuse
  // the replay for the wrong reason and the index would go untested.
  actor.setIdentity(seller);
  c.expectOk(await actor.setListingActive(open.id, true), 'the seller re-opens the listing after the upgrade');
  actor.setIdentity(buyer);
  c.expectErr(await actor.submitPurchase(purchase(open.id, 1)), 'duplicate',
    'a payment block used before the upgrade is still refused after it');
  c.expectOk(await actor.submitPurchase(purchase(open.id, 6)),
    'an unused payment block is still accepted after the upgrade');

  await payments({ pic, appDir, actor, fixture, wasm, sender, deployer, seller, buyer, other, listingInput, purchase, c });
}

// ---------------------------------------------------------------- payments

async function payments({ pic, appDir, actor, fixture, wasm, sender, deployer, seller, buyer, other, listingInput, purchase, c }) {
  const mock = await buildCanister({
    appDir,
    name: 'mock_ledger',
    main: 'test/fixtures/MockLedger.mo',
    did: 'test/fixtures/mock_ledger.did',
  });
  const { idlFactory: ledgerIdl } = await import(mock.idl);
  const ledgerFixture = await pic.setupCanister({ idlFactory: ledgerIdl, wasm: mock.wasm, sender });
  const ledger = ledgerFixture.actor;
  const ledgerId = ledgerFixture.canisterId;
  const marketplaceId = fixture.canisterId;
  const account = (identity) => ({ owner: identity.getPrincipal(), subaccount: [] });
  const PRICE = 1_000_000n;
  const FEE = 10_000n;

  // Listed against this ledger before anyone registered it, so it settles by
  // hand. It is here to show a verified block cannot be re-spent through the
  // manual flow either.
  actor.setIdentity(seller);
  const legacyOnLedger = c.expectOk(await actor.createListing(listingInput(9, { currencyLedger: ledgerId, price: PRICE })),
    'a listing on the ledger before it is registered');
  c.ok('manual' in (await actor.getPaymentMode(legacyOnLedger.id))[0], 'settles manually');
  const grantsBefore = (await actor.stats()).grants;

  // --------------------------------------------------------- the allowlist
  c.expectErr(await actor.registerLedger(ledgerId), 'unauthorized', 'only a controller registers a ledger');
  actor.setIdentity(deployer);
  c.expectErr(await actor.registerLedger(marketplaceId), 'ledgerUnavailable',
    'a canister that is not a ledger fails registration instead of trapping');
  const token = c.expectOk(await actor.registerLedger(ledgerId), 'the controller registers the ledger');
  c.ok(token.symbol === 'TKN' && token.decimals === 8 && token.fee === FEE,
    'symbol, decimals and fee are read from the ledger and recorded explicitly');

  // A listing's mode is fixed when it is created: the old ones stay manual.
  actor.setIdentity(seller);
  const verified = c.expectOk(await actor.createListing(listingInput(10, { currencyLedger: ledgerId, price: PRICE })),
    'the seller lists against the registered ledger');
  c.ok('verified' in (await actor.getPaymentMode(verified.id))[0], 'that listing takes ledger-verified payment');
  c.ok('manual' in (await actor.getPaymentMode(1n))[0], 'a listing created before stays manual');

  // The path a forged receipt takes to a grant does not exist here.
  actor.setIdentity(buyer);
  c.expectErr(await actor.submitPurchase(purchase(verified.id, 1000, { ledger: ledgerId })), 'conflict',
    'a verified listing refuses a claimed receipt outright');
  c.expectErr(await actor.openPurchase(1n), 'conflict', 'and a manual listing has no payment intent');

  actor.setPrincipal(null);
  c.expectErr(await actor.openPurchase(verified.id), 'anonymousNotAllowed', 'openPurchase refuses the anonymous principal');
  actor.setIdentity(seller);
  c.expectErr(await actor.openPurchase(verified.id), 'invalidInput', 'the seller cannot buy their own listing');

  // ------------------------------------------------------------- an intent
  actor.setIdentity(buyer);
  const intent = c.expectOk(await actor.openPurchase(verified.id), 'the buyer opens a payment intent');
  c.ok(intent.payTo.owner.toText() === seller.getPrincipal().toText() && intent.amount === PRICE
    && intent.fee === FEE && intent.decimals === 8 && intent.symbol === 'TKN',
    'the intent says who to pay, how much in base units, the decimals, and the fee on top');
  c.ok(Buffer.from(intent.memo).equals(Buffer.from(intentMemo(marketplaceId, intent.id))),
    'the memo is SHA-256 over the marketplace principal and the intent id, reproducible off-chain');
  c.ok('awaitingPayment' in intent.status, 'a fresh intent awaits payment');

  await ledger.mint(account(buyer), 10_000_000n);
  await ledger.mint(account(other), 10_000_000n);
  ledger.setIdentity(buyer);
  const pay = async (overrides = {}) => {
    const result = await ledger.icrc1_transfer({
      from_subaccount: [], to: account(seller), amount: PRICE, fee: [], memo: [intent.memo], created_at_time: [],
      ...overrides,
    });
    if (!('Ok' in result)) throw new Error(`transfer failed: ${JSON.stringify(result, bigintSafe)}`);
    return result.Ok;
  };

  // ---------------------------------------------------- forged receipts
  // Each is a real block on the ledger, presented as payment for this intent.
  // None may create a grant, and none may close the intent: the buyer can
  // still submit the right block afterwards.
  const confirm = (intentId, block) => actor.confirmPayment(intentId, block);
  const reason = (result) => ('err' in result && 'rejected' in result.err ? result.err.rejected : '');

  const toStranger = await pay({ to: account(other) });
  let result = await confirm(intent.id, toStranger);
  c.expectErr(result, 'rejected', 'wrong recipient');
  c.ok(reason(result) === 'the payment went to a different account', 'wrong recipient: the reason says so');

  const short = await pay({ amount: PRICE - FEE });
  result = await confirm(intent.id, short);
  c.expectErr(result, 'rejected', 'underpayment by exactly the fee');
  c.ok(reason(result) === 'the payment is less than the price', 'the fee is on top of the price, not inside it');

  const noMemo = await pay({ memo: [] });
  c.expectErr(await confirm(intent.id, noMemo), 'rejected', 'a payment without the intent memo');

  ledger.setIdentity(other);
  const someoneElses = await pay();
  result = await confirm(intent.id, someoneElses);
  c.expectErr(result, 'rejected', "someone else's payment carrying this intent's memo");
  c.ok(reason(result) === 'the payment was not made by the buyer', 'the payer is checked, not only the memo');
  ledger.setIdentity(buyer);

  const mint = await ledger.mint(account(seller), PRICE);
  result = await confirm(intent.id, mint);
  c.expectErr(result, 'rejected', 'a mint to the seller');
  c.ok(reason(result).startsWith('the block is not a transfer'), 'a mint is not a payment');

  const transferFrom = await ledger.appendBlock({ Map: [
    ['btype', { Text: '2xfer' }], ['ts', { Nat: BigInt(await pic.getTime()) * 1_000_000n }],
    ['tx', { Map: [
      ['from', { Array: [{ Blob: buyer.getPrincipal().toUint8Array() }] }],
      ['to', { Array: [{ Blob: seller.getPrincipal().toUint8Array() }] }],
      ['amt', { Nat: PRICE }], ['memo', { Blob: intent.memo }],
    ] }],
  ] });
  c.expectErr(await confirm(intent.id, transferFrom), 'rejected',
    'an ICRC-2 transfer-from block is not an ICRC-1 payment');
  c.expectErr(await confirm(intent.id, 999_999n), 'rejected', 'a block index the ledger does not have');

  actor.setIdentity(other);
  c.expectErr(await confirm(intent.id, toStranger), 'unauthorized', 'only the buyer confirms their intent');
  actor.setIdentity(buyer);

  const audit = (await actor.getIntent(intent.id))[0];
  c.ok('awaitingPayment' in audit.status && audit.rejections.length === 7,
    'seven rejections are on the record and the intent is still open');
  c.ok((await actor.stats()).grants === grantsBefore, 'no forged receipt created a grant');

  // --------------------------------------------- the ledger cannot be asked
  const paid = await pay();
  await ledger.setAvailable(false);
  result = await confirm(intent.id, paid);
  c.expectErr(result, 'ledgerUnavailable', 'a ledger that rejects the call');
  const untouched = (await actor.getIntent(intent.id))[0];
  c.ok('awaitingPayment' in untouched.status && untouched.rejections.length === 7,
    'a failed ledger call changes nothing: not a rejection, not a payment');
  await ledger.setAvailable(true);

  // ---------------------------------------------------------- the payment
  const grant = c.expectOk(await confirm(intent.id, paid), 'the retry verifies the real payment and issues the grant');
  c.ok(grant.buyer.toText() === buyer.getPrincipal().toText() && grant.listingId === verified.id,
    'the grant names the buyer and the listing');
  const receipt = (await actor.getGrantPayment(grant.id))[0];
  c.ok(receipt.block === paid && receipt.amount === PRICE && receipt.ledger.toText() === ledgerId.toText()
    && receipt.from.owner.toText() === buyer.getPrincipal().toText() && receipt.fee[0] === FEE,
    "the grant carries the ledger's own account of the payment, fee included");
  c.ok((await actor.getGrantPayment(1n)).length === 0, 'a grant settled by the seller has no payment record');
  const order = (await actor.getOrder(grant.orderId))[0];
  c.ok(order.paymentBlock === paid && 'accepted' in order.status, 'the grant has an order, like every grant');

  // "Timeout after success": the grant was issued but the caller never saw
  // the answer, so it asks again. It must get the same grant, and nothing new.
  const again = c.expectOk(await confirm(intent.id, paid), 'confirming the same payment again');
  c.ok(again.id === grant.id && (await actor.stats()).grants === grantsBefore + 1n,
    'returns the same grant and issues no second one');
  c.expectErr(await confirm(intent.id, toStranger), 'conflict', 'a paid intent cannot be re-paid with another block');

  // One payment, one grant: the block cannot pay for anything else.
  const second = c.expectOk(await actor.openPurchase(verified.id), 'the buyer opens a second intent');
  c.expectErr(await confirm(second.id, paid), 'duplicate', 'the block that paid the first intent cannot pay the second');
  c.expectErr(await actor.submitPurchase(purchase(legacyOnLedger.id, 0, { ledger: ledgerId, paymentBlock: paid })),
    'duplicate', 'nor be claimed again through the manual flow of a listing on the same ledger');

  // ------------------------------------------------------------- the clock
  // A payment made before the intent existed is not a payment for it, even with
  // the right memo: memos are predictable, intents are numbered.
  const earlyId = second.id + 1n;
  const early = await pay({ memo: [intentMemo(marketplaceId, earlyId)] });
  await pic.advanceTime(10 * MINUTE_MS);
  await pic.tick();
  const late = c.expectOk(await actor.openPurchase(verified.id), 'an intent opened ten minutes after its payment');
  c.ok(late.id === earlyId, 'the predicted intent id');
  result = await confirm(late.id, early);
  c.ok(reason(result) === 'the payment was made before the intent was opened', 'is rejected as made before the intent');

  await pic.advanceTime(25 * HOUR_MS);
  await pic.tick();
  const expiredPay = await pay({ memo: [late.memo] });
  result = await confirm(late.id, expiredPay);
  c.ok(reason(result) === 'the payment was made after the intent expired', 'a payment after the intent expired is rejected');

  // --------------------------------------------------------------- archives
  const fresh = c.expectOk(await actor.openPurchase(verified.id), 'an intent paid by a block the ledger has archived');
  const archivedBlock = await pay({ memo: [fresh.memo] });
  await ledger.archiveBelow(archivedBlock + 1n);
  c.expectOk(await confirm(fresh.id, archivedBlock), 'is verified through the archive callback');
  await ledger.archiveBelow(0n);

  // -------------------------------------------------- sold out after paying
  actor.setIdentity(seller);
  const single = c.expectOk(await actor.createListing(listingInput(11, { currencyLedger: ledgerId, price: PRICE, supply: [1n] })),
    'a single-copy verified listing');
  actor.setIdentity(buyer);
  const first = c.expectOk(await actor.openPurchase(single.id), 'buyer opens an intent for it');
  actor.setIdentity(other);
  const rival = c.expectOk(await actor.openPurchase(single.id), 'so does a rival');
  ledger.setIdentity(other);
  const rivalPaid = await pay({ memo: [rival.memo] });
  ledger.setIdentity(buyer);
  const firstPaid = await pay({ memo: [first.memo] });
  c.expectOk(await confirm(rival.id, rivalPaid), 'the rival confirms first and takes the copy');
  actor.setIdentity(buyer);
  c.expectErr(await confirm(first.id, firstPaid), 'soldOut', 'the buyer paid, but the copy is gone');
  const owed = (await actor.getIntent(first.id))[0];
  c.ok('paidSoldOut' in owed.status && owed.status.paidSoldOut.block === firstPaid,
    'the intent records a verified payment that is owed a refund');
  c.expectErr(await confirm(first.id, firstPaid), 'soldOut', 'and says so again on retry');
  const stray = c.expectOk(await actor.openPurchase(verified.id), 'another intent');
  c.expectErr(await confirm(stray.id, firstPaid), 'duplicate', 'the consumed block cannot be reused elsewhere');

  // ---------------------------------------------------------------- upgrade
  const before = await actor.stats();
  await upgradeCanister({ pic, canisterId: marketplaceId, wasm, sender });
  c.ok(JSON.stringify(await actor.stats(), bigintSafe) === JSON.stringify(before, bigintSafe),
    'counters survive the upgrade');
  c.ok((await actor.getLedger(ledgerId))[0].fee === FEE, 'the ledger allowlist survives the upgrade');
  c.ok('verified' in (await actor.getPaymentMode(verified.id))[0], 'so does the listing payment mode');
  c.ok((await actor.getGrantPayment(grant.id))[0].block === paid, 'and the payment behind every grant');
  c.ok(c.expectOk(await confirm(intent.id, paid), 'confirming a paid intent after the upgrade').id === grant.id,
    'still returns the original grant');
  c.expectErr(await confirm(second.id, paid), 'duplicate', 'and the consumed block is still refused');
}
