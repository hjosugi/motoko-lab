import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
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

  let tenants = Map.empty<Principal, Tenant>();
  let apiKeys = Map.empty<Blob, ApiKeyRecord>();
  let usageEvents = Map.empty<Nat, UsageEvent>();
  let usageIdempotency = Map.empty<Text, Nat>();
  let reporters = Map.empty<Principal, Bool>();
  var nextEventId : Nat = 1;

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

  public shared ({ caller }) func recordUsage(input : UsageInput) : async Result<UsageEvent> {
    if (not isReporter(caller)) return #err(#unauthorized);
    if (input.units == 0 or input.units > 1_000_000_000) return #err(#invalidInput("units is invalid"));
    if (not Validation.validText(input.category, 1, 100)) return #err(#invalidInput("category length is invalid"));
    if (not Validation.validText(input.idempotencyKey, 1, 200)) return #err(#invalidInput("idempotencyKey length is invalid"));
    let ?storedTenant = Map.get(tenants, Principal.compare, input.tenant) else return #err(#notFound);
    let now = nowNanos();
    let tenant = currentTenant(storedTenant, now);
    if (not tenant.enabled) return #err(#conflict("tenant is disabled"));
    let scopedKey = Principal.toText(input.tenant) # ":" # input.idempotencyKey;
    switch (Map.get(usageIdempotency, Text.compare, scopedKey)) {
      case (?existingId) {
        let ?existing = Map.get(usageEvents, Nat.compare, existingId) else return #err(#conflict("idempotency index is inconsistent"));
        return #ok(existing)
      };
      case null {};
    };
    if (tenant.used + input.units > tenant.plan.quota) {
      return #err(#quotaExceeded({ quota = tenant.plan.quota; used = tenant.used; requested = input.units }))
    };

    let id = nextEventId;
    nextEventId += 1;
    let event : UsageEvent = {
      id = id; tenant = input.tenant; units = input.units; category = input.category;
      idempotencyKey = input.idempotencyKey; recordedBy = caller; recordedAt = now;
    };
    Map.add(usageEvents, Nat.compare, id, event);
    Map.add(usageIdempotency, Text.compare, scopedKey, id);
    let updatedTenant : Tenant = {
      principal = tenant.principal; displayName = tenant.displayName; plan = tenant.plan;
      used = tenant.used + input.units; periodStartedAt = tenant.periodStartedAt;
      enabled = tenant.enabled; createdAt = tenant.createdAt;
    };
    Map.add(tenants, Principal.compare, input.tenant, updatedTenant);
    #ok(event)
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
