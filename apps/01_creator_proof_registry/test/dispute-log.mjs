// The dispute event log of `backend/src/DisputeLog.mo` and `Dispute.mo`, in
// JavaScript: the reader's side of issue #8.
//
// A dispute export is only worth something if a reader can check it without
// trusting whoever handed it over. So this file does what a verifier has to do,
// independently of the canister:
//
//   1. re-encode every event and recompute the hash chain to its head,
//   2. replay the events into a dispute and compare that with the dispute the
//      canister served — the state has to be a function of the log,
//   3. check the record digest and the log head against one certificate,
//   4. describe the result in words that report process, never a verdict.
//
// The encoding is written from `docs/DISPUTES.md`, not from the Motoko source,
// for the same reason `record-digest.mjs` exists: a reader that asked the
// canister for the hash would be verifying nothing. The replica suite compares
// the two implementations on every event it produces.

import { createHash } from 'node:crypto';

import { recordDigest, recordPath, short, text, u32, u64 } from './record-digest.mjs';

const DOMAIN = 'icp-creator-proof:dispute-event:v1';
export const EXPORT_FORMAT = 'icp-creator-proof:dispute-export:v1';

export const GENESIS_PREV = new Uint8Array(32);

/// `Dispute.responseWindowNanos`, which `respondBy` is derived from.
export const RESPONSE_WINDOW_NANOS = 14n * 86_400n * 1_000_000_000n;

const GROUND = { authorship: 0, priorCreation: 1, undisclosedDerivation: 2, aiDisclosure: 3, licensing: 4, other: 5 };
const STANCE = { contest: 0, concede: 1, partial: 2 };
const OUTCOME = { upheld: 0, rejected: 1, settled: 2, dismissed: 3, abusive: 4 };
const PARTY = { claimant: 0, respondent: 1 };

export class DisputeLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisputeLogError';
  }
}

const tagOf = (variant) => Object.keys(variant)[0];
const byte = (value) => Buffer.from([value]);
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function tag(table, variant, what) {
  const name = tagOf(variant);
  if (!(name in table)) throw new DisputeLogError(`unknown ${what} ${name}`);
  return byte(table[name]);
}

function evidence(item) {
  const parts = [Buffer.from(item.digest)];
  const kind = tagOf(item.locator);
  if (kind === 'uri') {
    parts.push(byte(0), text(item.locator.uri));
  } else if (kind === 'sealed') {
    parts.push(byte(1), text(item.locator.sealed.custodian));
  } else {
    throw new DisputeLogError(`unknown locator ${kind}`);
  }
  parts.push(text(item.description));
  return Buffer.concat(parts);
}

const evidenceList = (list) => Buffer.concat([u32(list.length), ...list.map(evidence)]);

/// A present-flag, as everywhere in these layouts, so absent and empty differ.
const optional = (value, encode) => (value.length === 0 ? byte(0) : Buffer.concat([byte(1), encode(value[0])]));

/// Every field of the event except `hash`, which is computed from these bytes.
export function encodeEvent(event) {
  const parts = [
    Buffer.from(DOMAIN, 'utf8'),
    byte(0),
    Buffer.from(event.prev),
    u64(event.dispute),
    u64(event.seq),
    u64(event.at),
    short(event.by.toUint8Array()),
  ];
  const kind = tagOf(event.action);
  const action = event.action[kind];
  switch (kind) {
    case 'filed':
      parts.push(
        byte(0),
        u64(action.record),
        tag(GROUND, action.ground, 'ground'),
        text(action.statement),
        optional(action.counterRecord, u64),
        evidenceList(action.evidence),
      );
      break;
    case 'responded':
      parts.push(byte(1), tag(STANCE, action.stance, 'stance'), text(action.statement), evidenceList(action.evidence));
      break;
    case 'evidenceAdded':
      parts.push(byte(2), tag(PARTY, action.party, 'party'), evidenceList(action.evidence));
      break;
    case 'determined':
      parts.push(
        byte(3),
        tag(OUTCOME, action.outcome, 'outcome'),
        text(action.summary),
        optional(action.decision, evidence),
        u64(action.round),
      );
      break;
    case 'appealed':
      parts.push(
        byte(4),
        tag(PARTY, action.party, 'party'),
        text(action.statement),
        evidenceList(action.evidence),
        u64(action.round),
      );
      break;
    case 'withdrawn':
      parts.push(byte(5), text(action.reason));
      break;
    default:
      throw new DisputeLogError(`unknown action ${kind}`);
  }
  return Buffer.concat(parts);
}

export function eventHash(event) {
  return new Uint8Array(createHash('sha256').update(encodeEvent(event)).digest());
}

