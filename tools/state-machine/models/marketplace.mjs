// Pure model of `apps/03_license_marketplace` for the state-machine runner.
//
// The state that matters here is money someone believes they paid: which
// payment blocks were spent, which orders are still pending, and how many
// grants each order produced. The issue's acceptance criterion is the last
// one — **one receipt creates at most one grant** — and it is enforced twice:
// `predict` says a second acceptance is a conflict, and `observe` sweeps every
// order to confirm no order ever ends up with two grants.
//
// Only the manual path is modelled (the ledger is an unregistered principal),
// so every "payment" here is a claimed `(ledger, block)` and the canister's
// job is the duplicate suppression this models.

import { Mismatch, eq, expectErr, expectOk, variantOf } from '../framework.mjs';

const BUYERS = ['buyer', 'other'];

function dig(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 37 + i * 5) & 0xff;
  return bytes;
}

function emptyModel(ctx) {
  return {
    ctx,
    nextListingId: 1n,
    nextOrderId: 1n,
    nextGrantId: 1n,
    nextBlock: 1n,
    listings: {},
    orders: {},
    grants: {},
    spentBlocks: {},
    blockList: [],
  };
}

const createListing = {
  name: 'createListing',
  weight: 4,

  generate(model, rng) {
    const supply = rng.pick([null, 1n, 2n]);
    const price = rng.pick([1n, 1_000n, 10n ** 18n]);
    return { seller: 'seller', seed: model.nextListingId, supply, price };
  },

  predict(model, args) {
    const next = structuredClone(model);
    const id = model.nextListingId;
    next.listings[id] = {
      id,
      seller: 'seller',
      sold: 0n,
      active: true,
      supply: args.supply,
      price: args.price,
    };
    next.nextListingId = id + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    const listing = expectOk(observed, 'createListing');
    eq(listing.id, model.nextListingId, 'listing id');
    eq(listing.seller.toText(), model.ctx.principals.seller, 'listing seller');
    eq(listing.sold, 0n, 'fresh listing sold');
    eq(listing.active, true, 'fresh listing active');
    eq(listing.price, args.price, 'listing price');
    return prediction.next;
  },

  run(io, args) {
    return io.actor('seller').createListing({
      proofCanister: io.principal('proof-canister'),
      proofRecordId: BigInt(args.seed),
      artifactHash: dig(Number(args.seed)),
      title: `licence ${args.seed}`,
      termsHash: dig(Number(args.seed) + 50_000),
      termsUri: `ipfs://terms-${args.seed}`,
      price: args.price,
      currencyLedger: io.principal('ledger'),
      supply: args.supply === null ? [] : [args.supply],
    });
  },
};

const setListingActive = {
  name: 'setListingActive',
  weight: 2,

  generate(model, rng) {
    const listings = Object.values(model.listings);
    const roll = rng.int(100);
    if (roll < 10) return { caller: 'seller', listingId: 9999n, active: true, kind: 'unknown' };
    if (listings.length === 0) return null;
    const listing = rng.pick(listings);
    if (roll < 20) return { caller: 'other', listingId: listing.id, active: false, kind: 'notOwner' };
    return { caller: 'seller', listingId: listing.id, active: !listing.active, kind: 'toggle' };
  },

  predict(model, args) {
    if (args.kind === 'unknown') return { result: { kind: 'err', variant: 'notFound' }, next: model };
    const listing = model.listings[args.listingId];
    if (!listing) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (args.caller !== listing.seller) return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    const next = structuredClone(model);
    next.listings[args.listingId] = { ...listing, active: args.active };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `setListingActive(${args.kind})`);
      return prediction.next;
    }
    const listing = expectOk(observed, 'setListingActive');
    eq(listing.id, args.listingId, 'reactivated listing id');
    eq(listing.active, args.active, 'listing active flag');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).setListingActive(args.listingId, args.active);
  },
};

