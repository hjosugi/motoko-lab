// An executable model of the tenant sharding design in
// docs/27_TENANT_SHARDING_DESIGN.md (#23).
//
// A design for splitting a registry across canisters is mostly claims about
// what happens when messages arrive in an order nobody chose: two shards
// accepting the same artifact hash, a client holding a route from before a
// move, a shard that stops answering halfway through. Those claims are cheap to
// state and easy to get wrong, so this model makes them executable. It is not a
// canister: every "call" is a synchronous method, and the test drives the
// interleavings — including every permutation of the ones that matter — that an
// asynchronous system would produce.
//
// The pieces mirror the design one to one:
//
//   Router  tenant (and optional collection) -> { shard, epoch, state }
//   Shard   authoritative writes for the tenants it owns at an epoch, and an
//           append-only event log with a per-shard sequence number
//   Index   rebuildable: the global artifact-hash index, built only from
//           shard events, with a high-water mark per shard
//
// Nothing here is authoritative except the shard logs. Everything else can be
// thrown away and rebuilt from them, and the test does exactly that.

import { createHash } from 'node:crypto';

export class Unavailable extends Error {
  constructor(shard) {
    super(`shard ${shard} is unavailable`);
    this.name = 'Unavailable';
  }
}

const routeKey = (tenant, collection) => (collection == null ? tenant : `${tenant}/${collection}`);

/// The ordering that decides a duplicate artifact hash across shards. The
/// provenance question is "who committed first", so the commitment time leads;
/// shard id and commitment id only break exact ties, and do so the same way on
/// every replica of the index whatever order the events arrived in.
export function claimOrder(a, b) {
  if (a.committedAt !== b.committedAt) return a.committedAt < b.committedAt ? -1 : 1;
  if (a.shard !== b.shard) return a.shard < b.shard ? -1 : 1;
  if (a.commitment !== b.commitment) return a.commitment < b.commitment ? -1 : 1;
  return 0;
}

export class Router {
  constructor() {
    this.routes = new Map();
    this.moves = new Map();
  }

  assign(tenant, shard, { collection = null } = {}) {
    const key = routeKey(tenant, collection);
    if (this.routes.has(key)) throw new Error(`${key} is already routed`);
    this.routes.set(key, { shard, epoch: 1, state: 'active' });
  }

  /// A collection partition is routed on its own when present; otherwise the
  /// tenant's route applies. This is how a hot tenant is split without
  /// changing the routing key of anyone else.
  route(tenant, collection = null) {
    return this.routes.get(routeKey(tenant, collection)) ?? this.routes.get(tenant) ?? null;
  }
}

export class Shard {
  constructor(id) {
    this.id = id;
    this.up = true;
    /// routing key -> { epoch, state: 'active' | 'frozen' | 'movedOut', to? }
    this.owned = new Map();
    this.records = new Map();
    this.log = [];
    this.nextCommitment = 1;
  }

  guard() {
    if (!this.up) throw new Unavailable(this.id);
  }

  emit(event) {
    this.log.push({ ...event, shard: this.id, seq: this.log.length + 1 });
  }

  /// Every write names the epoch its route came from. A write under any other
  /// epoch, or for a key this shard no longer owns, is refused with where to
  /// go instead: a stale router costs a retry, never a misplaced record.
  check(key, epoch) {
    const owned = this.owned.get(key);
    if (!owned) return { err: 'notOwned' };
    if (owned.state === 'movedOut') return { err: 'redirect', to: owned.to, epoch: owned.epoch };
    if (owned.epoch !== epoch) return { err: 'staleEpoch', epoch: owned.epoch };
    if (owned.state === 'frozen') return { err: 'moving' };
    return null;
  }

  reveal({ tenant, collection = null, epoch, artifactHash, committedAt, parents = [] }, cluster) {
    this.guard();
    const key = routeKey(tenant, collection);
    const refused = this.check(key, epoch);
    if (refused) return refused;
    // Cross-shard parents are validated synchronously against the shard that
    // owns them: a revoked or unknown parent is refused, and an unreachable
    // one is a retryable refusal — never an unverified acceptance.
    for (const parent of parents) {
      const owner = cluster.shards.get(parent.shard);
      if (!owner || !owner.up) return { err: 'parentUnavailable', retry: true };
      const found = owner.records.get(parent.record);
      if (!found) return { err: 'parentUnknown' };
      if (found.revoked) return { err: 'parentRevoked' };
    }
    const commitment = this.nextCommitment++;
    const id = `${this.id}:${commitment}`;
    const record = { id, key, tenant, artifactHash, committedAt, commitment, revoked: false };
    this.records.set(id, record);
    this.emit({ type: 'revealed', record: id, key, tenant, artifactHash, committedAt, commitment });
    return { ok: record };
  }

  revoke(id, epoch) {
    this.guard();
    const record = this.records.get(id);
    if (!record) return { err: 'notFound' };
    const refused = this.check(record.key, epoch);
    if (refused) return refused;
    record.revoked = true;
    this.emit({ type: 'revoked', record: id, key: record.key });
    return { ok: record };
  }

