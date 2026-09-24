// Replica suite for the Merkle anchor.
//
// The interesting claims here are about the root index and supersession: one
// root can be anchored once, a batch may only supersede a batch its own caller
// owns, and both facts have to survive an upgrade because they are what makes
// an anchor worth anchoring.
//
// Since #9 the canister also verifies proofs against anchored roots. Every
// proof below is built by `protocol/tools/merkle.mjs` or read from the
// published vectors — the reference implementation, not the canister's — so
// each `verifyProof` is a cross-implementation check as well as an API one.
//
//   node tools/pocket-ic/run.mjs 02

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { bigintSafe, buildCanister, digest, repoRoot, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';
import { vendorDir } from '../../../tools/pocket-ic/setup.mjs';
import { buildTree, spec as merkleSpec, TREE_VERSION } from '../../../protocol/tools/merkle.mjs';

export const name = '02_merkle_anchor';

/// The last release before tree versions were enforced. Pinned rather than
/// "latest tag": what this reproduces is a batch anchored under rules the
/// canister does not implement, and only this release could create one.
const LEGACY_RELEASE = 'v2026.09.22';

function anchorInput(seed, overrides = {}) {
  return {
    root: digest(seed),
    leafCount: 1024n,
    hashAlgorithm: 'sha256',
    treeVersion: TREE_VERSION,
    schemaUri: `ipfs://schema-${seed}`,
    policyUri: `ipfs://policy-${seed}`,
    manifestUri: `ipfs://manifest-${seed}`,
    supersedes: [],
    ...overrides,
  };
}

const leafValue = (seed) => digest(1000 + seed);
const flip = (bytes, at = 0) => {
  const copy = new Uint8Array(bytes);
  copy[at] ^= 0x01;
  return copy;
};
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const asProof = (proof) => ({ leaf: proof.leaf, index: BigInt(proof.index), path: proof.path });
const asMulti = (multi) => ({
  leaves: multi.leaves.map(({ index, leaf }) => ({ index: BigInt(index), leaf })),
  proof: multi.proof,
});

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
  // A root is only worth anchoring if someone can check a leaf against it, and
  // that needs rules. Only the tree version the canister implements is taken.
  c.expectErr(await actor.anchor(anchorInput(1, { treeVersion: 'rfc6962' })),
    'invalidInput', 'a tree version the canister does not implement is refused');
  c.expectErr(await actor.anchor(anchorInput(1, { hashAlgorithm: 'sha512' })),
    'invalidInput', 'icp-merkle:v1 is SHA-256 and says so');

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

  await proofs({ actor, alice, c });
  await legacy({ pic, appDir, createIdentity, c, current: { wasm, idl } });
}

// ------------------------------------------------------------------ proofs