const submitPurchase = {
  name: 'submitPurchase',
  weight: 6,

  generate(model, rng) {
    const listings = Object.values(model.listings);
    const roll = rng.int(100);
    const buyer = rng.pick(BUYERS);
    if (roll < 10 || listings.length === 0) {
      // Unknown listing: refused before the payment is even considered.
      const block = model.nextBlock;
      return { buyer, listingId: 9999n, block, kind: 'unknownListing' };
    }
    const listing = rng.pick(listings);
    const reuse = roll < 35 && model.blockList.length > 0
      && listing.active && (listing.supply === null || listing.sold < listing.supply);
    if (reuse) {
      return { buyer, listingId: listing.id, block: rng.pick(model.blockList), kind: 'replay' };
    }
    return { buyer, listingId: listing.id, block: model.nextBlock, kind: 'fresh' };
  },

  predict(model, args) {
    const listing = model.listings[args.listingId];
    if (!listing) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (!listing.active) return { result: { kind: 'err', variant: 'conflict' }, next: model };
    if (listing.supply !== null && listing.sold >= listing.supply) {
      return { result: { kind: 'err', variant: 'soldOut' }, next: model };
    }
    const key = args.block.toString();
    if (key in model.spentBlocks) return { result: { kind: 'err', variant: 'duplicate' }, next: model };

    const next = structuredClone(model);
    const id = model.nextOrderId;
    next.orders[id] = {
      id,
      listingId: args.listingId,
      buyer: args.buyer,
      block: args.block,
      status: 'paymentSubmitted',
    };
    next.spentBlocks[key] = id;
    next.blockList.push(args.block);
    next.nextOrderId = id + 1n;
    next.nextBlock = args.block + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `submitPurchase(${args.kind})`);
      return prediction.next;
    }
    const order = expectOk(observed, 'submitPurchase');
    eq(order.id, model.nextOrderId, 'order id');
    eq(order.listingId, args.listingId, 'order listing');
    eq(order.buyer.toText(), model.ctx.principals[args.buyer], 'order buyer');
    eq(order.paymentBlock, args.block, 'order payment block');
    eq(variantOf(order.status), 'paymentSubmitted', 'fresh order status');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.buyer).submitPurchase({
      listingId: args.listingId,
      ledger: io.principal('ledger'),
      paymentBlock: args.block,
      receiptHash: dig(Number(args.block) + 100_000),
    });
  },
};

const acceptPurchase = {
  name: 'acceptPurchase',
  weight: 4,

  generate(model, rng) {
    const orders = Object.values(model.orders);
    const roll = rng.int(100);
    if (roll < 10 || orders.length === 0) {
      return { caller: 'seller', orderId: 9999n, kind: 'unknown' };
    }
    const pending = orders.filter((order) => order.status === 'paymentSubmitted');
    if (roll < 20) return { caller: 'other', orderId: (pending[0] ?? orders[0]).id, kind: 'notOwner' };
    if (pending.length > 0 && (roll < 80 || orders.length === 0)) {
      return { caller: 'seller', orderId: rng.pick(pending).id, kind: 'accept' };
    }
    const settled = orders.find((order) => order.status !== 'paymentSubmitted');
    if (settled) return { caller: 'seller', orderId: settled.id, kind: 'notPending' };
    return { caller: 'seller', orderId: rng.pick(pending).id, kind: 'accept' };
  },

  predict(model, args) {
    const order = model.orders[args.orderId];
    if (!order) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    const listing = model.listings[order.listingId];
    if (!listing) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (listing.seller !== args.caller) return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    if (order.status !== 'paymentSubmitted') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    if (listing.supply !== null && listing.sold >= listing.supply) {
      return { result: { kind: 'err', variant: 'soldOut' }, next: model };
    }

    const next = structuredClone(model);
    const grantId = model.nextGrantId;
    next.grants[grantId] = { id: grantId, orderId: order.id, listingId: listing.id };
    next.orders[order.id] = { ...order, status: 'accepted', grantId };
    const sold = listing.sold + 1n;
    const active = listing.supply === null ? listing.active : sold < listing.supply;
    next.listings[listing.id] = { ...listing, sold, active };
    next.nextGrantId = grantId + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `acceptPurchase(${args.kind})`);
      return prediction.next;
    }
    const grant = expectOk(observed, 'acceptPurchase');
    eq(grant.id, model.nextGrantId, 'grant id');
    eq(grant.orderId, args.orderId, 'grant order id');
    eq(grant.listingId, model.orders[args.orderId].listingId, 'grant listing id');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).acceptPurchase(args.orderId);
  },
};

