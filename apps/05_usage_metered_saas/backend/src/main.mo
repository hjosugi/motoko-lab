import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Array "mo:core/Array";
import Billing "Billing";
import Error "mo:core/Error";
import Icrc3 "Icrc3";
import List "mo:core/List";
import Principal "mo:core/Principal";
import Receipt "Receipt";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor UsageMeteredSaaS {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    #quotaExceeded : { quota : Nat; used : Nat; requested : Nat };
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type Plan = {
    name : Text;
    quota : Nat;
    periodSeconds : Nat;
    priceMinorUnits : Nat;
    currency : Text;
  };
  public type Tenant = {
    principal : Principal;
    displayName : Text;
    plan : Plan;
    used : Nat;
    periodStartedAt : Nat;
    enabled : Bool;
    createdAt : Nat;
  };
  public type ApiKeyRecord = {
    hash : Blob;
    tenant : Principal;
    keyLabel : Text;
    createdAt : Nat;
    revokedAt : ?Nat;
  };
  public type UsageEvent = {
    id : Nat;
    tenant : Principal;
    units : Nat;
    category : Text;
    idempotencyKey : Text;
    recordedBy : Principal;
    recordedAt : Nat;
  };
  public type TenantInput = { principal : Principal; displayName : Text; plan : Plan };
  public type UsageInput = { tenant : Principal; units : Nat; category : Text; idempotencyKey : Text };
  public type Stats = { tenants : Nat; apiKeys : Nat; usageEvents : Nat; reporters : Nat };

  // ---------------------------------------------- signed receipts (#15) --
  // `Receipt.mo` has the model and the reasoning.

  public type UsageReceipt = Receipt.Receipt;
  public type SignedReceipt = Receipt.SignedReceipt;
  public type ReporterKey = Receipt.ReporterKey;
  public type ReporterPolicy = Receipt.Policy;
  public type ReceiptRejection = Receipt.Rejection;
  public type ReporterHealth = Receipt.Health;

  /// What became of one receipt in a batch. Each receipt is decided on its
  /// own: one bad signature in an offline batch does not lose the rest.
  public type ReceiptOutcome = {
    #recorded : UsageEvent;
    /// The same receipt was submitted before; this is the event it created,
    /// and nothing new was recorded.
    #replayed : UsageEvent;
    #rejected : ReceiptRejection;
  };

  public type ReporterView = {
    reporter : Principal;
    enabled : Bool;
    policy : ?ReporterPolicy;
    keys : [ReporterKey];
    health : ReporterHealth;
  };

  /// One usage event with what an auditor needs to re-check it offline: the
  /// signed receipt it came from and the key that signed it. `null` for events
  /// recorded through the unsigned path.
  public type AuditEntry = {
    event : UsageEvent;
    receipt : ?SignedReceipt;
    publicKey : ?Blob;
  };

  // ------------------------------------------------ billing (#14) ------
  // `Billing.mo` has the rules; these are the names the interface exposes.

  public type Invoice = Billing.Invoice;
  public type InvoicePayment = Billing.Payment;
  public type InvoiceAdjustment = Billing.Adjustment;
  public type InvoiceStatus = Billing.Status;

  /// An invoice with everything that has been applied to it. The invoice
  /// itself never changes; `balance` and `status` are computed from the rest.
  public type InvoiceView = {
    invoice : Invoice;
    payments : [InvoicePayment];
    adjustments : [InvoiceAdjustment];
    balance : Int;
    status : InvoiceStatus;
    /// Where and how to pay: the ledger registered for the invoice currency,
    /// if any, the account to pay, and the memo the transfer must carry.
    ledger : ?BillingLedger;
    payTo : Icrc3.Account;
  };

  public type BillingLedger = {
    ledger : Principal;
    symbol : Text;
    decimals : Nat8;
    fee : Nat;
    registeredAt : Nat;
  };

  public type AdjustmentInput = {
    kind : Billing.AdjustmentKind;
    amount : Nat;
    reason : Text;
    reference : Text;
  };

  /// `Error` plus the two outcomes only a ledger can produce. A separate type
  /// so no tag is added to the released `Error`.
  public type BillingError = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    /// The ledger could not be asked. Nothing changed; retry as is.
    #ledgerUnavailable : Text;
    /// The ledger answered and the block does not pay this invoice.
    #rejected : Text;
  };

  public type BillingResult<T> = { #ok : T; #err : BillingError };

  public type ReceiptSpec = {
    domain : Text;
    curve : Text;
    signatureEncoding : Text;
    canister : Principal;
    maxFutureSkewNanos : Nat;
    maxAgeNanos : Nat;
    maxBatch : Nat;
  };

  let tenants = Map.empty<Principal, Tenant>();
  let apiKeys = Map.empty<Blob, ApiKeyRecord>();
  let usageEvents = Map.empty<Nat, UsageEvent>();
  let usageIdempotency = Map.empty<Text, Nat>();
  let reporters = Map.empty<Principal, Bool>();
  var nextEventId : Nat = 1;

  let reporterPolicies = Map.empty<Principal, ReporterPolicy>();
  let reporterKeys = Map.empty<Nat, ReporterKey>();
  let keysOf = Map.empty<Principal, [Nat]>();
  let reporterHealth = Map.empty<Principal, ReporterHealth>();
  /// Usage event id to the receipt that created it. A side index, so
  /// `UsageEvent` keeps its shape and events recorded before receipts existed
  /// need no migration.
  let receiptOf = Map.empty<Nat, SignedReceipt>();
  var nextKeyId : Nat = 1;

  let invoices = Map.empty<Nat, Invoice>();
  let invoicesOf = Map.empty<Principal, [Nat]>();
  /// Event ids recorded in each tenant's open period, which the next close
  /// moves into an invoice.
  let openPeriodEvents = Map.empty<Principal, List.List<Nat>>();
  /// Receipts observed before the open period began, per tenant.
  let openPeriodLate = Map.empty<Principal, Nat>();
  let invoicePayments = Map.empty<Nat, [InvoicePayment]>();
  let invoiceAdjustments = Map.empty<Nat, [InvoiceAdjustment]>();
  /// `ledger:block` to invoice id: a block pays at most one invoice, once.
  let invoicePaymentIndex = Map.empty<Text, Nat>();
  let billingLedgers = Map.empty<Principal, BillingLedger>();
  var nextInvoiceId : Nat = 1;
  var nextAdjustmentId : Nat = 1;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func isController(caller : Principal) : Bool { Principal.isController(caller) };

  func isReporter(caller : Principal) : Bool {
    if (isController(caller)) return true;
    switch (Map.get(reporters, Principal.compare, caller)) { case (?enabled) enabled; case null false }
  };

  func validatePlan(plan : Plan) : ?Error {
    if (not Validation.validText(plan.name, 1, 100)) return ?#invalidInput("plan name length is invalid");
    if (plan.quota == 0) return ?#invalidInput("quota must be greater than zero");
    if (plan.periodSeconds == 0 or plan.periodSeconds > 31_536_000) return ?#invalidInput("periodSeconds is invalid");
    if (not Validation.validText(plan.currency, 1, 20)) return ?#invalidInput("currency length is invalid");
    null
  };

  /// Issues the invoice for `[tenant.periodStartedAt, billedUntil)` and returns
  /// the tenant moved to a period starting at `billedUntil`. The only place an
  /// invoice is created, and it moves the period in the same step, so no
  /// period can be closed twice.
  func closePeriodAt(tenant : Tenant, billedUntil : Nat, reason : Billing.CloseReason, now : Nat) : Tenant {
    let events = switch (Map.get(openPeriodEvents, Principal.compare, tenant.principal)) {
      case (?list) List.toArray(list);
      case null [];
    };
    let late = switch (Map.get(openPeriodLate, Principal.compare, tenant.principal)) {
      case (?count) count;
      case null 0;
    };
    let moved : Tenant = { tenant with used = 0; periodStartedAt = billedUntil };
    // A plan change at the instant a period began has nothing to bill.
    if (billedUntil <= tenant.periodStartedAt and events.size() == 0) return moved;

    let usage = Billing.tally(
      Array.filterMap<Nat, (Text, Nat)>(
        events,
        func(id : Nat) : ?(Text, Nat) {
          switch (Map.get(usageEvents, Nat.compare, id)) {
            case (?event) ?(event.category, event.units);
            case null null;
          }
        }
      )
    );
    let (lines, total) = Billing.lines(tenant.plan, tenant.periodStartedAt, billedUntil, usage);
    let id = nextInvoiceId;
    nextInvoiceId += 1;
    let previous = switch (Map.get(invoicesOf, Principal.compare, tenant.principal)) {
      case (?ids) ids;
      case null [];
    };
    let invoice : Invoice = {
      id;
      tenant = tenant.principal;
      sequence = previous.size() + 1;
      plan = tenant.plan;
      currency = tenant.plan.currency;
      periodStart = tenant.periodStartedAt;
      billedUntil;
      closedAt = now;
      reason;
      eventIds = events;
      lateEvents = late;
      lines;
      total;
      paymentMemo = Billing.paymentMemo(Principal.fromActor(UsageMeteredSaaS), id);
    };
    Map.add(invoices, Nat.compare, id, invoice);
    Map.add(invoicesOf, Principal.compare, tenant.principal, Array.concat(previous, [id]));
    Map.remove(openPeriodEvents, Principal.compare, tenant.principal);
    Map.remove(openPeriodLate, Principal.compare, tenant.principal);
    moved
  };

  /// Closes every period of `tenant` that has ended by `now`, as one invoice
  /// covering all of them, and stores the tenant in its current period.
  ///
  /// Periods are aligned to the plan: the next one starts where the last one
  /// ended, not at the first event after it, so a quiet month is still a
  /// month and the boundaries an invoice names are the plan's.
  func advancePeriod(tenant : Tenant, now : Nat) : Tenant {
    let length = tenant.plan.periodSeconds * 1_000_000_000;
    if (now < tenant.periodStartedAt + length) return tenant;
    let whole = Nat.sub(now, tenant.periodStartedAt) / length;
    let moved = closePeriodAt(tenant, tenant.periodStartedAt + whole * length, #periodEnd, now);
    Map.add(tenants, Principal.compare, tenant.principal, moved);
    moved
  };

  public shared ({ caller }) func setReporter(reporter : Principal, enabled : Bool) : async Result<Bool> {
    if (not isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(reporter)) return #err(#invalidInput("reporter is invalid"));
    Map.add(reporters, Principal.compare, reporter, enabled);
    #ok(enabled)
  };

  public shared ({ caller }) func createTenant(input : TenantInput) : async Result<Tenant> {
    if (not isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(input.principal)) return #err(#invalidInput("tenant principal is invalid"));
    if (not Validation.validText(input.displayName, 1, 200)) return #err(#invalidInput("displayName length is invalid"));
    switch (validatePlan(input.plan)) { case (?error) return #err(error); case null {} };
    switch (Map.get(tenants, Principal.compare, input.principal)) {
      case (?_) return #err(#duplicate("tenant already exists"));
      case null {};
    };
    let now = nowNanos();
    let tenant : Tenant = {
      principal = input.principal; displayName = input.displayName; plan = input.plan;
      used = 0; periodStartedAt = now; enabled = true; createdAt = now;
    };
    Map.add(tenants, Principal.compare, input.principal, tenant);
    #ok(tenant)
  };

  public shared ({ caller }) func setTenantPlan(tenantPrincipal : Principal, plan : Plan) : async Result<Tenant> {
    if (not isController(caller)) return #err(#unauthorized);
    switch (validatePlan(plan)) { case (?error) return #err(error); case null {} };
    let ?stored = Map.get(tenants, Principal.compare, tenantPrincipal) else return #err(#notFound);
    // Whole periods that ended under the old plan are billed as such first;
    // then the part of the open period the old plan was in force is billed pro
    // rata, and the new plan starts a fresh period now. Usage recorded so far
    // stays on the old plan's invoice: it happened under that plan.
    let now = nowNanos();
    let current = closePeriodAt(advancePeriod(stored, now), now, #planChange, now);
    let updated : Tenant = { current with plan = plan; used = 0; periodStartedAt = now };
    Map.add(tenants, Principal.compare, tenantPrincipal, updated);
    #ok(updated)
  };

  public shared ({ caller }) func setTenantEnabled(tenantPrincipal : Principal, enabled : Bool) : async Result<Tenant> {
    if (not isController(caller)) return #err(#unauthorized);
    let ?current = Map.get(tenants, Principal.compare, tenantPrincipal) else return #err(#notFound);
    let updated : Tenant = {
      principal = current.principal; displayName = current.displayName; plan = current.plan;
      used = current.used; periodStartedAt = current.periodStartedAt; enabled = enabled; createdAt = current.createdAt;
    };
    Map.add(tenants, Principal.compare, tenantPrincipal, updated);
    #ok(updated)
  };

  public shared ({ caller }) func registerApiKeyHash(tenantPrincipal : Principal, hash : Blob, keyLabel : Text) : async Result<ApiKeyRecord> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    if (caller != tenantPrincipal and not isController(caller)) return #err(#unauthorized);
    if (not Validation.isDigest(hash)) return #err(#invalidInput("API key hash must be 32 bytes"));
    if (not Validation.validText(keyLabel, 1, 100)) return #err(#invalidInput("keyLabel length is invalid"));
    let ?tenant = Map.get(tenants, Principal.compare, tenantPrincipal) else return #err(#notFound);
    if (not tenant.enabled) return #err(#conflict("tenant is disabled"));
    switch (Map.get(apiKeys, Blob.compare, hash)) { case (?_) return #err(#duplicate("API key hash already exists")); case null {} };
    let record : ApiKeyRecord = {
      hash = hash; tenant = tenantPrincipal; keyLabel = keyLabel; createdAt = nowNanos(); revokedAt = null
    };
    Map.add(apiKeys, Blob.compare, hash, record);
    #ok(record)
  };

  public shared ({ caller }) func revokeApiKeyHash(hash : Blob) : async Result<ApiKeyRecord> {
    let ?current = Map.get(apiKeys, Blob.compare, hash) else return #err(#notFound);
    if (current.tenant != caller and not isController(caller)) return #err(#unauthorized);
    switch (current.revokedAt) { case (?_) return #err(#conflict("API key is already revoked")); case null {} };
    let updated : ApiKeyRecord = {
      hash = current.hash; tenant = current.tenant; keyLabel = current.keyLabel;
      createdAt = current.createdAt; revokedAt = ?nowNanos();
    };
    Map.add(apiKeys, Blob.compare, hash, updated);
    #ok(updated)
  };

  /// The default window for a reporter without a policy, used only for health.
  let defaultWindowSeconds : Nat = 3_600;

  func healthOf(reporter : Principal, now : Nat) : ReporterHealth {
    let window = switch (Map.get(reporterPolicies, Principal.compare, reporter)) {
      case (?policy) policy.windowSeconds;
      case null defaultWindowSeconds;
    };
    let start = Receipt.windowStart(now, window);
    switch (Map.get(reporterHealth, Principal.compare, reporter)) {
      case (?health) Receipt.roll(health, start);
      case null Receipt.emptyHealth(start);
    }
  };

  func windowLimitOf(reporter : Principal) : Nat {
    switch (Map.get(reporterPolicies, Principal.compare, reporter)) {
      case (?policy) policy.maxUnitsPerWindow;
      // No policy, no window limit; the anomaly flag then only reacts to
      // rejection bursts. `0` would make every accepted unit look anomalous.
      case null 1_000_000_000_000_000;
    }
  };

  func noteRejected(reporter : Principal, rejection : ReceiptRejection, now : Nat) {
    let health = Receipt.noteRejection(healthOf(reporter, now), rejection, now, windowLimitOf(reporter));
    Map.add(reporterHealth, Principal.compare, reporter, health)
  };

  type Recorded = { #recorded : UsageEvent; #existing : UsageEvent; #rejected : ReceiptRejection };

  /// Everything both paths share once the reporter is authorized: the
  /// idempotency index, the tenant, the quota, and the event itself.
  func record(tenantPrincipal : Principal, units : Nat, category : Text, idempotencyKey : Text, by : Principal, observedAt : Nat, now : Nat) : Recorded {
    let ?storedTenant = Map.get(tenants, Principal.compare, tenantPrincipal) else return #rejected(#tenantUnavailable);
    // Closing an ended period happens before anything else, including a
    // refusal below: the invoice is due whether or not this event is accepted.
    let tenant = advancePeriod(storedTenant, now);
    if (not tenant.enabled) return #rejected(#tenantUnavailable);
    let scopedKey = Principal.toText(tenantPrincipal) # ":" # idempotencyKey;
    switch (Map.get(usageIdempotency, Text.compare, scopedKey)) {
      case (?existingId) {
        let ?existing = Map.get(usageEvents, Nat.compare, existingId) else {
          return #rejected(#conflict("idempotency index is inconsistent"))
        };
        return #existing(existing)
      };
      case null {};
    };
    if (tenant.used + units > tenant.plan.quota) {
      return #rejected(#quotaExceeded({ quota = tenant.plan.quota; used = tenant.used; requested = units }))
    };

    let id = nextEventId;
    nextEventId += 1;
    let event : UsageEvent = {
      id = id; tenant = tenantPrincipal; units = units; category = category;
      idempotencyKey = idempotencyKey; recordedBy = by; recordedAt = now;
    };
    Map.add(usageEvents, Nat.compare, id, event);
    Map.add(usageIdempotency, Text.compare, scopedKey, id);
    let updatedTenant : Tenant = {
      principal = tenant.principal; displayName = tenant.displayName; plan = tenant.plan;
      used = tenant.used + units; periodStartedAt = tenant.periodStartedAt;
      enabled = tenant.enabled; createdAt = tenant.createdAt;
    };
    Map.add(tenants, Principal.compare, tenantPrincipal, updatedTenant);
    // Usage belongs to the period it is recorded in. A receipt observed before
    // that period began is counted here and marked late, and the invoice it
    // would have belonged to stays exactly as it was issued.
    let open = switch (Map.get(openPeriodEvents, Principal.compare, tenantPrincipal)) {
      case (?list) list;
      case null {
        let list = List.empty<Nat>();
        Map.add(openPeriodEvents, Principal.compare, tenantPrincipal, list);
        list
      };
    };
    List.add(open, id);
    if (observedAt < tenant.periodStartedAt) {
      let late = switch (Map.get(openPeriodLate, Principal.compare, tenantPrincipal)) { case (?n) n; case null 0 };
      Map.add(openPeriodLate, Principal.compare, tenantPrincipal, late + 1)
    };
    #recorded(event)
  };

  /// Scope and window for a reporter with a policy; `null` when it may write.
  func checkReporter(reporter : Principal, tenant : Principal, category : Text, units : Nat, now : Nat) : ?ReceiptRejection {
    let ?policy = Map.get(reporterPolicies, Principal.compare, reporter) else return null;
    switch (Receipt.checkPolicy(policy, tenant, category, units)) {
      case (?rejection) return ?rejection;
      case null {};
    };
    let health = healthOf(reporter, now);
    if (health.windowUnits + units > policy.maxUnitsPerWindow) {
      return ?#windowExceeded({ limit = policy.maxUnitsPerWindow; used = health.windowUnits; requested = units })
    };
    null
  };

  func noteRecorded(reporter : Principal, units : Nat, now : Nat) {
    let health = Receipt.noteAccepted(healthOf(reporter, now), units, windowLimitOf(reporter));
    Map.add(reporterHealth, Principal.compare, reporter, health)
  };

  /// The unsigned path. A reporter whose policy requires signatures is refused
  /// here, so a stolen principal cannot route around them; any other reporter
  /// with a policy is held to its scope and window on this path too.
  /// Controllers are operators, not reporters, and are not policy-bound.
  public shared ({ caller }) func recordUsage(input : UsageInput) : async Result<UsageEvent> {
    if (not isReporter(caller)) return #err(#unauthorized);
    if (input.units == 0 or input.units > 1_000_000_000) return #err(#invalidInput("units is invalid"));
    if (not Validation.validText(input.category, 1, 100)) return #err(#invalidInput("category length is invalid"));
    if (not Validation.validText(input.idempotencyKey, 1, 200)) return #err(#invalidInput("idempotencyKey length is invalid"));
    let now = nowNanos();
    let bound = not isController(caller);
    if (bound) {
      switch (Map.get(reporterPolicies, Principal.compare, caller)) {
        case (?policy) {
          if (policy.requireSignatures) {
            noteRejected(caller, #unauthorized, now);
            return #err(#unauthorized)
          }
        };
        case null {};
      };
      switch (checkReporter(caller, input.tenant, input.category, input.units, now)) {
        case (?rejection) {
          noteRejected(caller, rejection, now);
          return switch (rejection) {
            case (#windowExceeded(_)) #err(#conflict("reporter window limit exceeded"));
            case _ #err(#unauthorized);
          }
        };
        case null {};
      }
    };
    switch (record(input.tenant, input.units, input.category, input.idempotencyKey, caller, now, now)) {
      case (#recorded(event)) {
        if (bound) noteRecorded(caller, event.units, now);
        #ok(event)
      };
      case (#existing(event)) #ok(event);
      case (#rejected(#tenantUnavailable)) {
        switch (Map.get(tenants, Principal.compare, input.tenant)) {
          case null #err(#notFound);
          case (?_) #err(#conflict("tenant is disabled"));
        }
      };
      case (#rejected(#quotaExceeded(detail))) #err(#quotaExceeded(detail));
      case (#rejected(#conflict(message))) #err(#conflict(message));
      case (#rejected(_)) #err(#conflict("usage was not recorded"));
    }
  };

  func processReceipt(caller : Principal, signed : SignedReceipt, now : Nat) : ReceiptOutcome {
    let receipt = signed.receipt;
    // Only the reporter submits its own receipts, and only while it is one.
    // A rejection here is not counted against the named reporter: anyone can
    // write any name into a receipt, and a reporter's health should not be
    // something a stranger can spoil.
    if (not Principal.equal(caller, receipt.reporter) or not isEnabledReporter(caller)) {
      return #rejected(#unauthorized)
    };
    let reject = func(rejection : ReceiptRejection) : ReceiptOutcome {
      noteRejected(caller, rejection, now);
      #rejected(rejection)
    };
    if (not Principal.equal(receipt.canister, Principal.fromActor(UsageMeteredSaaS))) return reject(#wrongCanister);
    switch (Receipt.checkShape(receipt)) { case (?rejection) return reject(rejection); case null {} };
    switch (Receipt.checkClock(receipt.observedAt, now)) { case (?rejection) return reject(rejection); case null {} };
    let ?key = Map.get(reporterKeys, Nat.compare, receipt.keyId) else return reject(#unknownKey);
    if (not Principal.equal(key.reporter, receipt.reporter)) return reject(#unknownKey);
    if (not Receipt.keyValidAt(key, receipt.observedAt)) return reject(#keyNotValid);

    // A replay of an accepted receipt returns the original event and records
    // nothing, before the signature is checked again: the content was verified
    // once, and the event it created is public anyway.
    let scopedKey = Principal.toText(receipt.tenant) # ":" # receipt.idempotencyKey;
    switch (Map.get(usageIdempotency, Text.compare, scopedKey)) {
      case (?existingId) {
        switch (Map.get(receiptOf, Nat.compare, existingId), Map.get(usageEvents, Nat.compare, existingId)) {
          case (?original, ?event) {
            if (original.receipt == receipt) {
              let health = healthOf(caller, now);
              Map.add(reporterHealth, Principal.compare, caller, { health with replayed = health.replayed + 1 });
              return #replayed(event)
            }
          };
          case _ {};
        }
      };
      case null {};
    };

    // The expensive check, after every cheap one.
    if (not Receipt.verifySignature(key.publicKey, signed)) return reject(#badSignature);

    switch (checkReporter(caller, receipt.tenant, receipt.category, receipt.units, now)) {
      case (?rejection) return reject(rejection);
      case null {};
    };
    switch (record(receipt.tenant, receipt.units, receipt.category, receipt.idempotencyKey, caller, receipt.observedAt, now)) {
      case (#recorded(event)) {
        Map.add(receiptOf, Nat.compare, event.id, signed);
        noteRecorded(caller, event.units, now);
        #recorded(event)
      };
      // The key is taken, by different content: a replay was caught above.
      case (#existing(_)) reject(#conflict("idempotency key already used by a different usage record"));
      case (#rejected(rejection)) reject(rejection);
    }
  };

  func isEnabledReporter(principal : Principal) : Bool {
    switch (Map.get(reporters, Principal.compare, principal)) { case (?enabled) enabled; case null false }
  };

  /// Submits signed receipts — typically an offline batch, signed where the
  /// usage was observed and relayed later by the reporter.
  public shared ({ caller }) func submitReceipts(batch : [SignedReceipt]) : async Result<[ReceiptOutcome]> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    if (batch.size() == 0 or batch.size() > Receipt.maxBatch) {
      return #err(#invalidInput("a batch holds 1 to " # Nat.toText(Receipt.maxBatch) # " receipts"))
    };
    let now = nowNanos();
    #ok(Array.map<SignedReceipt, ReceiptOutcome>(batch, func(signed : SignedReceipt) : ReceiptOutcome { processReceipt(caller, signed, now) }))
  };

  public shared ({ caller }) func setReporterPolicy(reporter : Principal, policy : ReporterPolicy) : async Result<ReporterPolicy> {
    if (not isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(reporter)) return #err(#invalidInput("reporter is invalid"));
    switch (Receipt.checkPolicyShape(policy)) { case (?problem) return #err(#invalidInput(problem)); case null {} };
    Map.add(reporterPolicies, Principal.compare, reporter, policy);
    #ok(policy)
  };

  /// Registers a signing key for a reporter. Controllers only: a reporter that
  /// could add its own keys would let a stolen principal mint one.
  public shared ({ caller }) func addReporterKey(reporter : Principal, publicKey : Blob) : async Result<ReporterKey> {
    if (not isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(reporter)) return #err(#invalidInput("reporter is invalid"));
    switch (Receipt.checkPublicKey(publicKey)) { case (?problem) return #err(#invalidInput(problem)); case null {} };
    let existing = switch (Map.get(keysOf, Principal.compare, reporter)) { case (?ids) ids; case null [] };
    var live = 0;
    for (id in existing.values()) {
      switch (Map.get(reporterKeys, Nat.compare, id)) {
        case (?key) {
          if (key.publicKey == publicKey) return #err(#duplicate("the key is already registered for this reporter"));
          switch (key.status) { case (#active) live += 1; case _ {} }
        };
        case null {};
      }
    };
    if (live >= Receipt.maxKeysPerReporter) return #err(#conflict("the reporter has too many active keys"));
    let key : ReporterKey = { id = nextKeyId; reporter; publicKey; addedAt = nowNanos(); status = #active };
    nextKeyId += 1;
    Map.add(reporterKeys, Nat.compare, key.id, key);
    Map.add(keysOf, Principal.compare, reporter, Array.concat(existing, [key.id]));
    #ok(key)
  };

  /// Rotates a key out. Receipts it signed before now still verify.
  public shared ({ caller }) func retireReporterKey(keyId : Nat) : async Result<ReporterKey> {
    if (not isController(caller)) return #err(#unauthorized);
    let ?key = Map.get(reporterKeys, Nat.compare, keyId) else return #err(#notFound);
    switch (key.status) {
      case (#active) {};
      case _ return #err(#conflict("only an active key can be retired"));
    };
    let retired = { key with status = #retired(nowNanos()) };
    Map.add(reporterKeys, Nat.compare, keyId, retired);
    #ok(retired)
  };

  /// Declares a key stolen: nothing it signed is accepted any more, whatever
  /// time the receipt claims. The reporter may do this itself as well as a
  /// controller — it can only make the key less useful, never more.
  public shared ({ caller }) func markReporterKeyCompromised(keyId : Nat) : async Result<ReporterKey> {
    let ?key = Map.get(reporterKeys, Nat.compare, keyId) else return #err(#notFound);
    if (not isController(caller) and not Principal.equal(caller, key.reporter)) return #err(#unauthorized);
    switch (key.status) {
      case (#compromised(_)) return #err(#conflict("the key is already marked compromised"));
      case _ {};
    };
    let marked = { key with status = #compromised(nowNanos()) };
    Map.add(reporterKeys, Nat.compare, keyId, marked);
    #ok(marked)
  };

  public query func getReporter(reporter : Principal) : async ?ReporterView {
    let enabled = isEnabledReporter(reporter);
    let policy = Map.get(reporterPolicies, Principal.compare, reporter);
    let ids = switch (Map.get(keysOf, Principal.compare, reporter)) { case (?ids) ids; case null [] };
    if (not enabled and policy == null and ids.size() == 0 and Map.get(reporters, Principal.compare, reporter) == null) {
      return null
    };
    let keys = Array.filterMap<Nat, ReporterKey>(ids, func(id : Nat) : ?ReporterKey { Map.get(reporterKeys, Nat.compare, id) });
    ?{ reporter; enabled; policy; keys; health = healthOf(reporter, nowNanos()) }
  };

  /// Usage events with their receipts and signing keys, for an auditor who
  /// wants to re-verify billing without trusting this canister.
  public query func exportUsageAudit(start : Nat, limit : Nat) : async [AuditEntry] {
    let entries = Iter.take(Map.entriesFrom(usageEvents, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(
      Iter.map<(Nat, UsageEvent), AuditEntry>(
        entries,
        func((id, event) : (Nat, UsageEvent)) : AuditEntry {
          let receipt = Map.get(receiptOf, Nat.compare, id);
          let publicKey = switch (receipt) {
            case (?signed) {
              switch (Map.get(reporterKeys, Nat.compare, signed.receipt.keyId)) {
                case (?key) ?key.publicKey;
                case null null;
              }
            };
            case null null;
          };
          { event; receipt; publicKey }
        }
      )
    )
  };

  /// The rules a signer has to follow, read off the canister rather than
  /// hardcoded, including the `canister` every receipt must name.
  public query func receiptSpec() : async ReceiptSpec {
    {
      domain = Receipt.domainV1;
      curve = Receipt.curveName;
      signatureEncoding = "ECDSA over SHA-256, r || s, 64 bytes, low-S";
      canister = Principal.fromActor(UsageMeteredSaaS);
      maxFutureSkewNanos = Receipt.maxFutureSkewNanos;
      maxAgeNanos = Receipt.maxAgeNanos;
      maxBatch = Receipt.maxBatch;
    }
  };

  // ------------------------------------------------ billing (#14) ------

  func payTo() : Icrc3.Account { { owner = Principal.fromActor(UsageMeteredSaaS); subaccount = null } };

  func ledgerForCurrency(currency : Text) : ?BillingLedger {
    for (ledger in Map.values(billingLedgers)) {
      if (ledger.symbol == currency) return ?ledger
    };
    null
  };

  func viewOf(invoice : Invoice) : InvoiceView {
    let payments = switch (Map.get(invoicePayments, Nat.compare, invoice.id)) { case (?list) list; case null [] };
    let adjustments = switch (Map.get(invoiceAdjustments, Nat.compare, invoice.id)) { case (?list) list; case null [] };
    {
      invoice;
      payments;
      adjustments;
      balance = Billing.balance(invoice.total, payments, adjustments);
      status = Billing.status(invoice.total, payments, adjustments);
      ledger = ledgerForCurrency(invoice.currency);
      payTo = payTo();
    }
  };

  func mayRead(caller : Principal, tenant : Principal) : Bool {
    Principal.equal(caller, tenant) or isController(caller)
  };

  /// Registers a ledger invoices in its symbol can be paid with, reading the
  /// symbol, decimals and fee from the ledger itself. Controllers only: which
  /// tokens settle invoices is operator policy, and a registered ledger is
  /// trusted to report its own history.
  public shared ({ caller }) func registerBillingLedger(ledger : Principal) : async BillingResult<BillingLedger> {
    if (not isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(ledger)) return #err(#invalidInput("ledger is invalid"));
    let token : Icrc3.Ledger = actor (Principal.toText(ledger));
    let metadata = try {
      (await token.icrc1_symbol(), await token.icrc1_decimals(), await token.icrc1_fee())
    } catch (error) {
      return #err(#ledgerUnavailable("the ledger did not answer its ICRC-1 metadata queries: " # Error.message(error)))
    };
    switch (ledgerForCurrency(metadata.0)) {
      case (?existing) {
        if (not Principal.equal(existing.ledger, ledger)) {
          return #err(#conflict("another ledger is already registered for " # metadata.0))
        }
      };
      case null {};
    };
    let info : BillingLedger = {
      ledger;
      symbol = metadata.0;
      decimals = metadata.1;
      fee = metadata.2;
      registeredAt = nowNanos();
    };
    Map.add(billingLedgers, Principal.compare, ledger, info);
    #ok(info)
  };

  /// Closes the tenant's period if it has ended, without waiting for the next
  /// usage event to do it. A period that has not ended cannot be closed here;
  /// one that has is closed exactly once, by whichever call comes first.
  public shared ({ caller }) func closePeriod(tenantPrincipal : Principal) : async BillingResult<InvoiceView> {
    if (not mayRead(caller, tenantPrincipal)) return #err(#unauthorized);
    let ?tenant = Map.get(tenants, Principal.compare, tenantPrincipal) else return #err(#notFound);
    let before = nextInvoiceId;
    let moved = advancePeriod(tenant, nowNanos());
    if (nextInvoiceId == before) {
      return #err(#conflict("the current period has not ended"))
    };
    ignore moved;
    let ?invoice = Map.get(invoices, Nat.compare, before) else return #err(#notFound);
    #ok(viewOf(invoice))
  };

  /// Appends a credit or debit note. The invoice is not edited and nothing is
  /// deleted. `reference` is the operator's own id for the adjustment: a retry
  /// with the same reference and content returns the adjustment already made,
  /// and the same reference with different content is refused.
  public shared ({ caller }) func adjustInvoice(invoiceId : Nat, input : AdjustmentInput) : async BillingResult<InvoiceView> {
    if (not isController(caller)) return #err(#unauthorized);
    let ?invoice = Map.get(invoices, Nat.compare, invoiceId) else return #err(#notFound);
    if (input.amount == 0) return #err(#invalidInput("an adjustment needs a non-zero amount"));
    if (not Validation.validText(input.reason, 1, 500)) return #err(#invalidInput("reason length is invalid"));
    if (not Validation.validText(input.reference, 1, 100)) return #err(#invalidInput("reference length is invalid"));
    let existing = switch (Map.get(invoiceAdjustments, Nat.compare, invoiceId)) { case (?list) list; case null [] };
    for (adjustment in existing.values()) {
      if (adjustment.reference == input.reference) {
        if (adjustment.kind == input.kind and adjustment.amount == input.amount and adjustment.reason == input.reason) {
          return #ok(viewOf(invoice))
        };
        return #err(#duplicate("the reference is already used by a different adjustment"))
      }
    };
    if (existing.size() >= 100) return #err(#conflict("the invoice has reached its adjustment limit"));
    let adjustment : InvoiceAdjustment = {
      id = nextAdjustmentId;
      invoice = invoiceId;
      kind = input.kind;
      amount = input.amount;
      reason = input.reason;
      reference = input.reference;
      by = caller;
      at = nowNanos();
    };
    nextAdjustmentId += 1;
    Map.add(invoiceAdjustments, Nat.compare, invoiceId, Array.concat(existing, [adjustment]));
    #ok(viewOf(invoice))
  };

  type PayCheck = { #done : BillingResult<InvoiceView>; #fetch : (Invoice, BillingLedger) };

  func payPreflight(caller : Principal, invoiceId : Nat, ledger : Principal, block : Nat) : PayCheck {
    let ?invoice = Map.get(invoices, Nat.compare, invoiceId) else return #done(#err(#notFound));
    if (not mayRead(caller, invoice.tenant)) return #done(#err(#unauthorized));
    let ?token = Map.get(billingLedgers, Principal.compare, ledger) else {
      return #done(#err(#invalidInput("the ledger is not registered for billing")))
    };
    if (token.symbol != invoice.currency) {
      return #done(#err(#invalidInput("the invoice is in " # invoice.currency # ", not " # token.symbol)))
    };
    switch (Map.get(invoicePaymentIndex, Text.compare, Principal.toText(ledger) # ":" # Nat.toText(block))) {
      // The same block for the same invoice is a retry: answer as before.
      case (?paid) {
        if (paid == invoiceId) return #done(#ok(viewOf(invoice)));
        return #done(#err(#duplicate("this ledger block has already paid another invoice")))
      };
      case null {};
    };
    #fetch(invoice, token)
  };

  /// Applies a ledger payment to an invoice. The caller supplies a block
  /// index; every property of the payment is read from the ledger.
  ///
  /// Safe to repeat: the same block for the same invoice returns the invoice
  /// as paid and applies nothing twice, and a ledger that cannot be asked
  /// changes nothing. Everything is re-checked after the ledger call, because
  /// another message may have applied the same block while this one waited.
  public shared ({ caller }) func payInvoice(invoiceId : Nat, ledger : Principal, block : Nat) : async BillingResult<InvoiceView> {
    switch (payPreflight(caller, invoiceId, ledger, block)) {
      case (#done(result)) return result;
      case (#fetch(_, token)) {
        let fetched = await* Billing.fetchBlock(actor (Principal.toText(token.ledger)) : Icrc3.Ledger, block);
        switch (payPreflight(caller, invoiceId, ledger, block)) {
          case (#done(result)) return result;
          case (#fetch(invoice, current)) applyPayment(invoice, current, block, fetched);
        }
      };
    }
  };

  func applyPayment(invoice : Invoice, token : BillingLedger, block : Nat, fetched : Billing.Fetched) : BillingResult<InvoiceView> {
    let raw = switch (fetched) {
      case (#unavailable(reason)) return #err(#ledgerUnavailable(reason));
      case (#missing) return #err(#rejected("the ledger has no block at that index"));
      case (#block(value)) value;
    };
    let transfer = switch (Icrc3.decode(raw)) {
      case (#malformed(reason)) return #err(#rejected("the block is malformed: " # reason));
      case (#notTransfer(kind)) return #err(#rejected("the block is not a transfer: " # kind));
      case (#transfer(transfer)) transfer;
    };
    switch (Billing.checkPayment(transfer, payTo(), invoice)) {
      case (?reason) return #err(#rejected(reason));
      case null {};
    };
    let payment : InvoicePayment = {
      invoice = invoice.id;
      ledger = token.ledger;
      block;
      symbol = token.symbol;
      decimals = token.decimals;
      from = transfer.from;
      amount = transfer.amount;
      paidAt = transfer.timestamp;
      appliedAt = nowNanos();
    };
    let existing = switch (Map.get(invoicePayments, Nat.compare, invoice.id)) { case (?list) list; case null [] };
    Map.add(invoicePayments, Nat.compare, invoice.id, Array.concat(existing, [payment]));
    Map.add(invoicePaymentIndex, Text.compare, Principal.toText(token.ledger) # ":" # Nat.toText(block), invoice.id);
    #ok(viewOf(invoice))
  };

  public query ({ caller }) func getInvoice(invoiceId : Nat) : async ?InvoiceView {
    let ?invoice = Map.get(invoices, Nat.compare, invoiceId) else return null;
    if (not mayRead(caller, invoice.tenant)) return null;
    ?viewOf(invoice)
  };

  public query ({ caller }) func listInvoices(tenantPrincipal : Principal) : async [Invoice] {
    if (not mayRead(caller, tenantPrincipal)) return [];
    let ids = switch (Map.get(invoicesOf, Principal.compare, tenantPrincipal)) { case (?ids) ids; case null [] };
    Array.filterMap<Nat, Invoice>(ids, func(id : Nat) : ?Invoice { Map.get(invoices, Nat.compare, id) })
  };

  /// The invoice as the customer-readable JSON document in docs/BILLING.md.
  public query ({ caller }) func invoiceJson(invoiceId : Nat) : async ?Text {
    let ?invoice = Map.get(invoices, Nat.compare, invoiceId) else return null;
    if (not mayRead(caller, invoice.tenant)) return null;
    let view = viewOf(invoice);
    let customer = switch (Map.get(tenants, Principal.compare, invoice.tenant)) {
      case (?tenant) tenant.displayName;
      case null "";
    };
    let decimals = switch (view.ledger) { case (?ledger) ?ledger.decimals; case null null };
    ?Billing.json(invoice, customer, decimals, view.payments, view.adjustments)
  };

  public query func getTenant(principal : Principal) : async ?Tenant { Map.get(tenants, Principal.compare, principal) };
  public query func getApiKey(hash : Blob) : async ?ApiKeyRecord { Map.get(apiKeys, Blob.compare, hash) };
  public query func getUsageEvent(id : Nat) : async ?UsageEvent { Map.get(usageEvents, Nat.compare, id) };

  public query func listUsageEvents(start : Nat, limit : Nat) : async [UsageEvent] {
    let entries = Iter.take(Map.entriesFrom(usageEvents, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, UsageEvent), UsageEvent>(entries, func(entry : (Nat, UsageEvent)) : UsageEvent { entry.1 }))
  };

  public query func stats() : async Stats {
    { tenants = Map.size(tenants); apiKeys = Map.size(apiKeys); usageEvents = Map.size(usageEvents); reporters = Map.size(reporters) }
  };
};