/// Recomputes the chain and returns its head. Throws `DisputeLogError` naming
/// the first event that does not fit, because "the log is corrupt" does not
/// tell an auditor where to look.
export function verifyChain(disputeId, events) {
  if (events.length === 0) throw new DisputeLogError('a dispute log cannot be empty');
  let prev = GENESIS_PREV;
  events.forEach((event, index) => {
    if (BigInt(event.dispute) !== BigInt(disputeId)) {
      throw new DisputeLogError(`event ${index} belongs to dispute ${event.dispute}, not ${disputeId}`);
    }
    if (BigInt(event.seq) !== BigInt(index)) {
      throw new DisputeLogError(`event ${index} carries sequence number ${event.seq}`);
    }
    if (!same(event.prev, prev)) {
      throw new DisputeLogError(`event ${index} does not link to the event before it`);
    }
    if (!same(eventHash(event), event.hash)) {
      throw new DisputeLogError(`event ${index} does not hash to the value it carries`);
    }
    prev = event.hash;
  });
  return new Uint8Array(prev);
}

/// The dispute the log describes, rebuilt from nothing but the events. Mirrors
/// `Dispute.genesis` and `Dispute.apply`, reduced to what a verifier compares.
export function replay(events) {
  let state = null;
  for (const event of events) {
    const kind = tagOf(event.action);
    const action = event.action[kind];
    if (state === null) {
      if (kind !== 'filed') throw new DisputeLogError('a dispute log must begin with #filed');
      state = {
        id: BigInt(event.dispute),
        record: BigInt(action.record),
        claimant: event.by.toText(),
        ground: tagOf(action.ground),
        filedAt: BigInt(event.at),
        respondBy: BigInt(event.at) + RESPONSE_WINDOW_NANOS,
        evidence: action.evidence.length,
        response: null,
        determinations: [],
        appeals: [],
        round: 0n,
        status: 'open',
        events: 0n,
        head: null,
      };
    } else {
      switch (kind) {
        case 'filed':
          throw new DisputeLogError('#filed may only open a dispute');
        case 'responded':
          state.response = { by: event.by.toText(), stance: tagOf(action.stance), at: BigInt(event.at) };
          state.evidence += action.evidence.length;
          state.status = 'responded';
          break;
        case 'evidenceAdded':
          state.evidence += action.evidence.length;
          break;
        case 'determined':
          state.determinations.push({
            authority: event.by.toText(),
            outcome: tagOf(action.outcome),
            round: BigInt(action.round),
            at: BigInt(event.at),
          });
          state.status = 'determined';
          break;
        case 'appealed':
          state.appeals.push({ by: event.by.toText(), party: tagOf(action.party), round: BigInt(action.round) });
          state.evidence += action.evidence.length;
          state.round = BigInt(action.round);
          state.status = 'appealed';
          break;
        case 'withdrawn':
          state.status = 'withdrawn';
          break;
        default:
          throw new DisputeLogError(`unknown action ${kind}`);
      }
    }
    state.events += 1n;
    state.head = event.hash;
  }
  return state;
}

/// Throws unless the served dispute is exactly what its own log replays to.
export function assertConsistent(dispute, events) {
  const replayed = replay(events);
  const mismatch = (field) => {
    throw new DisputeLogError(`the served dispute disagrees with its log on ${field}`);
  };
  if (BigInt(dispute.id) !== replayed.id) mismatch('id');
  if (BigInt(dispute.record) !== replayed.record) mismatch('record');
  if (dispute.claimant.toText() !== replayed.claimant) mismatch('claimant');
  if (tagOf(dispute.ground) !== replayed.ground) mismatch('ground');
  if (BigInt(dispute.filedAt) !== replayed.filedAt) mismatch('filedAt');
  if (BigInt(dispute.respondBy) !== replayed.respondBy) mismatch('respondBy');
  if (dispute.evidence.length !== replayed.evidence) mismatch('evidence');
  if ((dispute.response.length === 1) !== (replayed.response !== null)) mismatch('response');
  if (dispute.response.length === 1 && tagOf(dispute.response[0].stance) !== replayed.response.stance) {
    mismatch('response stance');
  }
  if (dispute.determinations.length !== replayed.determinations.length) mismatch('determinations');
  dispute.determinations.forEach((determination, index) => {
    const expected = replayed.determinations[index];
    if (
      determination.authority.toText() !== expected.authority ||
      tagOf(determination.outcome) !== expected.outcome ||
      BigInt(determination.round) !== expected.round ||
      BigInt(determination.at) !== expected.at
    ) {
      mismatch(`determination ${index}`);
    }
  });
  if (dispute.appeals.length !== replayed.appeals.length) mismatch('appeals');
  if (BigInt(dispute.round) !== replayed.round) mismatch('round');
  if (tagOf(dispute.status) !== replayed.status) mismatch('status');
  if (BigInt(dispute.events) !== replayed.events) mismatch('event count');
  if (!same(dispute.head, replayed.head)) mismatch('head');
  return replayed;
}

