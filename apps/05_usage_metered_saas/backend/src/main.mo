import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Array "mo:core/Array";
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

  func currentTenant(tenant : Tenant, now : Nat) : Tenant {
    let periodNanos = tenant.plan.periodSeconds * 1_000_000_000;
    if (now >= tenant.periodStartedAt + periodNanos) {
      {
        principal = tenant.principal; displayName = tenant.displayName; plan = tenant.plan;
        used = 0; periodStartedAt = now; enabled = tenant.enabled; createdAt = tenant.createdAt;
      }
    } else tenant
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
    let ?current = Map.get(tenants, Principal.compare, tenantPrincipal) else return #err(#notFound);
    let updated : Tenant = {
      principal = current.principal; displayName = current.displayName; plan = plan;
      used = 0; periodStartedAt = nowNanos(); enabled = current.enabled; createdAt = current.createdAt;
    };
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
  func record(tenantPrincipal : Principal, units : Nat, category : Text, idempotencyKey : Text, by : Principal, now : Nat) : Recorded {
    let ?storedTenant = Map.get(tenants, Principal.compare, tenantPrincipal) else return #rejected(#tenantUnavailable);
    let tenant = currentTenant(storedTenant, now);
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
    switch (record(input.tenant, input.units, input.category, input.idempotencyKey, caller, now)) {
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
    switch (record(receipt.tenant, receipt.units, receipt.category, receipt.idempotencyKey, caller, now)) {
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
