// Migration 1 of the chain: the initial state.
//
// Every migration freezes the types it reads and writes *here*, not in a shared
// Types module. A migration is history: it has to go on describing the state as
// it was when it shipped, and a shared module that later changed would change
// what this file means without anyone editing it.
import Map "mo:core/Map";

module {
  public type Status = { #active; #revoked : Text };
  public type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };

  public func migration(_ : {}) : {
    records : Map.Map<Nat, Record>;
    nextId : Nat;
    schemaVersion : Nat;
  } {
    { records = Map.empty<Nat, Record>(); nextId = 1; schemaVersion = 1 }
  };
};
