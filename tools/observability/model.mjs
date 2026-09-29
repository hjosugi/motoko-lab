// An executable model of the observability design in
// docs/29_OBSERVABILITY.md (#24).
//
// A metrics and alerting design is mostly claims about time: an alert that must
// not page on one bad sample, a backend that goes quiet and must not read as
// healthy, a storm of distinct alerts that must not page a human for each, a
// cluster whose totals are only meaningful once every shard has reported. Those
// claims are cheap to state and easy to get wrong, so this model makes them
// executable. It is not a monitoring system: every clock is a number the test
// advances, so an alert's whole life — pending, firing, coalesced, resolved —
// can be replayed exactly.
//
// The pieces mirror the design one to one:
//
//   rules       the reviewed alert inventory (observability/alerts.json)
//   threshold   a sample -> ok | warning | critical
//   AlertManager  pending/for-duration, clear-hysteresis, dedup, storm guard
//   aggregate   per-shard samples -> one cluster value, or a gap
//
// Nothing here talks to a metrics backend. run_offline_checks.sh runs the test
// offline, and scripts/check_observability.py validates the rules themselves
// against the runbook.

export const DAY_SECONDS = 86400;

/// How long a balance lasts at a burn rate, in days. The runway is the signal
/// a cycles alert is really about: a balance alone says nothing about when it
/// runs out, and a burn rate alone says nothing about when. A canister that is
/// not burning (burn <= 0) has an unbounded runway, not a zero one.
export function cycleRunwayDays(balance, burnPerSecond) {
  if (!Number.isFinite(balance) || balance < 0) throw new Error('balance must be a non-negative number');
  if (!Number.isFinite(burnPerSecond)) throw new Error('burn must be a number');
  if (burnPerSecond <= 0) return Infinity;
  return balance / burnPerSecond / DAY_SECONDS;
}

/// One sample against one rule. `below` is for signals where less is worse
/// (a runway); `above` for signals where more is worse (lag, a rate); `is_true`
/// for an event that is an alert on its own (a failed smoke test, a gap).
export function thresholdState(rule, value) {
  switch (rule.comparator) {
    case 'below':
      if (value < rule.critical) return 'critical';
      if (value < rule.warning) return 'warning';
      return 'ok';
    case 'above':
      if (value > rule.critical) return 'critical';
      if (value > rule.warning) return 'warning';
      return 'ok';
    case 'is_true':
      return value ? 'critical' : 'ok';
    default:
      throw new Error(`unknown comparator ${rule.comparator}`);
  }
}

export const fingerprint = (rule, scope) => `${rule.id}:${scope ?? ''}`;

/// Combines the same signal from several canisters or shards. A missing value
/// is never a zero: `aggregate` over nothing returns null, which the caller
/// must treat as a gap. Summing a rate would be wrong (three shards at 4% are
/// not 12%), and taking the max of a count would hide growth, so each rule
/// names its own aggregate.
export function aggregate(kind, values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  switch (kind) {
    case 'sum':
      return numbers.reduce((a, b) => a + b, 0);
    case 'max':
      return Math.max(...numbers);
    case 'min':
      return Math.min(...numbers);
    case 'last':
      return numbers[numbers.length - 1];
    default:
      throw new Error(`unknown aggregate ${kind}`);
  }
}

/// One signal over a set of shards: the aggregate and which shards were silent.
/// A silent shard is returned, not folded in as a zero — the same rule as the
/// sharding index's high-water mark (#23). `samplesByShard` is a Map so the
/// caller enumerates every shard it expects to hear from.
export function clusterSignal(kind, samplesByShard) {
  const present = [];
  const missing = [];
  for (const [shard, value] of samplesByShard) {
    if (value == null || !Number.isFinite(value)) missing.push(shard);
    else present.push(value);
  }
  return { value: aggregate(kind, present), missing };
}

/// A deployment is recorded so an alert can say what was running when it fired.
/// The module hash is required and must be a full SHA-256: an annotation that
/// cannot be tied to the bytes on the canister is not evidence.
export function deploymentAnnotation({ canister, moduleHash, version, at, by, note = '' }) {
  if (!canister) throw new Error('canister is required');
  if (!version) throw new Error('version is required');
  if (!by) throw new Error('by is required');
  if (!/^[0-9a-f]{64}$/.test(moduleHash ?? '')) {
    throw new Error('moduleHash must be 64 lowercase hex characters');
  }
  return { kind: 'deployment', canister, moduleHash, version, at, by, note };
}

/// Whether a module-hash change was explained. Returns null when the annotation
/// is present and matches the running bytes, or a finding the manager can raise.
export function annotationFinding(previousHash, currentHash, annotation) {
  if (previousHash === currentHash) return null;
  if (!annotation) return { rule: 'deployment-annotation', reason: 'module hash changed without a deployment annotation' };
  if (annotation.moduleHash !== currentHash) {
    return { rule: 'deployment-annotation', reason: 'the deployment annotation does not match the running module hash' };
  }
  return null;
}