async function proofs({ actor, alice, c }) {
  actor.setIdentity(alice);

  // The canister and the reference implementation have to agree about the
  // rules before any verdict below means anything.
  const published = await actor.merkleSpec();
  const reference = merkleSpec();
  c.ok(Object.keys(published).length === Object.keys(reference).length
    && Object.entries(reference).every(([key, value]) => String(published[key]) === String(value)),
    'merkleSpec() matches protocol/tools/merkle.mjs field for field');

  // A seven-leaf tree: unbalanced, so the right edge carries a node up a level.
  const leaves = Array.from({ length: 7 }, (_, i) => leafValue(i));
  const tree = buildTree(leaves);
  const batch = c.expectOk(await actor.anchor(anchorInput(0, { root: tree.root, leafCount: 7n })),
    'alice anchors the root of a 7-leaf tree');
  c.ok(batch.treeVersion === TREE_VERSION, 'the tree version is stored with the batch');

  let all = true;
  for (let i = 0; i < 7; i++) {
    const check = c.expectOk(await actor.verifyProof(batch.id, asProof(tree.prove(i))), `leaf ${i} verifies on-chain`);
    all &&= check.included && same(check.computedRoot, tree.root) && 'active' in check.status;
  }
  c.ok(all, 'every leaf is included, and computedRoot is the anchored root');

  const good = tree.prove(2);
  const corrupted = async (proof, description) => {
    const check = c.expectOk(await actor.verifyProof(batch.id, asProof(proof)), description);
    c.ok(!check.included && !same(check.computedRoot, tree.root), `${description}: not included`);
  };
  await corrupted({ ...good, leaf: flip(good.leaf) }, 'a corrupted leaf is well formed');
  await corrupted({ ...good, path: good.path.map((h, i) => (i === 1 ? flip(h) : h)) }, 'a corrupted path hash is well formed');
  await corrupted({ ...good, index: 3 }, 'the proof for leaf 2 presented as leaf 3');
  await corrupted({ ...good, path: [...good.path].reverse() }, 'a reordered path');

  c.expectErr(await actor.verifyProof(batch.id, asProof({ ...good, path: [...good.path, good.path[0]] })),
    'invalidInput', 'a path longer than (index, size) allows is refused before hashing');
  c.expectErr(await actor.verifyProof(batch.id, asProof({ ...good, path: good.path.slice(1) })),
    'invalidInput', 'a path shorter than (index, size) requires is refused');
  c.expectErr(await actor.verifyProof(batch.id, asProof({ ...good, leaf: good.leaf.subarray(0, 31) })),
    'invalidInput', 'a 31-byte leaf is refused');
  c.expectErr(await actor.verifyProof(batch.id, asProof({ ...good, index: 7 })),
    'invalidInput', 'an index outside the anchored leaf count is refused');
  c.expectErr(await actor.verifyProof(9999n, asProof(good)), 'notFound', 'an unknown batch is notFound');

  // A corrupted *root* is the anchor's side, not the proof's: the same proof
  // against a different anchored root with the same leaf count is not included.
  const other = c.expectOk(await actor.anchor(anchorInput(0, { root: flip(tree.root, 31), leafCount: 7n })),
    'a root one bit away can be anchored as its own batch');
  const againstOther = c.expectOk(await actor.verifyProof(other.id, asProof(good)), 'verify against the corrupted root');
  c.ok(!againstOther.included && same(againstOther.computedRoot, tree.root),
    'a corrupted root fails, and computedRoot names the batch the proof belongs to');
  const home = await actor.getByRoot(againstOther.computedRoot);
  c.ok(home.length === 1 && home[0].id === batch.id, 'getByRoot(computedRoot) finds that batch');

  // --------------------------------------------------------------- multiproofs
  const multi = tree.proveMany([0, 3, 6]);
  const many = c.expectOk(await actor.verifyMultiproof(batch.id, asMulti(multi)), 'a multiproof for leaves 0, 3 and 6');
  c.ok(many.included, 'the multiproof is included');
  const tampered = c.expectOk(await actor.verifyMultiproof(batch.id, asMulti({
    ...multi,
    leaves: multi.leaves.map((leaf, i) => (i === 1 ? { ...leaf, leaf: flip(leaf.leaf) } : leaf)),
  })), 'a multiproof with one leaf changed');
  c.ok(!tampered.included, 'one changed leaf fails the whole multiproof');
  c.expectErr(await actor.verifyMultiproof(batch.id, asMulti({ ...multi, leaves: [...multi.leaves].reverse() })),
    'invalidInput', 'multiproof leaves out of index order are refused');
  c.expectErr(await actor.verifyMultiproof(batch.id, asMulti({ ...multi, proof: [...multi.proof, multi.proof[0]] })),
    'invalidInput', 'a multiproof with a hash left over is refused');
  c.expectErr(await actor.verifyMultiproof(batch.id, asMulti({ ...multi, proof: multi.proof.slice(1) })),
    'invalidInput', 'a multiproof with a hash missing is refused');
  c.expectErr(await actor.verifyMultiproof(batch.id, { leaves: [], proof: [] }),
    'invalidInput', 'an empty multiproof is refused');
  const tooMany = Array.from({ length: 257 }, (_, i) => ({ index: BigInt(i), leaf: leafValue(0) }));
  c.expectErr(await actor.verifyMultiproof(batch.id, { leaves: tooMany, proof: [] }),
    'invalidInput', 'more leaves than maxMultiproofLeaves is refused before hashing');

  // ------------------------------------------------------------- test plan
  // One leaf: the leaf hash is the root and the path is empty.
  const single = buildTree([leafValue(42)]);
  const one = c.expectOk(await actor.anchor(anchorInput(0, { root: single.root, leafCount: 1n })), 'a one-leaf batch');
  c.ok(c.expectOk(await actor.verifyProof(one.id, asProof(single.prove(0))), 'its only proof').included,
    'a one-leaf tree verifies with an empty path');

  // Duplicate leaves: allowed, and every position provable.
  const dupTree = buildTree([leafValue(5), leafValue(5), leafValue(5)]);
  const dup = c.expectOk(await actor.anchor(anchorInput(0, { root: dupTree.root, leafCount: 3n })), 'a batch of duplicate leaves');
  let dupAll = true;
  for (let i = 0; i < 3; i++) {
    dupAll &&= c.expectOk(await actor.verifyProof(dup.id, asProof(dupTree.prove(i))), `duplicate position ${i}`).included;
  }
  c.ok(dupAll, 'every position of a duplicate-leaf tree is included');

  // Large batches, from the published vectors: the 100,000-leaf tree and the
  // anchor's maximum, 1,000,000 leaves with a 20-hash path. The proofs were
  // built by the reference implementation; nothing here rebuilds the trees.
  const vectors = JSON.parse(await readFile(resolve(repoRoot, 'protocol/test-vectors/merkle/vectors.json'), 'utf8'));
  for (const name of ['large-100000', 'uniform-1000000']) {
    const vector = vectors.trees.find((tree) => tree.name === name);
    const anchored = c.expectOk(await actor.anchor(anchorInput(0, {
      root: unhex(vector.rootHex),
      leafCount: BigInt(vector.leafCount),
    })), `anchor ${name}`);
    let included = true;
    for (const proof of vector.proofs) {
      const check = c.expectOk(await actor.verifyProof(anchored.id, {
        leaf: unhex(proof.leafHex),
        index: BigInt(proof.index),
        path: proof.pathHex.map(unhex),
      }), `${name} leaf ${proof.index} (${proof.pathHex.length}-hash path)`);
      included &&= check.included;
    }
    c.ok(included, `every published proof of ${name} verifies on-chain`);
  }
  const spread = vectors.multiproofs.find((m) => m.name === 'large-spread');
  const large = await actor.getByRoot(unhex(spread.rootHex));
  c.ok(c.expectOk(await actor.verifyMultiproof(large[0].id, {
    leaves: spread.leaves.map(({ index, leafHex }) => ({ index: BigInt(index), leaf: unhex(leafHex) })),
    proof: spread.proofHex.map(unhex),
  }), 'a 3-leaf multiproof over the 100,000-leaf tree').included, 'the large multiproof is included');

  // Revocation does not change what is in the tree. The verdict says so and
  // carries the status beside it, so a reader cannot miss either.
  c.expectOk(await actor.revoke(batch.id, 'superseded by a corrected tree'), 'alice revokes the 7-leaf batch');
  const afterRevoke = c.expectOk(await actor.verifyProof(batch.id, asProof(good)), 'verify against the revoked batch');
  c.ok(afterRevoke.included && 'revoked' in afterRevoke.status,
    'a revoked batch still includes its leaves, and the verdict carries the revocation');
}

