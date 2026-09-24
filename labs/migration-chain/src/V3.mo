// V3: built with migrations/ through 20261001_000000_LicenseLazy.mo.
//
// Records gain a license, lazily. Migration 3 added an empty map for V3-shaped
// records and touched nothing else; `records` still holds every record written
// before V3, in the V2 shape. Reads look in the V3 map first and convert on
// the fly; a write moves the record into the V3 map; `drainLegacy` moves them
// in bounded batches so the conversion can finish without any one message
// having to do all of it.
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Prim "mo:⛔";
import Fixture "Fixture";

persistent actor {
  type Status = { #active; #revoked : { reason : Text; at : ?Nat } };
  type LegacyRecord = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };
  type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
    license : ?Text;
  };

  public type View = {
    id : Nat;
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
    license : ?Text;
  };

  public type Stats = {
    schemaVersion : Nat;
    records : Nat;
    revoked : Nat;
    nextId : Nat;
    upgradeInstructions : Nat64;
    heapBytes : Nat;
    memoryBytes : Nat;
    /// Records still in the V2 shape, waiting to be converted.
    legacy : Nat;
  };

  /// V2-shaped records not yet converted. Only ever shrinks under V3.
  let records : Map.Map<Nat, LegacyRecord>;
  let recordsV3 : Map.Map<Nat, Record>;
  var nextId : Nat;
  var revokedCount : Nat;
  let schemaVersion : Nat;

  transient let upgradeInstructions : Nat64 = Prim.performanceCounter(0);

  func now() : Nat { Int.abs(Time.now()) };

  func upgrade(legacy : LegacyRecord) : Record {
    // No license is known for a record written before V3. `null`, not a
    // default license: a license nobody granted is not one to invent.
    { legacy with license = null }
  };

  /// The current record, converting from the legacy map if needed. Does not
  /// write: a query cannot, and a read should not change what it reads.
  func find(id : Nat) : ?Record {
    switch (Map.get(recordsV3, Nat.compare, id)) {
      case (?record) ?record;
      case null {
        switch (Map.get(records, Nat.compare, id)) {
          case (?legacy) ?upgrade(legacy);
          case null null;
        }
      };
    }
  };

  /// Writes a record in the V3 shape and retires its legacy copy, so a record
  /// is never in both maps and the two maps together are the whole state.
  func store(id : Nat, record : Record) {
    Map.add(recordsV3, Nat.compare, id, record);
    Map.remove(records, Nat.compare, id);
  };

  public shared ({ caller }) func register(artifactHash : Blob, title : Text) : async Nat {
    let id = nextId;
    nextId += 1;
    store(id, { owner = caller; artifactHash; title; status = #active; license = null });
    id
  };

  public shared ({ caller }) func revoke(id : Nat, reason : Text) : async Bool {
    let ?record = find(id) else return false;
    if (record.owner != caller or record.status != #active) return false;
    store(id, { record with status = #revoked({ reason; at = ?now() }) });
    revokedCount += 1;
    true
  };

  public shared ({ caller }) func setLicense(id : Nat, license : Text) : async Bool {
    let ?record = find(id) else return false;
    if (record.owner != caller) return false;
    store(id, { record with license = ?license });
    true
  };

  /// Controller-only: converts up to `limit` legacy records and returns how
  /// many remain. Bounded work per message is what makes a lazy migration
  /// finishable at any data size.
  public shared ({ caller }) func drainLegacy(limit : Nat) : async Nat {
    assert Principal.isController(caller);
    let batch = Map.toArray(records);
    var moved = 0;
    label drain for ((id, legacy) in batch.values()) {
      if (moved >= limit) break drain;
      store(id, upgrade(legacy));
      moved += 1;
    };
    Map.size(records)
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
      store(id, { owner = caller; artifactHash = Fixture.seededHash(id); title = Fixture.seededTitle(id); status; license = null });
    };
    Map.size(records) + Map.size(recordsV3)
  };

  public query func get(id : Nat) : async ?View {
    let ?record = find(id) else return null;
    ?{ id; owner = record.owner; artifactHash = record.artifactHash; title = record.title; status = record.status; license = record.license }
  };

  public query func stats() : async Stats {
    {
      schemaVersion;
      records = Map.size(records) + Map.size(recordsV3);
      revoked = revokedCount;
      nextId;
      upgradeInstructions;
      heapBytes = Prim.rts_heap_size();
      memoryBytes = Prim.rts_memory_size();
      legacy = Map.size(records);
    }
  };
};
