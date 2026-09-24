// V2: built with migrations/ through 20260915_000000_RevocationTime.mo.
//
// A revocation now records its time, and the revoked count is a counter kept
// alongside the map instead of a scan — migration 2 derived it from the V1
// data, and `stats` exposes both so the test can check they agree.
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Prim "mo:⛔";
import Fixture "Fixture";

persistent actor {
  type Status = { #active; #revoked : { reason : Text; at : ?Nat } };
  type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };

  public type View = {
    id : Nat;
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };

  public type Stats = {
    schemaVersion : Nat;
    records : Nat;
    revoked : Nat;
    nextId : Nat;
    upgradeInstructions : Nat64;
    heapBytes : Nat;
    memoryBytes : Nat;
  };

  let records : Map.Map<Nat, Record>;
  var nextId : Nat;
  var revokedCount : Nat;
  let schemaVersion : Nat;

  transient let upgradeInstructions : Nat64 = Prim.performanceCounter(0);

  func now() : Nat { Int.abs(Time.now()) };

  public shared ({ caller }) func register(artifactHash : Blob, title : Text) : async Nat {
    let id = nextId;
    nextId += 1;
    Map.add(records, Nat.compare, id, { owner = caller; artifactHash; title; status = #active });
    id
  };

  public shared ({ caller }) func revoke(id : Nat, reason : Text) : async Bool {
    let ?record = Map.get(records, Nat.compare, id) else return false;
    if (record.owner != caller or record.status != #active) return false;
    Map.add(records, Nat.compare, id, { record with status = #revoked({ reason; at = ?now() }) });
    revokedCount += 1;
    true
  };

  public shared ({ caller }) func seed(count : Nat) : async Nat {
    assert Principal.isController(caller) and count <= Fixture.maxSeedBatch;
    for (_ in Nat.range(0, count)) {
      let id = nextId;
      nextId += 1;
      let status : Status = if (Fixture.seededRevoked(id)) {
        revokedCount += 1;
        #revoked({ reason = Fixture.seededReason; at = null })
      } else #active;
      Map.add(records, Nat.compare, id, { owner = caller; artifactHash = Fixture.seededHash(id); title = Fixture.seededTitle(id); status });
    };
    Map.size(records)
  };

  public query func get(id : Nat) : async ?View {
    let ?record = Map.get(records, Nat.compare, id) else return null;
    ?{ id; owner = record.owner; artifactHash = record.artifactHash; title = record.title; status = record.status }
  };

  public query func stats() : async Stats {
    {
      schemaVersion;
      records = Map.size(records);
      revoked = revokedCount;
      nextId;
      upgradeInstructions;
      heapBytes = Prim.rts_heap_size();
      memoryBytes = Prim.rts_memory_size();
    }
  };
};
