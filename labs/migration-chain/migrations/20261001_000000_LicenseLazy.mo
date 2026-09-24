// Migration 3: a *lazy* migration.
//
// V3 adds a license to every record. Rewriting every record again, as
// migration 2 did, would make this upgrade's cost grow with the data, and an
// upgrade that runs out of instructions does not happen at all. So this
// migration touches no record. It introduces an empty map for records in the
// V3 shape; the V2-shaped map stays where it is, and the actor converts a
// record the first time it writes it, or in bounded batches through
// `drainLegacy`. The upgrade costs the same at a hundred records or a hundred
// thousand.
import Map "mo:core/Map";

module {
  type Status = { #active; #revoked : { reason : Text; at : ?Nat } };
  public type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
    license : ?Text;
  };

  public func migration(old : { schemaVersion : Nat }) : {
    recordsV3 : Map.Map<Nat, Record>;
    schemaVersion : Nat;
  } {
    assert old.schemaVersion == 2;
    { recordsV3 = Map.empty<Nat, Record>(); schemaVersion = 3 }
  };
};
