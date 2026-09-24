// V1 of the migration-chain fixture. Built with migrations/ up to and
// including 20260901_000000_Init.mo; see test/migration-chain.test.mjs.
//
// Under `--enhanced-migration` stable fields have no initializers: their
// values come from the migration chain and nowhere else.
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Prim "mo:⛔";
import Fixture "Fixture";

persistent actor {
  type Status = { #active; #revoked : Text };
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
  // Written by the migrations and by nothing else.
  let schemaVersion : Nat;

  // Instructions spent in the message that installed or upgraded this
  // version, measured when the actor body runs — after the pending
  // migrations. Transient, so each upgrade measures itself.
  transient let upgradeInstructions : Nat64 = Prim.performanceCounter(0);

  func view(id : Nat, record : Record) : View {
    { id; owner = record.owner; artifactHash = record.artifactHash; title = record.title; status = record.status }
  };

  public shared ({ caller }) func register(artifactHash : Blob, title : Text) : async Nat {
    let id = nextId;
    nextId += 1;
    Map.add(records, Nat.compare, id, { owner = caller; artifactHash; title; status = #active });
    id
  };

  public shared ({ caller }) func revoke(id : Nat, reason : Text) : async Bool {
    let ?record = Map.get(records, Nat.compare, id) else return false;
    if (record.owner != caller or record.status != #active) return false;
    Map.add(records, Nat.compare, id, { record with status = #revoked(reason) });
    true
  };

  /// Controller-only: appends `count` deterministic records (see Fixture).
  public shared ({ caller }) func seed(count : Nat) : async Nat {
    assert Principal.isController(caller) and count <= Fixture.maxSeedBatch;
    for (_ in Nat.range(0, count)) {
      let id = nextId;
      nextId += 1;
      let status : Status = if (Fixture.seededRevoked(id)) #revoked(Fixture.seededReason) else #active;
      Map.add(records, Nat.compare, id, { owner = caller; artifactHash = Fixture.seededHash(id); title = Fixture.seededTitle(id); status });
    };
    Map.size(records)
  };

  public query func get(id : Nat) : async ?View {
    let ?record = Map.get(records, Nat.compare, id) else return null;
    ?view(id, record)
  };

  public query func stats() : async Stats {
    let revoked = Iter.size(Iter.filter<Record>(Map.values(records), func(r : Record) : Bool { r.status != #active }));
    {
      schemaVersion;
      records = Map.size(records);
      revoked;
      nextId;
      upgradeInstructions;
      heapBytes = Prim.rts_heap_size();
      memoryBytes = Prim.rts_memory_size();
    }
  };
};