/// The tree key a dispute's log head lives under: `["dispute", id as u64 BE]`.
export const disputePath = (id) => [Buffer.from('dispute', 'utf8'), u64(id)];

/// Verifies a `DisputeExport` end to end. `verifyCertifiedValue` is injected so
/// this file has no dependency on the agent library and runs anywhere Node does.
export async function verifyExport(bundle, { rootKey, verifyCertifiedValue }) {
  if (bundle.format !== EXPORT_FORMAT) throw new DisputeLogError(`unsupported export format ${bundle.format}`);
  const head = verifyChain(bundle.dispute.id, bundle.events);
  assertConsistent(bundle.dispute, bundle.events);
  if (BigInt(bundle.dispute.record) !== BigInt(bundle.record.id)) {
    throw new DisputeLogError('the export pairs a dispute with a different record');
  }
  const certified = (path) =>
    verifyCertifiedValue({
      certificate: bundle.certificate,
      witness: bundle.witness,
      canisterId: bundle.canister,
      rootKey,
      path,
    });
  if (!same(await certified(recordPath(bundle.record.id)), recordDigest(bundle.record))) {
    throw new DisputeLogError('the certified record digest does not match the exported record');
  }
  if (!same(await certified(disputePath(bundle.dispute.id)), head)) {
    throw new DisputeLogError('the certified log head does not match the exported events');
  }
  return head;
}

// ------------------------------------------------------------ what to say

/// The sentence every rendering carries. It is the product decision of #8 in
/// one line: the registry reports a process and names who concluded what.
export const DISCLAIMER =
  'Determinations are statements by the named authorities under their published policies. ' +
  'This registry records them; it does not decide authorship, originality or rights, ' +
  'and a dispute never changes the record itself.';

const PROCESS = {
  open: 'unresolved — awaiting the respondent',
  responded: 'unresolved — answered, awaiting a determination',
  appealed: 'unresolved — appealed, awaiting a determination',
  determined: 'determined',
  withdrawn: 'withdrawn by the claimant',
};

/// A verifier-facing report of one dispute. Structured first, so a UI can lay
/// it out; `render` turns it into text.
export function describe({ record, dispute, authorities = [] }) {
  const names = new Map(authorities.map((authority) => [authority.id.toText(), authority]));
  const round = BigInt(dispute.round);
  const current = dispute.determinations.filter((determination) => BigInt(determination.round) === round);
  const outcomes = new Set(current.map((determination) => tagOf(determination.outcome)));
  const status = tagOf(dispute.status);
  return {
    record: BigInt(record.id),
    // What the owner did to the record. Reported beside the dispute and never
    // derived from it.
    technicalStatus: tagOf(record.status),
    dispute: BigInt(dispute.id),
    ground: tagOf(dispute.ground),
    process: status,
    unresolved: status === 'open' || status === 'responded' || status === 'appealed',
    round,
    response: dispute.response.length === 1 ? tagOf(dispute.response[0].stance) : null,
    determinations: current.map((determination) => {
      const authority = names.get(determination.authority.toText());
      return {
        authority: determination.authority.toText(),
        name: authority ? authority.name : null,
        policyUri: authority ? authority.policyUri : null,
        outcome: tagOf(determination.outcome),
      };
    }),
    conflicting: outcomes.size > 1,
  };
}

export function render(report) {
  const lines = [
    `Record ${report.record}: ${report.technicalStatus} (as set by its owner).`,
    `Counterclaim ${report.dispute} (${report.ground}): ${PROCESS[report.process]}.`,
  ];
  if (report.response) lines.push(`The respondent's answer: ${report.response}.`);
  for (const determination of report.determinations) {
    const who = determination.name ?? `unlisted authority ${determination.authority}`;
    const policy = determination.policyUri ? ` under ${determination.policyUri}` : '';
    lines.push(`${who} recorded "${determination.outcome}"${policy}.`);
  }
  if (report.conflicting) {
    lines.push('The authorities disagree. The registry does not choose between them.');
  }
  if (report.round > 0n) lines.push(`This is round ${report.round}, after appeal.`);
  lines.push(DISCLAIMER);
  return lines.join('\n');
}
