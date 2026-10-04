// Pure model of `apps/05_usage_metered_saas` for the state-machine runner.
//
// The metering rules are the canister's product promise: units are refused
// rather than truncated, an idempotency key returns the original event, the
// window is the plan's period, and a disabled tenant accepts nothing. The
// issue's acceptance criterion is **usage never exceeds quota**; `observe`
// checks the tenant from the canister after every step and again in a full
// sweep, with the boundary Nat values (0, an exact fill, 1e9, 1e9 + 1) drawn
// by the generator rather than written as one-off cases.
//
// Only the unsigned `recordUsage` path is modelled. Signed receipts add a
// signature, a policy and a reporter-health machine of their own; they are
// covered by the app's replica suite and by issue #18's scope boundary
// ("registry, marketplace, bounty, and metering" is about the state machine).

import { Mismatch, eq, expectErr, expectOk } from '../framework.mjs';

const HOUR_MS = 3_600_000;
const PLANS = {
  tenant: { name: 'starter', quota: 100n, periodSeconds: 3_600n, priceMinorUnits: 900n, currency: 'USD' },
  'other-tenant': { name: 'metered', quota: 2_000_000_000n, periodSeconds: 3_600n, priceMinorUnits: 900n, currency: 'USD' },
};

function emptyModel(ctx) {
  return {
    ctx,
    nextEventId: 1n,
    tenants: {},
    events: {},
    keyIndex: {},
    reporters: {},
    elapsedMs: 0,
  };
}

const nowNs = (model) => model.ctx.baseNs + BigInt(model.elapsedMs) * 1_000_000n;
const scopedKey = (tenant, key) => `${tenant}:${key}`;

/// The canister rolls an ended period inside `record`, before it looks at the
/// enabled flag, the idempotency index or the quota. The model does the same,
/// and keeps the rolled tenant even when the event is then refused.
function rollTenant(model, tenant) {
  const length = tenant.plan.periodSeconds * 1_000_000_000n;
  const now = nowNs(model);
  if (now < tenant.periodStartedAt + length) return tenant;
  const whole = (now - tenant.periodStartedAt) / length;
  return { ...tenant, used: 0n, periodStartedAt: tenant.periodStartedAt + whole * length };
}

const createTenant = {
  name: 'createTenant',
  weight: 2,

  generate(model, rng) {
    const target = rng.pick(['tenant', 'other-tenant']);
    // A tenant principal is created once. When the target already exists the
    // only reachable path is the duplicate refusal; there is nothing to create.
    if (target in model.tenants) {
      if (rng.int(100) < 15) return { target, kind: 'duplicate' };
      return null;
    }
    return { target, kind: 'create' };
  },

  predict(model, args) {
    if (args.kind === 'duplicate') return { result: { kind: 'err', variant: 'duplicate' }, next: model };
    const next = structuredClone(model);
    next.tenants[args.target] = {
      plan: PLANS[args.target],
      used: 0n,
      periodStartedAt: nowNs(model),
      enabled: true,
    };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `createTenant(${args.kind})`);
      return prediction.next;
    }
    const tenant = expectOk(observed, 'createTenant');
    eq(tenant.principal.toText(), model.ctx.principals[args.target], 'tenant principal');
    eq(tenant.used, 0n, 'fresh tenant used');
    eq(tenant.enabled, true, 'fresh tenant enabled');
    eq(tenant.plan.quota, PLANS[args.target].quota, 'tenant plan quota');
    return prediction.next;
  },

  run(io, args) {
    return io.actor('admin').createTenant({
      principal: io.principal(args.target),
      displayName: args.target,
      plan: PLANS[args.target],
    });
  },
};

const setReporter = {
  name: 'setReporter',
  weight: 1,

  generate(model, rng) {
    const target = rng.pick(['reporter', 'stranger']);
    const enabled = rng.chance(0.7);
    if (rng.int(100) < 10) return { caller: 'tenant', target, enabled, kind: 'notAdmin' };
    return { caller: 'admin', target, enabled, kind: 'set' };
  },

  predict(model, args) {
    if (args.kind === 'notAdmin') return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    const next = structuredClone(model);
    next.reporters[args.target] = args.enabled;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `setReporter(${args.kind})`);
      return prediction.next;
    }
    eq(expectOk(observed, 'setReporter'), args.enabled, 'setReporter result');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).setReporter(io.principal(args.target), args.enabled);
  },
};

