// Replica suite for the usage-metered SaaS backend.
//
// This is the app the interpreter can say the least about. Its admin gate is
// `Principal.isController`, which asks the *replica* who controls the canister
// — there is no such thing in `moc -r`. Its idempotency key is scoped by tenant
// principal, its quota window is wall-clock, and a replayed report must return
// the original event rather than a second one. None of that is reachable
// without a replica whose clock and controller set can be set.
//
//   node tools/pocket-ic/run.mjs 05

import { bigintSafe, buildCanister, digest, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';

export const name = '05_usage_metered_saas';

const PLAN = { name: 'starter', quota: 100n, periodSeconds: 3_600n, priceMinorUnits: 900n, currency: 'USD' };

export async function suite({ appDir, pic, createIdentity, checks: c }) {
  const { wasm, idl } = await buildCanister({
    appDir,
    name: 'usage_metered_saas',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);

  // The admin gate is `Principal.isController`, so the controller has to be a
  // principal this suite can call as. `setupCanister`'s `sender` becomes the
  // controller, which is the same rule `icp deploy` follows.
  const admin = createIdentity('admin');
  const sender = admin.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender });
  const actor = fixture.actor;

  const tenant = createIdentity('tenant');
  const tenantPrincipal = tenant.getPrincipal();
  const reporter = createIdentity('reporter');
  const stranger = createIdentity('stranger');

  const usage = (units, key, overrides = {}) => ({
    tenant: tenantPrincipal,
    units: BigInt(units),
    category: 'api-call',
    idempotencyKey: key,
    ...overrides,
  });

  // ------------------------------------------------------------ the gate
  // Controller-only, and "controller" means the replica's controller list.
  actor.setIdentity(stranger);
  c.expectErr(await actor.createTenant({ principal: tenantPrincipal, displayName: 'Acme', plan: PLAN }),
    'unauthorized', 'a stranger cannot create a tenant');
  actor.setIdentity(tenant);
  c.expectErr(await actor.setReporter(reporter.getPrincipal(), true),
    'unauthorized', 'the tenant itself is not an admin');

  actor.setIdentity(admin);
  c.expectErr(await actor.createTenant({ principal: tenantPrincipal, displayName: '', plan: PLAN }),
    'invalidInput', 'a tenant needs a display name');
  c.expectErr(await actor.createTenant({
    principal: tenantPrincipal, displayName: 'Acme', plan: { ...PLAN, quota: 0n },
  }), 'invalidInput', 'a plan cannot have a zero quota');

  const created = c.expectOk(
    await actor.createTenant({ principal: tenantPrincipal, displayName: 'Acme', plan: PLAN }),
    'the controller creates a tenant');
  c.ok(created.used === 0n && created.enabled, 'a fresh tenant is enabled with nothing used');
  c.expectErr(await actor.createTenant({ principal: tenantPrincipal, displayName: 'Acme again', plan: PLAN }),
    'duplicate', 'the same tenant principal cannot be created twice');

  // ---------------------------------------------------------- API key hashes
  // A tenant may register its own key; a stranger may not register one for it.
  actor.setIdentity(stranger);
  c.expectErr(await actor.registerApiKeyHash(tenantPrincipal, digest(1), 'stolen'),
    'unauthorized', 'a stranger cannot register a key for someone else\'s tenant');
  actor.setIdentity(tenant);
  c.expectErr(await actor.registerApiKeyHash(tenantPrincipal, new Uint8Array(10), 'short'),
    'invalidInput', 'an API key hash must be 32 bytes');
  const key = c.expectOk(await actor.registerApiKeyHash(tenantPrincipal, digest(1), 'primary'),
    'the tenant registers its own key hash');
  c.ok(key.revokedAt.length === 0, 'a fresh key is not revoked');
  c.expectErr(await actor.registerApiKeyHash(tenantPrincipal, digest(1), 'again'),
    'duplicate', 'the same key hash cannot be registered twice');

  actor.setIdentity(stranger);
  c.expectErr(await actor.revokeApiKeyHash(digest(1)), 'unauthorized', 'a stranger cannot revoke the key');
  actor.setIdentity(tenant);
  c.expectOk(await actor.revokeApiKeyHash(digest(1)), 'the tenant revokes its own key');
  c.expectErr(await actor.revokeApiKeyHash(digest(1)), 'conflict', 'revoking twice conflicts');

  // --------------------------------------------------------------- reporting
  actor.setIdentity(stranger);
  c.expectErr(await actor.recordUsage(usage(1, 'a')), 'unauthorized', 'an unapproved reporter is refused');

  actor.setIdentity(admin);
  c.expectOk(await actor.setReporter(reporter.getPrincipal(), true), 'the controller approves a reporter');

  actor.setIdentity(reporter);
  c.expectErr(await actor.recordUsage(usage(0, 'zero')), 'invalidInput', 'zero units is not a usage event');
  c.expectErr(await actor.recordUsage(usage(1, '')), 'invalidInput', 'an idempotency key is required');
  c.expectErr(await actor.recordUsage(usage(1, 'x', { tenant: stranger.getPrincipal() })),
    'notFound', 'usage cannot be recorded against an unknown tenant');

  const first = c.expectOk(await actor.recordUsage(usage(10, 'req-1')), 'the reporter records 10 units');
  c.ok(first.recordedBy.toText() === reporter.getPrincipal().toText(), 'the event records who reported it');
  c.ok((await actor.getTenant(tenantPrincipal))[0].used === 10n, 'the tenant meter moves');

  // Idempotency returns the *original* event, not a new one and not an error.
  // A retry after a dropped response must be free.
  const replay = c.expectOk(await actor.recordUsage(usage(10, 'req-1')), 'the same idempotency key replays');
  c.ok(replay.id === first.id, 'the replay returns the original event id');
  c.ok((await actor.getTenant(tenantPrincipal))[0].used === 10n, 'a replay does not double-count');
  c.ok((await actor.stats()).usageEvents === 1n, 'a replay creates no second event');

  // The key is scoped per tenant, so the same string is free for another one.
  actor.setIdentity(admin);
  const otherTenant = createIdentity('other-tenant').getPrincipal();
  c.expectOk(await actor.createTenant({ principal: otherTenant, displayName: 'Globex', plan: PLAN }),
    'a second tenant is created');
  actor.setIdentity(reporter);
  const otherEvent = c.expectOk(await actor.recordUsage(usage(5, 'req-1', { tenant: otherTenant })),
    'the same idempotency key is free under a different tenant');
  c.ok(otherEvent.id !== first.id, 'it is a distinct event');

  // ------------------------------------------------------------------ quota
  // Refused, not truncated: a partially-applied report would silently overrun.
  const exceeded = c.expectErr(await actor.recordUsage(usage(95, 'req-2')), 'quotaExceeded',
    'a report that would exceed the quota is refused');
  c.ok(exceeded.quota === 100n && exceeded.used === 10n && exceeded.requested === 95n,
    'the rejection reports quota, used, and requested');
  c.ok((await actor.getTenant(tenantPrincipal))[0].used === 10n, 'a refused report does not move the meter');
  c.expectOk(await actor.recordUsage(usage(90, 'req-3')), 'a report that exactly fills the quota is accepted');

  // ------------------------------------------------------- the quota window
  // Wall-clock, so only reachable where the clock can be moved.
  c.expectErr(await actor.recordUsage(usage(1, 'req-4')), 'quotaExceeded', 'the tenant is now at its quota');
  await pic.setTime((await pic.getTime()) + 2 * 3_600_000);
  await pic.tick();
  const newPeriod = c.expectOk(await actor.recordUsage(usage(1, 'req-5')),
    'the next period accepts usage again');
  c.ok(newPeriod.units === 1n, 'the rolled-over period starts from the new report');
  c.ok((await actor.getTenant(tenantPrincipal))[0].used === 1n, 'the meter resets rather than accumulating');

  // -------------------------------------------------------- disabled tenant
  actor.setIdentity(admin);
  c.expectOk(await actor.setTenantEnabled(tenantPrincipal, false), 'the controller disables the tenant');
  actor.setIdentity(reporter);
  c.expectErr(await actor.recordUsage(usage(1, 'req-6')), 'conflict', 'a disabled tenant accepts no usage');
  actor.setIdentity(tenant);
  c.expectErr(await actor.registerApiKeyHash(tenantPrincipal, digest(2), 'second'),
    'conflict', 'a disabled tenant cannot register new keys');

  const before = await actor.stats();

  // ---------------------------------------------------------------- upgrade
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');
  c.ok((await actor.getTenant(tenantPrincipal))[0].enabled === false, 'the tenant is still disabled after the upgrade');
  c.ok((await actor.getApiKey(digest(1)))[0].revokedAt.length === 1, 'a revoked key is still revoked after the upgrade');

  // The reporter allowlist and the idempotency index are both authorization
  // state. If either were lost, an upgrade would reopen the meter to replay.
  actor.setIdentity(admin);
  c.expectOk(await actor.setTenantEnabled(tenantPrincipal, true), 'the controller re-enables the tenant');
  actor.setIdentity(reporter);
  const afterUpgrade = c.expectOk(await actor.recordUsage(usage(1, 'req-5')),
    'an idempotency key used before the upgrade still replays after it');
  c.ok(afterUpgrade.id === newPeriod.id, 'and returns the same original event');

  actor.setIdentity(stranger);
  c.expectErr(await actor.recordUsage(usage(1, 'req-7')), 'unauthorized',
    'the reporter allowlist still refuses a stranger after the upgrade');
}