const rejectPurchase = {
  name: 'rejectPurchase',
  weight: 3,

  generate(model, rng) {
    const orders = Object.values(model.orders);
    const roll = rng.int(100);
    if (roll < 10 || orders.length === 0) {
      return { caller: 'seller', orderId: 9999n, reason: 'receipt did not verify', kind: 'unknown' };
    }
    const order = rng.pick(orders);
    if (roll < 20) return { caller: 'seller', orderId: order.id, reason: '', kind: 'emptyReason' };
    if (roll < 30) return { caller: 'other', orderId: order.id, reason: 'receipt did not verify', kind: 'notOwner' };
    if (order.status === 'paymentSubmitted') {
      return { caller: 'seller', orderId: order.id, reason: 'receipt did not verify', kind: 'reject' };
    }
    return { caller: 'seller', orderId: order.id, reason: 'receipt did not verify', kind: 'notPending' };
  },

  predict(model, args) {
    if (args.kind === 'emptyReason') return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    const order = model.orders[args.orderId];
    if (!order) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    const listing = model.listings[order.listingId];
    if (!listing || listing.seller !== args.caller) {
      return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    }
    if (order.status !== 'paymentSubmitted') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    const next = structuredClone(model);
    next.orders[order.id] = { ...order, status: 'rejected' };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `rejectPurchase(${args.kind})`);
      return prediction.next;
    }
    const order = expectOk(observed, 'rejectPurchase');
    eq(order.id, args.orderId, 'rejected order id');
    eq(variantOf(order.status), 'rejected', 'rejected status');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).rejectPurchase(args.orderId, args.reason);
  },
};

export default {
  name: 'marketplace',
  appDir: 'apps/03_license_marketplace',
  canister: {
    name: 'license_marketplace',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  },
  identities: ['seller', 'buyer', 'other', 'ledger', 'proof-canister'],
  advanceChoices: [],
  upgradeWeight: 1,
  commands: { createListing, setListingActive, submitPurchase, acceptPurchase, rejectPurchase },

  generationContext() {
    return {
      principals: {
        seller: 'seller-principal',
        buyer: 'buyer-principal',
        other: 'other-principal',
        ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
        'proof-canister': 'aaaaa-aa',
      },
      canisterId: 'aaaaa-aa',
      baseNs: 0n,
    };
  },

  init(ctx) {
    return emptyModel(ctx);
  },

  async observe(io, model, { full }) {
    const canister = io.canister();
    const stats = await canister.stats();
    eq(stats.listings, BigInt(Object.keys(model.listings).length), 'stats.listings');
    eq(stats.orders, BigInt(Object.keys(model.orders).length), 'stats.orders');
    eq(stats.grants, BigInt(Object.keys(model.grants).length), 'stats.grants');
    if (!full) return;

    // **One receipt creates at most one grant.** Every grant is reached from
    // its order, and no two grants may name the same order. Checked from the
    // canister's side so a lost brokering rule cannot hide behind the model.
    const grantsByOrder = new Map();
    for (const grant of Object.values(model.grants)) {
      const [found] = await canister.getGrant(grant.id);
      if (!found) throw new Mismatch(`grant ${grant.id} is missing from the canister`);
      eq(found.orderId, grant.orderId, `grant ${grant.id} order`);
      const count = (grantsByOrder.get(grant.orderId.toString()) ?? 0) + 1;
      grantsByOrder.set(grant.orderId.toString(), count);
      if (count > 1) throw new Mismatch(`order ${grant.orderId} produced ${count} grants`);
    }
    for (const order of Object.values(model.orders)) {
      const [found] = await canister.getOrder(order.id);
      if (!found) throw new Mismatch(`order ${order.id} is missing from the canister`);
      eq(variantOf(found.status), order.status, `order ${order.id} status`);
      if (order.status === 'accepted') eq(found.status.accepted.grantId, order.grantId, `order ${order.id} grant`);
    }
    for (const listing of Object.values(model.listings)) {
      const [found] = await canister.getListing(listing.id);
      if (!found) throw new Mismatch(`listing ${listing.id} is missing from the canister`);
      eq(found.sold, listing.sold, `listing ${listing.id} sold`);
      eq(found.active, listing.active, `listing ${listing.id} active`);
      if (found.supply.length === 1) {
        if (found.sold > found.supply[0]) throw new Mismatch(`listing ${listing.id} sold more than its supply`);
      }
    }
  },
};
