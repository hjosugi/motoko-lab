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
import { generateSigner, highS, verifyAuditEntry } from './receipt.mjs';

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

  // ------------------------------------------------ signed receipts (#15) --
  // A compromised reporter could bill any tenant anything. Receipts split what
  // an attacker has to steal in two — the reporter principal that submits, the
  // device key that signs — and a policy bounds what even both can do. Every
  // receipt below is encoded and signed by `test/receipt.mjs` with
  // `node:crypto`, so each accepted one is also a cross-implementation check.
  const NANOS_PER_MS = 1_000_000n;
  const MINUTE = 60n * 1_000_000_000n;
  const HOUR = 60n * MINUTE;
  const DAY = 24n * HOUR;
  const now = async () => BigInt(await pic.getTime()) * NANOS_PER_MS;
  const advance = async (nanos) => {
    await pic.advanceTime(Number(nanos / NANOS_PER_MS));
    await pic.tick();
  };
  const tag = (outcome) => Object.keys(outcome)[0];
  const rejection = (outcome) => ('rejected' in outcome ? Object.keys(outcome.rejected)[0] : null);

  const meter = createIdentity('meter');
  const meterPrincipal = meter.getPrincipal();
  const gamma = createIdentity('gamma').getPrincipal();
  const delta = createIdentity('delta').getPrincipal();
  const BIG_PLAN = { ...PLAN, name: 'metered', quota: 1_000_000n };

  actor.setIdentity(admin);
  c.expectOk(await actor.createTenant({ principal: gamma, displayName: 'Gamma', plan: BIG_PLAN }), 'a tenant for signed usage');
  c.expectOk(await actor.createTenant({ principal: delta, displayName: 'Delta', plan: BIG_PLAN }), 'and one outside the reporter\'s scope');
  c.expectOk(await actor.setReporter(meterPrincipal, true), 'the controller approves the metering service');

  const spec = await actor.receiptSpec();
  c.ok(spec.canister.toText() === fixture.canisterId.toText() && spec.curve === 'prime256v1'
    && spec.domain === 'icp-usage-receipt:v1', 'the canister publishes the rules a signer follows, including its own id');

  const policy = {
    tenants: { only: [gamma] },
    categories: { only: ['api-call', 'storage'] },
    maxUnitsPerEvent: 100n,
    maxUnitsPerWindow: 500n,
    windowSeconds: 3_600n,
    requireSignatures: true,
  };
  actor.setIdentity(meter);
  c.expectErr(await actor.setReporterPolicy(meterPrincipal, { ...policy, tenants: { any: null } }),
    'unauthorized', 'a reporter cannot widen its own policy');
  actor.setIdentity(admin);
  c.expectErr(await actor.setReporterPolicy(meterPrincipal, { ...policy, maxUnitsPerWindow: 50n }),
    'invalidInput', 'a window smaller than one event is refused');
  c.expectOk(await actor.setReporterPolicy(meterPrincipal, policy), 'the controller scopes the reporter');

  const deviceA = generateSigner();
  actor.setIdentity(meter);
  c.expectErr(await actor.addReporterKey(meterPrincipal, deviceA.publicKey), 'unauthorized',
    'a reporter cannot register its own signing keys: a stolen principal would mint one');
  actor.setIdentity(admin);
  const notAPoint = new Uint8Array(65);
  notAPoint[0] = 4;
  c.expectErr(await actor.addReporterKey(meterPrincipal, notAPoint), 'invalidInput',
    'a key that is not a P-256 point is refused at registration');
  const keyA = c.expectOk(await actor.addReporterKey(meterPrincipal, deviceA.publicKey), 'the controller registers the device key');
  c.expectErr(await actor.addReporterKey(meterPrincipal, deviceA.publicKey), 'duplicate', 'the same key is not registered twice');
  // A key cannot have signed anything before it was registered, so the offline
  // batch below needs the key to have been in service for a few days.
  await advance(4n * DAY);

  const receipt = async (overrides = {}) => ({
    canister: fixture.canisterId,
    reporter: meterPrincipal,
    keyId: keyA.id,
    tenant: gamma,
    units: 10n,
    category: 'api-call',
    idempotencyKey: 'r-1',
    observedAt: await now(),
    ...overrides,
  });
  const submit = async (batch, description) => c.expectOk(await actor.submitReceipts(batch), description);

  // ------------------------------------------------------------ accepted once
  actor.setIdentity(meter);
  const signedFirst = deviceA.sign(await receipt());
  const [recorded] = await submit([signedFirst], 'the reporter submits a signed receipt');
  c.ok(tag(recorded) === 'recorded' && recorded.recorded.recordedBy.toText() === meterPrincipal.toText(),
    'a correctly signed receipt becomes a usage event');
  c.ok((await actor.getTenant(gamma))[0].used === 10n, 'and moves the tenant meter');
  const healthy = (await actor.getReporter(meterPrincipal))[0].health;
  c.ok(!healthy.anomalous && healthy.accepted === 1n && healthy.windowUnits === 10n, 'the reporter looks healthy');

  const eventsBefore = (await actor.stats()).usageEvents;
  const [replayed] = await submit([signedFirst], 'the same receipt is submitted again');
  c.ok(tag(replayed) === 'replayed' && replayed.replayed.id === recorded.recorded.id,
    'a replayed receipt returns the original event');
  c.ok((await actor.getTenant(gamma))[0].used === 10n && (await actor.stats()).usageEvents === eventsBefore,
    'and records nothing: the meter and the event count are unchanged');
  const [reused] = await submit([deviceA.sign(await receipt({ units: 11n }))], 'a different receipt reuses the key');
  c.ok(rejection(reused) === 'conflict', 'reusing an idempotency key for different usage is a conflict, not a replay');

  // ------------------------------------------------------- invalid signatures
  const tampered = { ...deviceA.sign(await receipt({ idempotencyKey: 'r-2' })) };
  tampered.receipt = { ...tampered.receipt, units: 99n };
  const stranger2 = generateSigner();
  const high = deviceA.sign(await receipt({ idempotencyKey: 'r-3' }));
  const bad = await submit([
    tampered,
    stranger2.sign(await receipt({ idempotencyKey: 'r-4' })),
    { ...high, signature: new Uint8Array(highS(high.signature)) },
  ], 'a batch of badly signed receipts');
  c.ok(bad.every((outcome) => rejection(outcome) === 'badSignature'),
    'an altered receipt, a key the canister never registered, and a high-S twin are all badSignature');
  const noisy = (await actor.getReporter(meterPrincipal))[0].health;
  c.ok(noisy.anomalous && noisy.badSignatures === 3n, 'three bad signatures in a window flag the reporter as anomalous');
  c.ok(noisy.lastRejection[0].reason === 'badSignature', 'and name the reason');

  // ----------------------------------------------------------- the unsigned path
  c.expectErr(await actor.recordUsage({ tenant: gamma, units: 1n, category: 'api-call', idempotencyKey: 'u-1' }),
    'unauthorized', 'a reporter that requires signatures cannot fall back to the unsigned path');

  // ---------------------------------------------------------------- scope
  const scope = await submit([
    deviceA.sign(await receipt({ tenant: delta, idempotencyKey: 's-1' })),
    deviceA.sign(await receipt({ category: 'egress', idempotencyKey: 's-2' })),
    deviceA.sign(await receipt({ units: 101n, idempotencyKey: 's-3' })),
    deviceA.sign(await receipt({ canister: stranger.getPrincipal(), idempotencyKey: 's-4' })),
  ], 'receipts outside the reporter\'s scope');
  c.ok(scope.slice(0, 3).every((outcome) => rejection(outcome) === 'outOfScope'),
    'another tenant, another category, and an oversized event are all out of scope');
  c.ok(rejection(scope[3]) === 'wrongCanister', 'a receipt signed for another deployment is refused');
  c.ok((await actor.getTenant(delta))[0].used === 0n, 'the out-of-scope tenant was not billed');

  // A stolen receipt submitted by someone else. It is refused, and it is not
  // counted against the reporter it names.
  const beforeTheft = (await actor.getReporter(meterPrincipal))[0].health.rejected;
  actor.setIdentity(stranger);
  const [stolen] = await submit([deviceA.sign(await receipt({ idempotencyKey: 't-1' }))], 'a stranger submits the reporter\'s receipt');
  c.ok(rejection(stolen) === 'unauthorized', 'only the reporter submits its own receipts');
  c.ok((await actor.getReporter(meterPrincipal))[0].health.rejected === beforeTheft,
    'and a stranger cannot spoil the named reporter\'s health');
  c.expectErr(await actor.markReporterKeyCompromised(keyA.id), 'unauthorized', 'nor mark its key compromised');
  actor.setIdentity(meter);

  // ------------------------------------------------------------- the clock
  const current = await now();
  const clock = await submit([
    deviceA.sign(await receipt({ observedAt: current + 10n * MINUTE, idempotencyKey: 'c-1' })),
    deviceA.sign(await receipt({ observedAt: current + 1n * MINUTE, idempotencyKey: 'c-2' })),
  ], 'receipts from a clock ahead of the canister');
  c.ok(rejection(clock[0]) === 'future', 'a receipt ten minutes in the future is refused');
  c.ok(tag(clock[1]) === 'recorded', 'one minute of skew is tolerated');

  // --------------------------------------------------------- offline batch
  // Signed over the past days on a device that was offline, relayed together.
  // One duplicate inside the batch, and one too old to bill.
  const offline = [
    deviceA.sign(await receipt({ observedAt: current - 3n * DAY, idempotencyKey: 'o-1' })),
    deviceA.sign(await receipt({ observedAt: current - 2n * DAY, idempotencyKey: 'o-2' })),
    deviceA.sign(await receipt({ observedAt: current - 1n * HOUR, idempotencyKey: 'o-3', category: 'storage' })),
    deviceA.sign(await receipt({ observedAt: current - 8n * DAY, idempotencyKey: 'o-4' })),
  ];
  const batch = await submit([...offline, offline[1]], 'an offline batch is relayed in one call');
  c.ok(batch.map(tag).join() === 'recorded,recorded,recorded,rejected,replayed',
    'each receipt is decided on its own: three recorded, the stale one refused, the in-batch duplicate replayed');
  c.ok(rejection(batch[3]) === 'stale', 'the eight-day-old receipt is stale');
  c.ok(batch[4].replayed.id === batch[1].recorded.id, 'the duplicate returns the event its twin created');
  c.expectErr(await actor.submitReceipts([]), 'invalidInput', 'an empty batch is refused');
  c.expectErr(await actor.submitReceipts(Array(Number(spec.maxBatch) + 1).fill(offline[0])), 'invalidInput',
    'a batch above the limit is refused');

  // ---------------------------------------------------------- key rotation
  const beforeRotation = await now();
  const signedBeforeRotation = deviceA.sign(await receipt({ observedAt: beforeRotation, idempotencyKey: 'k-1' }));
  await advance(MINUTE);
  const deviceB = generateSigner();
  actor.setIdentity(admin);
  const keyB = c.expectOk(await actor.addReporterKey(meterPrincipal, deviceB.publicKey), 'a new device key is registered');
  c.expectOk(await actor.retireReporterKey(keyA.id), 'and the old one retired');
  c.expectErr(await actor.retireReporterKey(keyA.id), 'conflict', 'a key is retired once');
  // `pic.getTime()` has millisecond resolution; a minute keeps "after the
  // retirement" unambiguous for the receipt signed next.
  await advance(MINUTE);
  actor.setIdentity(meter);
  const rotation = await submit([
    signedBeforeRotation,
    deviceA.sign(await receipt({ idempotencyKey: 'k-2' })),
    deviceB.sign(await receipt({ keyId: keyB.id, idempotencyKey: 'k-3' })),
  ], 'receipts across a rotation');
  c.ok(tag(rotation[0]) === 'recorded', 'a receipt the old key signed before its retirement still verifies');
  c.ok(rejection(rotation[1]) === 'keyNotValid', 'the retired key signs nothing new');
  c.ok(tag(rotation[2]) === 'recorded', 'the new key is in use');

  // ----------------------------------------------------- reporter compromise
  // The device key is presumed stolen. Backdating does not help the thief:
  // nothing it signed is accepted, whatever time it claims.
  c.expectOk(await actor.markReporterKeyCompromised(keyB.id), 'the reporter itself reports its key stolen');
  const compromised = await submit([
    deviceB.sign(await receipt({ keyId: keyB.id, idempotencyKey: 'x-1' })),
    deviceB.sign(await receipt({ keyId: keyB.id, idempotencyKey: 'x-2', observedAt: (await now()) - 2n * MINUTE })),
  ], 'receipts signed with the stolen key');
  c.ok(compromised.every((outcome) => rejection(outcome) === 'keyNotValid'),
    'a compromised key is refused even for a backdated receipt');

  // --------------------------------------------------------- the window limit
  // A new window, then a burst. The limit is the ceiling on what a
  // compromised reporter with a working key can inflate before someone looks.
  const deviceC = generateSigner();
  actor.setIdentity(admin);
  const keyC = c.expectOk(await actor.addReporterKey(meterPrincipal, deviceC.publicKey), 'a replacement key');
  actor.setIdentity(meter);
  await advance(HOUR);
  const calm = (await actor.getReporter(meterPrincipal))[0].health;
  c.ok(!calm.anomalous && calm.windowUnits === 0n && calm.rejectedInWindow === 0n,
    'a new window starts clean while the lifetime counters stay');
  const burst = [];
  for (let i = 0; i < 6; i += 1) {
    burst.push(deviceC.sign(await receipt({ keyId: keyC.id, units: 100n, idempotencyKey: `b-${i}` })));
  }
  const flood = await submit(burst, 'a burst of maximum-size receipts');
  c.ok(flood.slice(0, 5).every((outcome) => tag(outcome) === 'recorded'), 'the window admits exactly its limit');
  const overflow = flood[5].rejected.windowExceeded;
  c.ok(overflow.limit === 500n && overflow.used === 500n && overflow.requested === 100n,
    'the sixth is refused with the limit, the used amount, and the request');
  const alarmed = (await actor.getReporter(meterPrincipal))[0].health;
  c.ok(alarmed.anomalous && alarmed.windowExceeded === 1n && alarmed.lastRejection[0].reason === 'windowExceeded',
    'the burst is observable: anomalous, counted, and named');

  // A full batch has to fit in one message. Verification is ~1.8B
  // instructions a receipt, an update message may use 40B, and `maxBatch` is
  // sized from that; a batch that trapped would lose the whole relay.
  const bulk = createIdentity('bulk');
  const deviceD = generateSigner();
  actor.setIdentity(admin);
  c.expectOk(await actor.setReporter(bulk.getPrincipal(), true), 'a bulk reporter is approved');
  c.expectOk(await actor.setReporterPolicy(bulk.getPrincipal(), {
    ...policy, maxUnitsPerEvent: 1n, maxUnitsPerWindow: 1_000n,
  }), 'with a policy of its own');
  const keyD = c.expectOk(await actor.addReporterKey(bulk.getPrincipal(), deviceD.publicKey), 'and a key');
  await advance(MINUTE);
  actor.setIdentity(bulk);
  const full = [];
  for (let i = 0; i < Number(spec.maxBatch); i += 1) {
    full.push(deviceD.sign(await receipt({ reporter: bulk.getPrincipal(), keyId: keyD.id, units: 1n, idempotencyKey: `f-${i}` })));
  }
  const fullOutcomes = await submit(full, `a batch of the maximum ${spec.maxBatch} receipts`);
  c.ok(fullOutcomes.every((outcome) => tag(outcome) === 'recorded'), 'is verified and recorded within one message');
  actor.setIdentity(meter);

  // ------------------------------------------------------------ audit export
  const audit = await actor.exportUsageAudit(0n, 100n);
  const signedEntries = audit.filter((entry) => entry.receipt.length === 1);
  c.ok(signedEntries.length === 12 + Number(spec.maxBatch) && audit.length - signedEntries.length === 4,
    'the audit export carries every signed event with its receipt and key, and marks the unsigned ones');
  c.ok(signedEntries.every((entry) => verifyAuditEntry(entry).valid),
    'an auditor re-verifies every signed event offline with node:crypto');
  const forged = { ...signedEntries[0], event: { ...signedEntries[0].event, units: 1_000n } };
  c.ok(verifyAuditEntry(forged).valid === false, 'an event that disagrees with its receipt fails the audit');

  const view = (await actor.getReporter(meterPrincipal))[0];
  c.ok(view.keys.map((key) => Object.keys(key.status)[0]).join() === 'retired,compromised,active',
    'the reporter view shows every key and its status');

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

  // Keys, policies, receipts and health are authorization state too. Lose the
  // receipt index and a replay records twice; lose a key status and a stolen
  // key signs again.
  const viewAfter = (await actor.getReporter(meterPrincipal))[0];
  c.ok(JSON.stringify(viewAfter.keys, bigintSafe) === JSON.stringify(view.keys, bigintSafe)
    && JSON.stringify(viewAfter.policy, bigintSafe) === JSON.stringify(view.policy, bigintSafe),
    'reporter keys and policy survive the upgrade unchanged');
  c.ok(viewAfter.health.accepted === view.health.accepted && viewAfter.health.rejected === view.health.rejected,
    'and so do the reporter\'s lifetime counters');
  actor.setIdentity(meter);
  const [replayedAfter] = c.expectOk(await actor.submitReceipts([signedFirst]), 'a receipt accepted before the upgrade is resubmitted');
  c.ok('replayed' in replayedAfter && replayedAfter.replayed.id === recorded.recorded.id,
    'and replays to the same original event');
  const [stillStolen] = c.expectOk(
    await actor.submitReceipts([deviceB.sign(await receipt({ keyId: keyB.id, idempotencyKey: 'x-3' }))]),
    'the stolen key tries again after the upgrade');
  c.ok(rejection(stillStolen) === 'keyNotValid', 'and is still refused');
}