// ------------------------------------------------------------------ legacy

/// A batch anchored before #9 may name rules this canister does not implement.
/// Installs the last release that allowed that, anchors one, upgrades to this
/// build, and checks the batch survives and is refused rather than read under
/// v1 rules — "never reinterpret an existing root", docs/UPGRADE_PLAN.md.
async function legacy({ pic, appDir, createIdentity, c, current }) {
  const source = resolve(vendorDir, 'legacy', name, LEGACY_RELEASE);
  try {
    await mkdir(resolve(source, 'backend/src'), { recursive: true });
    await mkdir(resolve(source, 'backend/candid'), { recursive: true });
    for (const file of ['backend/src/main.mo', 'backend/src/Validation.mo', 'backend/candid/backend.did']) {
      const text = execFileSync('git', ['show', `${LEGACY_RELEASE}:apps/${name}/${file}`], { cwd: repoRoot }).toString();
      await writeFile(resolve(source, file), text);
    }
  } catch (error) {
    // The release tag comes with a clone (`fetch-depth: 0` in CI), not with a
    // ZIP of the kit. Said out loud, and visible as a lower check count.
    console.log(`  --  skipped the ${LEGACY_RELEASE} upgrade check: ${error.message.split('\n')[0]}`);
    return;
  }

  const old = await buildCanister({
    appDir,
    name: `merkle_anchor_${LEGACY_RELEASE}`,
    main: resolve(source, 'backend/src/main.mo'),
    did: resolve(source, 'backend/candid/backend.did'),
  });
  const { idlFactory: oldIdl } = await import(old.idl);
  const { idlFactory } = await import(current.idl);

  const deployer = createIdentity('legacy-deployer');
  const sender = deployer.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory: oldIdl, wasm: old.wasm, sender });
  fixture.actor.setIdentity(createIdentity('carol'));
  const legacyBatch = c.expectOk(await fixture.actor.anchor(anchorInput(500, { treeVersion: 'rfc6962' })),
    `${LEGACY_RELEASE} accepted a batch under an unimplemented tree version`);

  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm: current.wasm, sender });
  const actor = pic.createActor(idlFactory, fixture.canisterId);
  actor.setIdentity(createIdentity('carol'));

  const kept = await actor.getBatch(legacyBatch.id);
  c.ok(kept.length === 1 && kept[0].treeVersion === 'rfc6962' && same(kept[0].root, legacyBatch.root),
    'the legacy batch survives the upgrade exactly as anchored');
  const leaf = leafValue(0);
  c.expectErr(await actor.verifyProof(legacyBatch.id, { leaf, index: 0n, path: [] }),
    'conflict', 'a legacy batch is refused, not reinterpreted under icp-merkle:v1');
  c.expectErr(await actor.anchor(anchorInput(501, { treeVersion: 'rfc6962' })),
    'invalidInput', 'after the upgrade the unimplemented tree version is refused');
  c.expectErr(await actor.anchor(anchorInput(500)), 'duplicate',
    'the legacy root is still in the root index after the upgrade');
}
