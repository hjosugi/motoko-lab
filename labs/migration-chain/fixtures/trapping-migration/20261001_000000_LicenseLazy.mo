// A broken build of migration 3, for the interrupted-rollout rehearsal.
//
// Same file name as the real migration 3, so the canister cannot tell them
// apart by name — exactly the situation of a release that shipped a bug. It
// traps whenever a revoked record exists: a plausible mistake (an assertion
// that held on the developer's data) that only production data reveals.
//
// The test installs V2, seeds revoked records, and upgrades with V3 built
// against this file. The upgrade traps inside the migration, the replica rolls
// the whole upgrade back, and V2 keeps serving the untouched state. A migration
// is only recorded once the upgrade that ran it commits, so the fixed build of
// migration 3 then applies as if the broken one had never been tried.
import Map "mo:core/Map";
import Runtime "mo:core/Runtime";

module {
  type Status = { #active; #revoked : { reason : Text; at : ?Nat } };
  type LegacyRecord = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };
  public type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
    license : ?Text;
  };

  public func migration(old : { records : Map.Map<Nat, LegacyRecord>; schemaVersion : Nat }) : {
    records : Map.Map<Nat, LegacyRecord>;
    recordsV3 : Map.Map<Nat, Record>;
    schemaVersion : Nat;
  } {
    for (record in Map.values(old.records)) {
      if (record.status != #active) Runtime.trap("migration 3: unexpected revoked record");
    };
    { records = old.records; recordsV3 = Map.empty<Nat, Record>(); schemaVersion = 3 }
  };
};
