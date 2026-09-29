#!/usr/bin/env node
// The claims of docs/29_OBSERVABILITY.md, checked against the model.
//
//   node tools/observability/model.test.mjs
//
// Offline, dependency-free and deterministic: every clock tick is a number, so
// an alert's whole life — pending, firing, coalesced, suppressed, resolved — is
// replayed exactly and a failure names the step it happened on.

import { readFileSync } from 'node:fs';

import {
  AlertManager,
  annotationFinding,
  clusterSignal,
  cycleRunwayDays,
  DAY_SECONDS,
  deploymentAnnotation,
  thresholdState,
  unresolvedCritical,
} from './model.mjs';

const alerts = JSON.parse(
  readFileSync(new URL('../../observability/alerts.json', import.meta.url), 'utf8'),
);

let checks = 0;
function ok(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

/// A manager with the reviewed rules, a storm guard high enough to stay out of
/// the way, and a clock the test drives.
const manager = (options = {}) =>
  new AlertManager(alerts.alerts, alerts.routes, {
    storm: { maxPerWindow: 1000, windowSeconds: 60 },
    ...options,
  });

/// The notifications for one rule, in order.
const fired = (m, rule) => m.notifications.filter((n) => n.rule === rule);

// -------------------------------------------------------- threshold and runway
{
  ok(thresholdState({ comparator: 'below', warning: 30, critical: 7 }, 6) === 'critical', 'below: under the critical line is critical');
  ok(thresholdState({ comparator: 'below', warning: 30, critical: 7 }, 10) === 'warning', 'below: between the lines is a warning');
  ok(thresholdState({ comparator: 'below', warning: 30, critical: 7 }, 40) === 'ok', 'below: above the warning line is ok');
  ok(thresholdState({ comparator: 'above', warning: 60, critical: 600 }, 600) === 'warning', 'above: the critical line is not yet critical (strictly greater)');
  ok(thresholdState({ comparator: 'above', warning: 60, critical: 600 }, 601) === 'critical', 'above: past the critical line is critical');
  ok(thresholdState({ comparator: 'is_true', warning: true, critical: true }, false) === 'ok', 'is_true: false is ok');
  ok(thresholdState({ comparator: 'is_true', warning: true, critical: true }, true) === 'critical', 'is_true: true is critical');

  const burn = 1_000_000_000; // cycles per second
  ok(Math.abs(cycleRunwayDays(10 * burn * DAY_SECONDS, burn) - 10) < 1e-9, '10 days of cycles at the current burn is a 10 day runway');
  ok(cycleRunwayDays(1000, 0) === Infinity, 'a canister that is not burning has an unbounded runway, not a zero one');
  ok(cycleRunwayDays(0, burn) === 0, 'no cycles is no runway');
  let threw = false;
  try { cycleRunwayDays(-1, burn); } catch { threw = true; }
  ok(threw, 'a negative balance is refused rather than projected');
}

// ------------------------------------- the cycle runway alert fires in a test
{
  const m = manager();
  // 10 days: a warning, below 30. Pending until it survives for_seconds (300).
  ok(m.observe({ ruleId: 'cycle-runway', scope: 'app-01', value: 10, at: 0 }) === 'pending', 'a warning starts pending, it does not page on the first sample');
  ok(fired(m, 'cycle-runway').length === 0, 'nothing is sent while the alert is pending');
  ok(m.observe({ ruleId: 'cycle-runway', scope: 'app-01', value: 10, at: 300 }) === 'firing', 'the alert fires once the breach outlasts for_seconds');
  ok(fired(m, 'cycle-runway').length === 1 && fired(m, 'cycle-runway')[0].severity === 'warning', 'the first page is a warning');
  // 5 days: under 7, an escalation of the same alert.
  ok(m.observe({ ruleId: 'cycle-runway', scope: 'app-01', value: 5, at: 400 }) === 'firing', 'the alert keeps firing as the runway shrinks');
  const pages = fired(m, 'cycle-runway');
  ok(pages.length === 2 && pages[1].severity === 'critical', 'crossing the critical line escalates, it does not wait for the repeat interval');
  ok(pages[1].runbook === 'docs/07_OPERATIONS_RUNBOOK.md#cycle-runway', 'the critical page carries the runbook anchor');
  ok(unresolvedCritical(m.notifications).length === 0, 'every critical notification has a runbook');
}

// -------------------------------------- pending payment and index lag are visible
{
  const m = manager();
  m.observe({ ruleId: 'pending-payment-age', scope: 'app-03', value: 2400, at: 0 });
  m.observe({ ruleId: 'index-lag', scope: 'index', value: 900, at: 0 });
  m.observe({ ruleId: 'pending-payment-age', scope: 'app-03', value: 2400, at: 60 });
  m.observe({ ruleId: 'index-lag', scope: 'index', value: 900, at: 60 });
  ok(fired(m, 'pending-payment-age')[0]?.severity === 'critical', 'an old pending payment is visible as a critical alert');
  ok(fired(m, 'index-lag')[0]?.severity === 'critical', 'index lag is visible as a critical alert');
  const report = m.notifications.map((n) => n.rule).sort();
  ok(report.join() === 'index-lag,pending-payment-age', 'the page names both the payment queue and the index, not just "something is wrong"');
}

// -------------------------------------------- a deployment annotation is recorded
{
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const annotation = deploymentAnnotation({ canister: 'app-01', moduleHash: hashA, version: 'v2026.09.25', at: 1, by: 'release-bot' });
  ok(annotation.moduleHash === hashA && annotation.version === 'v2026.09.25', 'a deployment annotation binds the canister, version, module hash, time and author');
  let threw = false;
  try { deploymentAnnotation({ canister: 'app-01', moduleHash: 'nope', version: 'v', at: 1, by: 'x' }); } catch { threw = true; }
  ok(threw, 'an annotation without a full module hash is refused');
  ok(annotationFinding(null, hashA, annotation) === null, 'the first deployment with an annotation is explained');
  ok(annotationFinding(hashA, hashB, null)?.rule === 'deployment-annotation', 'a module hash change without an annotation is a finding');
  ok(annotationFinding(hashA, hashB, annotation)?.rule === 'deployment-annotation', 'an annotation that does not match the running bytes is a finding');

  const m = manager();
  m.observe({ ruleId: 'deployment-annotation', scope: 'app-01', value: true, at: 0 });
  ok(fired(m, 'deployment-annotation').length === 1, 'an unexplained module hash change raises the deployment-annotation alert');
  ok(fired(m, 'deployment-annotation')[0].route === 'ticket', 'it is a ticket, not a page: a missing annotation is not an outage');
}

// --------------------------------------- the metrics backend is unavailable
{
  const m = manager();
  ok(m.gap('scrape', 0) === 'critical', 'a scrape that stops is an alert, not silence');
  ok(m.stateOf('telemetry-gap', 'scrape') === 'firing', 'the gap is firing');
  const page = m.notifications.find((n) => n.rule === 'telemetry-gap');
  ok(page && page.severity === 'critical' && page.runbook, 'the gap pages as critical and carries its runbook');
  // A signal nobody reported is unknown, never ok. The manager has no sample for
  // app-01 at all, so it must not answer "healthy".
  ok(m.stateOf('cycle-runway', 'app-01') === 'unknown', 'a signal with no sample is unknown, never ok');
  m.gap('scrape', 10);
  ok(fired(m, 'telemetry-gap').length === 1, 'a gap lasting many scrapes pages once, not once per scrape');
  m.resume('scrape', 20);
  ok(m.stateOf('telemetry-gap', 'scrape') === 'unknown' && fired(m, 'telemetry-gap').some((n) => n.severity === 'ok'),
    'the gap resolves when the backend answers again');

  const overShards = new Map([['s1', null], ['s2', 10]]);
  const signal = clusterSignal('sum', overShards);
  ok(signal.value === 10 && signal.missing.join() === 's1',
    'a shard that did not report is returned as missing, not folded in as a zero');
  ok(clusterSignal('max', new Map([['s1', null], ['s2', null]])).value === null,
    'a signal no shard reported has no value, so it cannot be read as healthy');
}

// --------------------------------------------------------------- an alert storm
{
  const m = manager({ storm: { maxPerWindow: 3, windowSeconds: 60 } });
  // Six distinct canisters cross the critical line at once. for_seconds is 300,
  // so each is driven to firing with a second sample at t=300.
  for (let i = 0; i < 6; i += 1) m.observe({ ruleId: 'cycle-runway', scope: `canister-${i}`, value: 1, at: 0 });
  for (let i = 0; i < 6; i += 1) m.observe({ ruleId: 'cycle-runway', scope: `canister-${i}`, value: 1, at: 300 });
  ok(m.notifications.length === 3, 'only maxPerWindow distinct alerts page inside the window');
  ok(m.events.filter((e) => e.suppressed).length === 3, 'the alerts past the cap are recorded as suppressed, not dropped');
  // A further sample of the same alert inside its repeat interval is coalesced,
  // so a signal that keeps breaching does not page again.
  m.observe({ ruleId: 'cycle-runway', scope: 'canister-0', value: 1, at: 400 });
  ok(m.events.some((e) => e.coalesced), 'a repeat of a firing alert inside its repeat interval is coalesced, not re-paged');
}

// --------------------------------------------------------- a false positive
{
  const m = manager();
  // One 2% burst, then clean: it must never page.
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-01', value: 0.02, at: 0 });
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-01', value: 0, at: 100 });
  ok(fired(m, 'failed-update-rate').length === 0, 'a burst shorter than for_seconds is not a page');

  // A real alert, then brief recovery, then sustained recovery.
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-02', value: 0.02, at: 0 });
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-02', value: 0.02, at: 300 });
  ok(fired(m, 'failed-update-rate').length === 1, 'a sustained breach pages once');
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-02', value: 0, at: 400 });
  ok(fired(m, 'failed-update-rate').length === 1, 'a brief recovery inside clear_seconds does not resolve the alert');
  m.observe({ ruleId: 'failed-update-rate', scope: 'app-02', value: 0, at: 1300 });
  const pages = fired(m, 'failed-update-rate');
  ok(pages.length === 2 && pages[1].severity === 'ok', 'a sustained recovery resolves the alert, and the resolve is not coalesced');
}

// ------------------------------------------------- multi-shard aggregation
{
  // Summing three shards' balances is the cluster balance; a rate is never
  // summed (three shards at 4% are not 12%), and lag takes the worst shard.
  const balance = clusterSignal('sum', new Map([['s1', 100], ['s2', 200], ['s3', 300]]));
  ok(balance.value === 600 && balance.missing.length === 0, 'counts and balances aggregate by sum');
  const rate = clusterSignal('max', new Map([['s1', 0.04], ['s2', 0.01], ['s3', 0.0]]));
  ok(rate.value === 0.04, 'a rate aggregates by max, not by sum');
  const lag = clusterSignal('max', new Map([['s1', 5], ['s2', 700], ['s3', 0]]));
  ok(lag.value === 700, 'index lag takes the worst shard');

  // A silent shard is a gap against that shard, and a critical shard-silent
  // alert — the same rule the sharding index applies to a missing high-water
  // mark (#23).
  const m = manager();
  const { value, missing } = clusterSignal('sum', new Map([['s1', 100], ['s2', null]]));
  ok(value === 100 && missing.join() === 's2', 'the aggregate is over the shards that reported');
  if (missing.length) m.observe({ ruleId: 'shard-silent', scope: missing[0], value: true, at: 0 });
  const page = fired(m, 'shard-silent')[0];
  ok(page && page.severity === 'critical' && page.runbook.endsWith('#silent-shard'), 'a silent shard pages with the silent-shard runbook');
}

// ------------------------------------------------ every rule is coherent
{
  for (const rule of alerts.alerts) {
    ok(alerts.routes[rule.route], `${rule.id}: routes to a known route`);
    if (rule.critical !== false) ok(typeof rule.runbook === 'string' && rule.runbook.includes('#'), `${rule.id}: a critical rule has a runbook anchor`);
    ok(Number.isFinite(rule.for_seconds) && Number.isFinite(rule.clear_seconds) && rule.repeat_seconds > 0, `${rule.id}: has for/clear/repeat timings`);
  }
  const referenced = new Set(alerts.alerts.map((rule) => rule.signal));
  for (const signal of Object.keys(alerts.signals)) {
    ok(referenced.has(signal) || signal in alerts.recorded_only, `${signal}: is either alerted on or recorded-only with a reason`);
  }
}

console.log(`\nobservability model: ${checks} checks passed`);
