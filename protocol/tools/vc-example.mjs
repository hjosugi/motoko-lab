#!/usr/bin/env node
// The published Verifiable Credential examples (protocol/examples/vc/).
//
// Deterministic: keys from public seeds (they are test keys, not secrets),
// fixed ids, dates and principals. Everything except the status list is
// rebuilt byte for byte by vc.test.mjs. The status list is gzip, whose output
// differs between zlib builds, so the suite reads the committed list rather
// than regenerating it — and checks every bit it is supposed to carry.
//
//   node protocol/tools/vc-example.mjs            # rewrite protocol/examples/vc/
//   node protocol/tools/vc-example.mjs --status   # also rewrite the status list

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { didKey, didKeyVerificationMethod } from './multikey.mjs';
import { encode as encodePrincipal } from './principal.mjs';
import {
  delegationCredential,
  emptyStatusList,
  membershipCredential,
  reviewCredential,
  setStatus,
  signCredential,
  statusEntry,
  statusListCredential,
} from './vc.mjs';
import { ed25519FromSeed, testSeed } from './x509.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VC_EXAMPLE_DIR = resolve(here, '../examples/vc');

/// Test keys. `studio2025` was superseded by `studio2026` on 2026-03-01.
export function exampleKeys() {
  const key = (label) => {
    const keys = ed25519FromSeed(testSeed(label));
    return { ...keys, did: didKey(keys.publicKey), verificationMethod: didKeyVerificationMethod(keys.publicKey) };
  };
  return {
    studio2025: key('vc example studio 2025'),
    studio2026: key('vc example studio 2026'),
    board: key('vc example review board'),
    creator: key('vc example creator'),
    stranger: key('vc example stranger'),
  };
}

// Principals in canonical textual form, derived from fixed bytes: a
// self-authenticating principal is 29 bytes ending in 0x02.
const principal = (fill) => encodePrincipal(Buffer.concat([Buffer.alloc(28, fill), Buffer.from([0x02])]));
export const MEMBER = principal(0x11);
export const DELEGATE = principal(0x22);
export const CANISTER = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
export const STATUS_LIST = 'https://studio.example/status/1';
export const MEMBER_STATUS_INDEX = 94567;
export const REVOKED_STATUS_INDEX = 1234;

export function buildExamples() {
  const keys = exampleKeys();
  const membership = signCredential(membershipCredential({
    id: 'urn:uuid:6f0e3c1a-0000-4000-8000-000000000001',
    issuer: keys.studio2026.did,
    validFrom: '2026-04-01T00:00:00Z',
    validUntil: '2027-04-01T00:00:00Z',
    member: MEMBER,
    organization: { name: 'Example Studio' },
    role: 'member',
    registry: { canisterId: CANISTER, creatorId: 1 },
    credentialStatus: statusEntry({ listId: STATUS_LIST, index: MEMBER_STATUS_INDEX }),
  }), { privateKey: keys.studio2026.privateKey, verificationMethod: keys.studio2026.verificationMethod, created: '2026-04-01T00:00:00Z' });

  const delegation = signCredential(delegationCredential({
    id: 'urn:uuid:6f0e3c1a-0000-4000-8000-000000000002',
    issuer: keys.creator.did,
    validFrom: '2026-05-01T00:00:00Z',
    validUntil: '2026-11-01T00:00:00Z',
    delegate: DELEGATE,
    registry: { canisterId: CANISTER, creatorId: 1 },
    delegationId: 1,
    scope: { collection: 1 },
  }), { privateKey: keys.creator.privateKey, verificationMethod: keys.creator.verificationMethod, created: '2026-05-01T00:00:00Z' });

  const review = signCredential(reviewCredential({
    id: 'urn:uuid:6f0e3c1a-0000-4000-8000-000000000003',
    issuer: keys.board.did,
    validFrom: '2026-06-01T00:00:00Z',
    // The digests of protocol/examples/ai-assisted.json and the artifact it
    // describes, so the review is of evidence that exists in this repository.
    record: {
      canisterId: CANISTER,
      recordId: 1,
      artifactHash: '3eabac0a5996ee655269410d496b8c48eb23dd051094bd53aa30c5437a859eb3',
      manifestHash: '273be698ff9d6dbd10e2ac563abae60b14cd439152c153953d22262a6bcddd6b',
    },
    outcome: 'consistent',
    method: 'Recomputed the artifact and manifest digests and checked the commitment against the certified record.',
  }), { privateKey: keys.board.privateKey, verificationMethod: keys.board.verificationMethod, created: '2026-06-01T00:00:00Z' });

  const policy = {
    statusFailure: 'reject',
    issuers: [
      {
        name: 'Example Studio',
        types: ['CreatorMembershipCredential'],
        requireStatus: true,
        keys: [
          { verificationMethod: keys.studio2025.verificationMethod, activeFrom: '2025-01-01T00:00:00Z', retiredAt: '2026-03-01T00:00:00Z', status: 'superseded' },
          { verificationMethod: keys.studio2026.verificationMethod, activeFrom: '2026-03-01T00:00:00Z', retiredAt: null, status: 'active' },
        ],
      },
      {
        name: 'Creator 1 (self-issued delegations)',
        types: ['DelegatedAuthorityCredential'],
        keys: [{ verificationMethod: keys.creator.verificationMethod, activeFrom: '2026-01-01T00:00:00Z', retiredAt: null, status: 'active' }],
      },
      {
        name: 'Example Review Board',
        types: ['ProvenanceReviewCredential'],
        keys: [{ verificationMethod: keys.board.verificationMethod, activeFrom: '2026-01-01T00:00:00Z', retiredAt: null, status: 'active' }],
      },
    ],
  };
  return { keys, membership, delegation, review, policy };
}

export function buildStatusList() {
  const keys = exampleKeys();
  const bits = setStatus(emptyStatusList(), REVOKED_STATUS_INDEX);
  return signCredential(statusListCredential({
    id: STATUS_LIST,
    issuer: keys.studio2026.did,
    validFrom: '2026-04-01T00:00:00Z',
    statusPurpose: 'revocation',
    bits,
  }), { privateKey: keys.studio2026.privateKey, verificationMethod: keys.studio2026.verificationMethod, created: '2026-04-01T00:00:00Z' });
}

export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { membership, delegation, review, policy } = buildExamples();
  const files = { 'membership.json': membership, 'delegation.json': delegation, 'review.json': review, 'policy.json': policy };
  if (process.argv.includes('--status')) files['status-list.json'] = buildStatusList();
  for (const [name, value] of Object.entries(files)) await writeFile(resolve(VC_EXAMPLE_DIR, name), json(value));
  console.log(VC_EXAMPLE_DIR);
}