const setTenantEnabled = {
  name: 'setTenantEnabled',
  weight: 1,

  generate(model, rng) {
    const known = Object.keys(model.tenants);
    const roll = rng.int(100);
    if (roll < 10 || known.length === 0) return { caller: 'admin', target: 'ghost', enabled: true, kind: 'unknown' };
    const target = rng.pick(known);
    if (roll < 20) return { caller: 'tenant', target, enabled: false, kind: 'notAdmin' };
    return { caller: 'admin', target, enabled: !model.tenants[target].enabled, kind: 'toggle' };
  },

  predict(model, args) {
    if (args.kind === 'unknown') return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (args.kind === 'notAdmin') return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    if (!(args.target in model.tenants)) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    const next = structuredClone(model);
    next.tenants[args.target] = { ...next.tenants[args.target], enabled: args.enabled };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `setTenantEnabled(${args.kind})`);
      return prediction.next;
    }
    const tenant = expectOk(observed, 'setTenantEnabled');
    eq(tenant.enabled, args.enabled, 'tenant enabled flag');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).setTenantEnabled(io.principal(args.target), args.enabled);
  },
};

const recordUsage = {
  name: 'recordUsage',
  weight: 7,

  generate(model, rng, index) {
    const known = Object.keys(model.tenants);
    const target = rng.int(100) < 10 || known.length === 0 ? 'ghost' : rng.pick(known);
    // Units are drawn from the boundaries that decide the outcome, against
    // the state the call will actually find (after any period roll).
    const tenant = known.includes(target) ? rollTenant(model, model.tenants[target]) : null;
    const remaining = tenant ? tenant.plan.quota - tenant.used : 0n;
    const boundaries = [0n, 1n, 5n, remaining > 0n ? remaining : 1n, remaining + 1n, 1_000_000_000n, 1_000_000_001n];
    const pickUnits = () => rng.pick(boundaries);
    if (rng.int(100) < 20) {
      const existing = Object.values(model.events).filter((event) => event.tenant === target);
      if (existing.length > 0) {
        const event = rng.pick(existing);
        // The unsigned path does not compare units on a replay: any valid
        // amount returns the original event.
        return { caller: 'reporter', target, units: rng.pick([1n, 5n]), key: event.key, kind: 'replay' };
      }
    }
    return { caller: 'reporter', target, units: pickUnits(), key: `k-${index}-${rng.int(1 << 20)}`, kind: 'fresh' };
  },

  predict(model, args) {
    // The canister's order is the reporter gate first, then the amount, then
    // the tenant. A refused amount is therefore only `invalidInput` when the
    // caller is an enabled reporter at all.
    if (model.reporters.reporter !== true) {
      return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    }
    if (args.units === 0n || args.units > 1_000_000_000n) {
      return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    }
    if (!(args.target in model.tenants)) {
      return { result: { kind: 'err', variant: 'notFound' }, next: model };
    }
    let next = structuredClone(model);
    const rolled = rollTenant(next, next.tenants[args.target]);
    next.tenants[args.target] = rolled;

    // The canister checks the enabled flag before the idempotency index, so a
    // replay against a disabled tenant is a conflict, not the original event.
    if (!rolled.enabled) {
      return { result: { kind: 'err', variant: 'conflict' }, next };
    }
    const key = scopedKey(args.target, args.key);
    if (key in next.keyIndex) {
      const existingId = next.keyIndex[key];
      return { result: { kind: 'ok', existing: true }, next, event: next.events[existingId] };
    }
    if (rolled.used + args.units > rolled.plan.quota) {
      return {
        result: { kind: 'err', variant: 'quotaExceeded' },
        next,
        detail: { quota: rolled.plan.quota, used: rolled.used, requested: args.units },
      };
    }
    const id = next.nextEventId;
    const event = { id, tenant: args.target, units: args.units, key: args.key };
    next.events[id] = event;
    next.keyIndex[key] = id;
    next.tenants[args.target] = { ...rolled, used: rolled.used + args.units };
    next.nextEventId = id + 1n;
    return { result: { kind: 'ok' }, next, event };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      const detail = expectErr(observed, prediction.result.variant, `recordUsage(${args.kind})`);
      if (prediction.result.variant === 'quotaExceeded') {
        eq(detail.quota, prediction.detail.quota, 'quotaExceeded quota');
        eq(detail.used, prediction.detail.used, 'quotaExceeded used');
        eq(detail.requested, prediction.detail.requested, 'quotaExceeded requested');
      }
      return prediction.next;
    }
    const event = expectOk(observed, 'recordUsage');
    eq(event.id, prediction.event.id, 'usage event id');
    eq(event.units, prediction.event.units, 'usage event units');
    eq(event.tenant.toText(), model.ctx.principals[args.target], 'usage event tenant');
    eq(event.idempotencyKey, prediction.event.key, 'usage event idempotency key');
    return prediction.next;
  },

  run(io, args) {
    return io.actor('reporter').recordUsage({
      tenant: io.principal(args.target),
      units: args.units,
      category: 'api-call',
      idempotencyKey: args.key,
    });
  },
};