function buildRules(rules, routes) {
  const map = new Map();
  for (const rule of rules) {
    if (map.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
    if (!routes[rule.route]) throw new Error(`rule ${rule.id} routes to unknown route ${rule.route}`);
    // Every critical alert has to link somewhere a responder can act on, so a
    // rule without a runbook is refused when the manager is built rather than
    // when it pages someone at 3am.
    const criticalFires = rule.critical !== false && rule.critical !== undefined;
    if (criticalFires && !rule.runbook) throw new Error(`critical rule ${rule.id} has no runbook`);
    map.set(rule.id, rule);
  }
  return map;
}

/// Turns samples into alerts. Every decision is a function of the sample time,
/// so a test can advance the clock instead of sleeping.
export class AlertManager {
  constructor(rules, routes, options = {}) {
    this.rules = buildRules(rules, routes);
    this.routes = routes;
    this.storm = options.storm ?? { maxPerWindow: 5, windowSeconds: 60 };
    this.states = new Map();
    this.notifications = []; // what a responder is paged with
    this.events = []; // everything, including coalesced and storm-suppressed
    this.gaps = new Map(); // source -> the time it went quiet
  }

  rule(id) {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`no rule ${id}`);
    return rule;
  }

  /// Feeds one sample. Returns the rule's state after it.
  observe({ ruleId, scope = '', value, at }) {
    const rule = this.rule(ruleId);
    const key = fingerprint(rule, scope);
    const state = this.states.get(key)
      ?? { status: 'ok', since: at, clearSince: null, lastNotify: -Infinity, severity: 'ok' };
    const severity = thresholdState(rule, value);

    if (severity === 'ok') {
      if (state.status === 'firing') {
        // Clear hysteresis: brief recoveries below the critical line do not
        // resolve an alert, so a signal flapping across the line is one alert.
        if (state.clearSince === null) state.clearSince = at;
        if (at - state.clearSince >= rule.clear_seconds) {
          state.status = 'ok';
          state.severity = 'ok';
          state.clearSince = null;
          this.#emit(rule, state, key, scope, 'ok', at, 'resolution');
        }
      } else {
        state.status = 'ok';
        state.severity = 'ok';
        state.clearSince = null;
      }
    } else {
      state.clearSince = null;
      if (state.status === 'ok') {
        // For-duration: a breach starts a pending state; it becomes an alert
        // only if it survives rule.for_seconds. One bad sample is not a page.
        state.status = 'pending';
        state.since = at;
        state.severity = severity;
        if (rule.for_seconds === 0) {
          // An event that is an alert on its own (a gap, a failed smoke test)
          // has nothing to wait for.
          state.status = 'firing';
          this.#emit(rule, state, key, scope, severity, at, 'firing');
        }
      } else if (state.status === 'pending') {
        state.severity = severity;
        if (at - state.since >= rule.for_seconds) {
          state.status = 'firing';
          this.#emit(rule, state, key, scope, severity, at, 'firing');
        }
      } else if (severity === 'critical' && state.severity !== 'critical') {
        state.severity = 'critical';
        this.#emit(rule, state, key, scope, 'critical', at, 'escalation');
      } else if (at - state.lastNotify >= rule.repeat_seconds) {
        // Still firing, past the repeat interval: remind.
        this.#emit(rule, state, key, scope, severity, at, 'firing');
      } else {
        // Still firing, inside the repeat interval: record the sample but do
        // not page again.
        this.#emit(rule, state, key, scope, severity, at, 'repeat');
      }
    }
    this.states.set(key, state);
    return state.status;
  }

  /// A metrics backend or a shard stopped reporting. This is itself an alert,
  /// never an absence of alerts: a monitor that cannot see is not a monitor
  /// that sees nothing wrong.
  gap(source, at) {
    if (!this.gaps.has(source)) {
      this.gaps.set(source, at);
      const rule = this.rule('telemetry-gap');
      const key = fingerprint(rule, source);
      this.#emit(rule, { lastNotify: -Infinity }, key, source, 'critical', at, 'firing');
    }
    return 'critical';
  }

  /// The backend answered again. The gap resolves like any other alert.
  resume(source, at) {
    if (this.gaps.has(source)) {
      this.gaps.delete(source);
      const rule = this.rule('telemetry-gap');
      const key = fingerprint(rule, source);
      this.#emit(rule, { lastNotify: -Infinity }, key, source, 'ok', at, 'resolution');
    }
  }

  stateOf(ruleId, scope = '') {
    if (this.gaps.has(scope) && ruleId === 'telemetry-gap') return 'firing';
    return this.states.get(fingerprint(this.rule(ruleId), scope))?.status ?? 'unknown';
  }

  #emit(rule, state, key, scope, severity, at, reason = 'repeat') {
    const event = {
      rule: rule.id,
      scope,
      severity,
      at,
      route: rule.route,
      runbook: severity === 'ok' ? null : rule.runbook,
      fingerprint: key,
      reason,
      coalesced: false,
      suppressed: false,
    };
    // A repeat inside the repeat interval is recorded but not paged: a signal
    // that keeps breaching is one incident, not one page per sample.
    if (reason === 'repeat') {
      event.coalesced = true;
      this.events.push(event);
      return;
    }
    // Storm guard: once maxPerWindow alerts page inside the window, individual
    // pages stop and one summary stands in for them. Resolutions are not
    // suppressed — an all-clear is never part of a storm. The suppressed events
    // are still recorded.
    if (severity !== 'ok') {
      const recent = this.notifications.filter((n) => at - n.at <= this.storm.windowSeconds);
      if (recent.length >= this.storm.maxPerWindow) {
        event.suppressed = true;
        this.events.push(event);
        return;
      }
    }
    // The repeat interval is measured from the last page, not the last sample,
    // so frequent samples cannot push a reminder out forever.
    state.lastNotify = at;
    this.events.push(event);
    this.notifications.push(event);
  }
}

/// Every critical notification must carry a runbook, and every runbook is a
/// link into the operations runbook. The checker validates that the anchor
/// exists; the model validates the invariant that it is there at all.
export function unresolvedCritical(notifications) {
  return notifications.filter((n) => n.severity === 'critical' && !n.runbook);
}
