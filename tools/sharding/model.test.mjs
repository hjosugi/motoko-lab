#!/usr/bin/env node
// The claims of docs/27_TENANT_SHARDING_DESIGN.md, checked against the model.
//
//   node tools/sharding/model.test.mjs
//
// Offline, dependency-free, deterministic: every interleaving is either
// enumerated or drawn from a fixed seed, so a failure names an ordering that
// can be replayed.

import { claimOrder, Client, Cluster, digest, Index, permutations, shuffle, Unavailable } from './model.mjs';

let checks = 0;
function ok(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

/// Interleaves per-shard logs in a seeded random order that keeps each shard's
/// own order — what an index subscriber sees from independent canisters.
function interleave(shards, seed) {
  const queues = shards.map((shard) => shard.log.slice());
  const out = [];
  let turn = seed;
  while (queues.some((queue) => queue.length)) {
    const live = queues.filter((queue) => queue.length);
    turn = (turn * 1103515245 + 12345) >>> 0;
    out.push(live[turn % live.length].shift());
  }
  return out;
}

// ------------------------------------------- the duplicate global hash race
{
  const cluster = new Cluster(['s1', 's2', 's3']);
  cluster.onboard('alice', 's1');
  cluster.onboard('bob', 's2');
  cluster.onboard('carol', 's3');
  const client = new Client(cluster);
  // Three tenants on three shards reveal the same artifact. Each shard accepts:
  // none of them can see the others synchronously, and refusing would need a
  // cross-canister lock on every reveal.
  client.reveal({ tenant: 'bob', artifactHash: 'H', committedAt: 200 });
  client.reveal({ tenant: 'alice', artifactHash: 'H', committedAt: 100 });
  client.reveal({ tenant: 'carol', artifactHash: 'H', committedAt: 100 });
  const events = [...cluster.shards.values()].flatMap((shard) => shard.log);
  const outcomes = new Set();
  for (const order of permutations(events)) {
    const index = new Index();
    for (const event of order) index.apply(event);
    outcomes.add(JSON.stringify(index.lookup('H')));
  }
  ok(outcomes.size === 1, 'all 6 delivery orders of a three-way duplicate give the index the same answer');
  const answer = JSON.parse([...outcomes][0]);
  ok(answer.holder === 's1:1', 'the earliest commitment holds the hash, whichever shard reported first');
  ok(answer.duplicates.join() === 's3:1,s2:1',
    'an exact tie on commitment time is broken by shard id, and the later claim is kept as a duplicate, not deleted');
  ok(claimOrder({ committedAt: 1, shard: 'b', commitment: 9 }, { committedAt: 2, shard: 'a', commitment: 1 }) < 0,
    'commitment time outranks shard and commitment id');
}

// ------------------------------------------------ the index rebuilds from events
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  cluster.onboard('bob', 's2');
  const client = new Client(cluster);
  const records = [];
  for (let i = 0; i < 12; i += 1) {
    const tenant = i % 2 ? 'alice' : 'bob';
    records.push(client.reveal({ tenant, artifactHash: `H${i % 5}`, committedAt: 1000 - i }).ok);
  }
  const route = (tenant) => cluster.router.route(tenant);
  cluster.shards.get(records[3].id.split(':')[0]).revoke(records[3].id, route(records[3].tenant).epoch);
  const reference = Index.rebuild([...cluster.shards.values()]).snapshot();
  let identical = 0;
  for (let seed = 1; seed <= 50; seed += 1) {
    const index = new Index();
    for (const event of interleave([...cluster.shards.values()], seed)) index.apply(event);
    // Duplicate delivery on top, in a different order again.
    for (const event of shuffle([...cluster.shards.values()].flatMap((shard) => shard.log), seed)) index.apply(event);
    if (digest(index.snapshot()) === digest(reference)) identical += 1;
  }
  ok(identical === 50, 'the index built from 50 interleavings with duplicate delivery equals one rebuilt from the logs');
  const index = new Index();
  const first = cluster.shards.get('s1').log;
  ok(index.apply(first[1]) === 'gap' && index.apply(first[0]) === 'applied' && index.apply(first[0]) === 'duplicate',
    'a gap in a shard\'s sequence is refused, and a redelivered event is a no-op');
  ok(reference.highWater.every(([, seq]) => seq > 0), 'the index reports how far it has read each shard');
}

// -------------------------------------------------------- stale router
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  const stale = new Client(cluster);
  stale.reveal({ tenant: 'alice', artifactHash: 'A1', committedAt: 1 });
  ok(cluster.move('alice', 's2') === 'done', 'alice moves from s1 to s2');
  const result = stale.reveal({ tenant: 'alice', artifactHash: 'A2', committedAt: 2 });
  ok(result.ok && result.ok.id.startsWith('s2:') && stale.refreshes === 1,
    'a client with a pre-move route is redirected once and its write lands on the new shard');
  const direct = cluster.shards.get('s1').reveal({ tenant: 'alice', epoch: 1, artifactHash: 'A3', committedAt: 3 }, cluster);
  ok(direct.err === 'redirect' && direct.to === 's2' && direct.epoch === 2,
    'the old shard refuses a write for a moved tenant and says where it went');
  ok([...cluster.shards.get('s1').records.values()].every((record) => record.artifactHash !== 'A2'),
    'nothing is written to the old shard after the move');
}