  /// One page of a key's records, in id order, with a checksum over the page.
  exportPage(key, start, limit) {
    this.guard();
    const all = [...this.records.values()].filter((record) => record.key === key).sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = all.slice(start, start + limit);
    return { page, done: start + page.length >= all.length, checksum: digest(page) };
  }
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class Index {
  constructor() {
    this.claims = new Map();
    this.highWater = new Map();
    this.revoked = new Set();
  }

  /// Applies one shard event. Idempotent — a duplicate delivery is a no-op —
  /// and order-insensitive across shards; within a shard, events must arrive
  /// in sequence, which the high-water mark enforces.
  apply(event) {
    const seen = this.highWater.get(event.shard) ?? 0;
    if (event.seq <= seen) return 'duplicate';
    if (event.seq !== seen + 1) return 'gap';
    this.highWater.set(event.shard, event.seq);
    if (event.type === 'revealed') {
      const list = this.claims.get(event.artifactHash) ?? [];
      list.push({ record: event.record, shard: event.shard, committedAt: event.committedAt, commitment: event.commitment });
      list.sort(claimOrder);
      this.claims.set(event.artifactHash, list);
    } else if (event.type === 'revoked') {
      this.revoked.add(event.record);
    }
    return 'applied';
  }

  /// The record that holds an artifact hash, and every later claim beside it.
  /// Later claims are not deleted — a provenance registry does not unwrite —
  /// they are reported as duplicates of the earliest commitment.
  lookup(artifactHash) {
    const list = this.claims.get(artifactHash) ?? [];
    if (!list.length) return null;
    return { holder: list[0].record, duplicates: list.slice(1).map((claim) => claim.record) };
  }

  snapshot() {
    return {
      claims: [...this.claims.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      highWater: [...this.highWater.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      revoked: [...this.revoked].sort(),
    };
  }

  static rebuild(shards) {
    const index = new Index();
    for (const shard of shards) for (const event of shard.log) index.apply(event);
    return index;
  }
}

export class Cluster {
  constructor(shardIds) {
    this.router = new Router();
    this.shards = new Map(shardIds.map((id) => [id, new Shard(id)]));
  }

  onboard(tenant, shard, options = {}) {
    this.router.assign(tenant, shard, options);
    const key = routeKey(tenant, options.collection ?? null);
    this.shards.get(shard).owned.set(key, { epoch: 1, state: 'active' });
  }

  /// Moves a routing key between shards in resumable steps. Each step is
  /// idempotent and recorded, so a move interrupted anywhere is finished by
  /// running it again; `stopAfter` lets the test interrupt it.
  move(key, to, { stopAfter = null, pageSize = 2 } = {}) {
    const route = this.router.routes.get(key);
    const from = route.shard;
    const move = this.router.moves.get(key) ?? { from, to, epoch: route.epoch + 1, step: 0, copied: 0, checksums: [] };
    this.router.moves.set(key, move);
    const source = this.shards.get(move.from);
    const target = this.shards.get(move.to);
    const steps = [
      () => {
        route.state = 'moving';
        source.owned.set(key, { ...source.owned.get(key), state: 'frozen' });
      },
      () => {
        for (;;) {
          const { page, done, checksum } = source.exportPage(key, move.copied, pageSize);
          if (digest(page) !== checksum) throw new Error('corrupted page');
          for (const record of page) target.records.set(record.id, { ...record });
          move.copied += page.length;
          move.checksums.push(checksum);
          if (done) break;
        }
      },
      () => {
        const moved = [...target.records.values()].filter((record) => record.key === key);
        const original = [...source.records.values()].filter((record) => record.key === key);
        if (digest(moved.sort(byId)) !== digest(original.sort(byId))) throw new Error('copy does not match source');
        target.owned.set(key, { epoch: move.epoch, state: 'active' });
      },
      () => {
        this.router.routes.set(key, { shard: move.to, epoch: move.epoch, state: 'active' });
        source.owned.set(key, { epoch: move.epoch, state: 'movedOut', to: move.to });
        target.emit({ type: 'movedIn', key, from: move.from, records: move.copied });
        this.router.moves.delete(key);
      },
    ];
    while (move.step < steps.length) {
      steps[move.step]();
      move.step += 1;
      if (stopAfter !== null && move.step >= stopAfter && move.step < steps.length) return 'interrupted';
    }
    return 'done';
  }
}

const byId = (a, b) => (a.id < b.id ? -1 : 1);

/// A client with a cached route. It follows redirects and stale-epoch answers
/// by asking the router again, a bounded number of times.
export class Client {
  constructor(cluster) {
    this.cluster = cluster;
    this.cache = new Map();
    this.refreshes = 0;
  }

  routeFor(tenant, collection) {
    const key = routeKey(tenant, collection);
    if (!this.cache.has(key)) this.cache.set(key, { ...this.cluster.router.route(tenant, collection) });
    return this.cache.get(key);
  }

  reveal(args) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const route = this.routeFor(args.tenant, args.collection ?? null);
      const result = this.cluster.shards.get(route.shard).reveal({ ...args, epoch: route.epoch }, this.cluster);
      if (result.err === 'redirect' || result.err === 'staleEpoch' || result.err === 'notOwned') {
        this.cache.delete(routeKey(args.tenant, args.collection ?? null));
        this.refreshes += 1;
        continue;
      }
      return result;
    }
    return { err: 'routeUnresolved' };
  }
}

/// Every ordering of `items`, for the interleavings that matter.
export function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

/// A seeded shuffle, so a failing interleaving can be replayed exactly.
export function shuffle(items, seed) {
  const out = items.slice();
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
