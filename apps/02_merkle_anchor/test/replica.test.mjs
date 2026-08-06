// Replica suite for the Merkle anchor.
//
// The interesting claims here are about the root index and supersession: one
// root can be anchored once, a batch may only supersede a batch its own caller
// owns, and both facts have to survive an upgrade because they are what makes
// an anchor worth anchoring.
//
//   node tools/pocket-ic/run.mjs 02

import { bigintSafe, buildCanister, digest, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';

export const name = '02_merkle_anchor';

function anchorInput(seed, overrides = {}) {
  return {
    root: digest(seed),
    leafCount: 1024n,
    hashAlgorithm: 'sha256',
    treeVersion: 'rfc6962',
    schemaUri: `ipfs://schema-${seed}`,
    policyUri: `ipfs://policy-${seed}`,
    manifestUri: `ipfs://manifest-${seed}`,
    supersedes: [],
    ...overrides,
  };
}

export async function suite({ appDir, pic, createIdentity, checks: c }) {
  const { wasm, idl } = await buildCanister({
    appDir,
    name: 'merkle_anchor',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);

  const deployer = createIdentity('deployer');
  const sender = deployer.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender });
  const actor = fixture.actor;

  const alice = createIdentity('alice');
  const bob = createIdentity('bob');

  // -------------------------------------------------------- anonymous caller
  actor.setPrincipal(null);
  c.expectErr(await actor.anchor(anchorInput(1)), 'anonymousNotAllowed', 'anchor refuses the anonymous principal');

  // -------------------------------------------------------------- validation
  actor.setIdentity(alice);
  c.expectErr(await actor.anchor(anchorInput(1, { root: new Uint8Array(16) })),
    'invalidInput', 'the root must be a 32-byte digest');
  c.expectErr(await actor.anchor(anchorInput(1, { leafCount: 0n })),
    'invalidInput', 'a batch cannot anchor zero leaves');
  c.expectErr(await actor.anchor(anchorInput(1, { leafCount: 1_000_001n })),
    'invalidInput', 'leafCount is capped at 1,000,000');
  c.expectErr(await actor.anchor(anchorInput(1, { hashAlgorithm: '' })),
    'invalidInput', 'hashAlgorithm cannot be empty');

  // ------------------------------------------------------------- anchoring
  const first = c.expectOk(await actor.anchor(anchorInput(1)), 'alice anchors a batch');
  c.ok(first.id === 1n, 'the first batch gets id 1');
  c.ok(first.owner.toText() === alice.getPrincipal().toText(), 'the batch owner is the caller');
  c.ok('active' in first.status, 'a fresh batch is active');

  // The whole point of the root index: the same root cannot be anchored twice,
  // by anyone.
  c.expectErr(await actor.anchor(anchorInput(1)), 'duplicate', 'the same root cannot be anchored twice');
  actor.setIdentity(bob);
  c.expectErr(await actor.anchor(anchorInput(1)), 'duplicate', 'not even by a different caller');

  // ----------------------------------------------------------- supersession
  c.expectErr(await actor.anchor(anchorInput(2, { supersedes: [first.id] })),
    'unauthorized', 'bob cannot supersede a batch he does not own');
  c.expectErr(await actor.anchor(anchorInput(2, { supersedes: [9999n] })),
    'notFound', 'superseding a batch that does not exist is notFound');

  actor.setIdentity(alice);
  const second = c.expectOk(await actor.anchor(anchorInput(2, { supersedes: [first.id] })),
    'alice supersedes her own batch');
  c.ok(second.supersedes.length === 1 && second.supersedes[0] === first.id, 'the superseded id is recorded');
  // Supersession is a forward pointer, not a retraction: the superseded batch
  // stays active, because anything that verified against it must keep verifying.
  const superseded = await actor.getBatch(first.id);
  c.ok('active' in superseded[0].status, 'being superseded does not revoke the earlier batch');

  // ------------------------------------------------------------- revocation
  actor.setIdentity(bob);
  c.expectErr(await actor.revoke(first.id, 'not mine'), 'unauthorized', 'bob cannot revoke alice\'s batch');
  actor.setIdentity(alice);
  c.expectErr(await actor.revoke(first.id, ''), 'invalidInput', 'revocation needs a reason');
  c.expectErr(await actor.revoke(9999n, 'nope'), 'notFound', 'revoking an unknown batch is notFound');
  const revoked = c.expectOk(await actor.revoke(first.id, 'bad tree'), 'alice revokes her batch');
  c.ok('revoked' in revoked.status && revoked.status.revoked.reason === 'bad tree', 'the reason is stored');
  c.expectErr(await actor.revoke(first.id, 'again'), 'conflict', 'revoking twice conflicts');

  // ------------------------------------------------------------- read paths
  const byRoot = await actor.getByRoot(digest(1));
  c.ok(byRoot.length === 1 && byRoot[0].id === first.id, 'a batch is findable by its root');
  c.ok((await actor.getByRoot(digest(77))).length === 0, 'an unknown root finds nothing');
  c.ok((await actor.listBatches(0n, 100n)).length === 2, 'listBatches returns both batches');

  const before = await actor.stats();
  c.ok(before.batches === 2n && before.active === 1n && before.revoked === 1n, 'stats separate active from revoked');

  // ---------------------------------------------------------------- upgrade
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');
  c.ok((await actor.getByRoot(digest(1))).length === 1, 'the root index survives the upgrade');

  // The index has to survive as an index, not merely as data: a root anchored
  // before the upgrade must still be refused after it.
  actor.setIdentity(alice);
  c.expectErr(await actor.anchor(anchorInput(1)), 'duplicate',
    'a root anchored before the upgrade is still refused after it');

  const third = c.expectOk(await actor.anchor(anchorInput(3)), 'anchoring still works after the upgrade');
  c.ok(third.id === 3n, 'batch ids continue past the upgrade rather than restarting');
}