// ------------------------------------------------ an interrupted move resumes
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  const client = new Client(cluster);
  for (let i = 0; i < 5; i += 1) client.reveal({ tenant: 'alice', artifactHash: `M${i}`, committedAt: i });
  const before = digest([...cluster.shards.get('s1').records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
  ok(cluster.move('alice', 's2', { stopAfter: 2 }) === 'interrupted', 'a move is interrupted after the copy');
  const during = client.reveal({ tenant: 'alice', artifactHash: 'M9', committedAt: 9 });
  ok(during.err === 'moving', 'writes during a move are refused as retryable, not lost or split between shards');
  ok(cluster.move('alice', 's2') === 'done', 'running the move again finishes it');
  const after = digest([...cluster.shards.get('s2').records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
  ok(after === before, 'the moved records are identical, by content hash, to the source');
  ok(cluster.router.moves.size === 0 && cluster.router.route('alice').shard === 's2', 'no move is left pending and the route points at the new shard');
  ok(client.reveal({ tenant: 'alice', artifactHash: 'M9', committedAt: 9 }).ok, 'the retried write succeeds on the new shard');
}

// ------------------------------------------------------ shard unavailable
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  cluster.onboard('bob', 's2');
  const client = new Client(cluster);
  client.reveal({ tenant: 'alice', artifactHash: 'U1', committedAt: 1 });
  cluster.shards.get('s1').up = false;
  let thrown = null;
  try {
    client.reveal({ tenant: 'alice', artifactHash: 'U2', committedAt: 2 });
  } catch (error) {
    thrown = error;
  }
  ok(thrown instanceof Unavailable, 'a write to a tenant on an unavailable shard fails outright');
  ok(client.reveal({ tenant: 'bob', artifactHash: 'U3', committedAt: 3 }).ok, 'tenants on other shards are unaffected');
  const index = Index.rebuild([cluster.shards.get('s2')]);
  ok(index.lookup('U3') && !index.highWater.has('s1'),
    'the index keeps serving, and its high-water marks say which shard it has not heard from');
  cluster.shards.get('s1').up = true;
  ok([...cluster.shards.get('s1').records.values()].length === 1, 'nothing was half-applied while it was down');
}

// ------------------------------------------------------------ hot tenant
{
  const cluster = new Cluster(['s1', 's2', 's3']);
  cluster.onboard('studio', 's1');
  // Two collections of one very busy tenant get routes of their own.
  cluster.onboard('studio', 's2', { collection: 'films' });
  cluster.onboard('studio', 's3', { collection: 'games' });
  const client = new Client(cluster);
  for (let i = 0; i < 30; i += 1) {
    const collection = [null, 'films', 'games'][i % 3];
    ok(client.reveal({ tenant: 'studio', collection, artifactHash: `T${i}`, committedAt: i }).ok, `studio write ${i + 1}`);
  }
  const loads = [...cluster.shards.values()].map((shard) => shard.records.size);
  ok(loads.join() === '10,10,10', 'a hot tenant split by collection spreads over three shards');
  ok(cluster.router.route('studio', 'music').shard === 's1', 'a collection without a route of its own uses the tenant\'s');
}

// ----------------------------------------------------- cross-shard parent
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  cluster.onboard('bob', 's2');
  const client = new Client(cluster);
  const parent = client.reveal({ tenant: 'alice', artifactHash: 'P', committedAt: 1 }).ok;
  const ref = { shard: 's1', record: parent.id };
  ok(client.reveal({ tenant: 'bob', artifactHash: 'C1', committedAt: 2, parents: [ref] }).ok,
    'a record may derive from a record on another shard, checked against that shard');
  ok(client.reveal({ tenant: 'bob', artifactHash: 'C2', committedAt: 3, parents: [{ shard: 's1', record: 's1:99' }] }).err === 'parentUnknown',
    'an unknown cross-shard parent is refused');
  cluster.shards.get('s1').up = false;
  const unreachable = client.reveal({ tenant: 'bob', artifactHash: 'C3', committedAt: 4, parents: [ref] });
  ok(unreachable.err === 'parentUnavailable' && unreachable.retry,
    'an unreachable parent shard is a retryable refusal, never an unverified acceptance');
  cluster.shards.get('s1').up = true;
  cluster.shards.get('s1').revoke(parent.id, cluster.router.route('alice').epoch);
  ok(client.reveal({ tenant: 'bob', artifactHash: 'C4', committedAt: 5, parents: [ref] }).err === 'parentRevoked',
    'a revoked cross-shard parent is refused, as it is on one canister');
}

// ------------------------------------------------- tenant export and billing
{
  const cluster = new Cluster(['s1', 's2']);
  cluster.onboard('alice', 's1');
  cluster.onboard('bob', 's1');
  const client = new Client(cluster);
  for (let i = 0; i < 7; i += 1) client.reveal({ tenant: i % 2 ? 'alice' : 'bob', artifactHash: `E${i}`, committedAt: i });
  cluster.move('alice', 's2');
  client.reveal({ tenant: 'alice', artifactHash: 'E9', committedAt: 9 });
  const pages = [];
  for (let start = 0; ; ) {
    const { page, done, checksum } = cluster.shards.get('s2').exportPage('alice', start, 2);
    ok(digest(page) === checksum, `export page at ${start} carries a checksum that matches`);
    pages.push(...page);
    start += page.length;
    if (done) break;
  }
  ok(pages.length === 4 && pages.every((record) => record.tenant === 'alice'),
    'a tenant\'s export comes from one shard and holds all of its records, moved and new');
  ok(cluster.shards.get('s2').log.some((event) => event.type === 'movedIn' && event.records === 3),
    'the move itself is an event, so billing and audit can see when a tenant changed shard');
}

console.log(`\nsharding model: ${checks} checks passed`);