export default {
  name: 'metering',
  appDir: 'apps/05_usage_metered_saas',
  canister: {
    name: 'usage_metered_saas',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  },
  identities: ['admin', 'tenant', 'other-tenant', 'reporter', 'stranger', 'ghost'],
  /// This canister's admin gate is `Principal.isController`, so the identity
  /// the canister is installed under has to be the one the model calls admin.
  controller: 'admin',
  advanceChoices: [30 * 60 * 1000, 2 * HOUR_MS],
  advanceWeight: 3,
  upgradeWeight: 1,
  commands: { createTenant, setReporter, setTenantEnabled, recordUsage },

  generationContext() {
    return {
      principals: {
        admin: 'admin-principal',
        tenant: 'tenant-principal',
        'other-tenant': 'other-tenant-principal',
        reporter: 'reporter-principal',
        stranger: 'stranger-principal',
        ghost: 'ghost-principal',
      },
      canisterId: 'aaaaa-aa',
      baseNs: 0n,
    };
  },

  init(ctx) {
    return emptyModel(ctx);
  },

  afterAdvance(model, ms) {
    const next = structuredClone(model);
    next.elapsedMs += ms;
    return next;
  },

  async observe(io, model, { full }) {
    const canister = io.canister();
    const stats = await canister.stats();
    eq(stats.tenants, BigInt(Object.keys(model.tenants).length), 'stats.tenants');
    eq(stats.reporters, BigInt(Object.keys(model.reporters).length), 'stats.reporters');
    eq(stats.usageEvents, BigInt(Object.keys(model.events).length), 'stats.usageEvents');

    // **Usage never exceeds quota**, checked against the canister itself after
    // every step, not only where the model predicted a refusal.
    for (const [name, tenant] of Object.entries(model.tenants)) {
      const [found] = await canister.getTenant(io.principal(name));
      if (!found) throw new Mismatch(`tenant ${name} is missing from the canister`);
      eq(found.used, tenant.used, `tenant ${name} used`);
      eq(found.enabled, tenant.enabled, `tenant ${name} enabled`);
      if (found.used > found.plan.quota) {
        throw new Mismatch(`tenant ${name} used ${found.used} of quota ${found.plan.quota}`);
      }
    }
    if (!full) return;

    const events = Object.values(model.events);
    for (const event of events) {
      const [found] = await canister.getUsageEvent(event.id);
      if (!found) throw new Mismatch(`usage event ${event.id} is missing from the canister`);
      eq(found.units, event.units, `usage event ${event.id} units`);
      eq(found.tenant.toText(), model.ctx.principals[event.tenant], `usage event ${event.id} tenant`);
      eq(found.idempotencyKey, event.key, `usage event ${event.id} key`);
    }
    // Every idempotency key still resolves to the event it did before. The
    // model keys events by identity *name*; the canister only knows principal
    // texts, so the comparison goes through the event the key points at.
    for (const [key, id] of Object.entries(model.keyIndex)) {
      const event = model.events[id];
      const [found] = await canister.getUsageEvent(id);
      if (!found) throw new Mismatch(`idempotency entry ${key} points at missing event ${id}`);
      eq(found.idempotencyKey, event.key, `idempotency entry ${key} event key`);
      eq(found.tenant.toText(), model.ctx.principals[event.tenant], `idempotency entry ${key} event tenant`);
    }
  },
};
