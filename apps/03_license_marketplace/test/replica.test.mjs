// Replica suite for the license marketplace.
//
// This one is about money that has already moved somewhere else. The canister
// never sees a transfer; it sees a claimed `(ledger, paymentBlock)` and must
// make sure the same one cannot be spent twice, that only the seller settles an
// order, and that a grant is issued exactly once. All of that is caller- and
// state-dependent, so none of it is reachable from `moc -r`.
//
//   node tools/pocket-ic/run.mjs 03

import { bigintSafe, buildCanister, digest, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';

export const name = '03_license_marketplace';

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
}
