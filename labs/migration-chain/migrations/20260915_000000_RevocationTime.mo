// Migration 2: an *eager* migration.
//
// V1 recorded a revocation's reason and not its time. V2 records both, so every
// stored record is rewritten into the new shape during the upgrade, and the
// revoked count V2 keeps as a counter is derived from the data at the same
// time. The cost is proportional to the number of records — the lab measures
// it — which is why the next migration does not work this way.
//
// A revocation that happened before V2 has no known time. It becomes
// `at = null`, not `at = ?0` and not the upgrade time: inventing a timestamp
// would put a false statement into a provenance record.
import Map "mo:core/Map";

module {
  type StatusV1 = { #active; #revoked : Text };
  type RecordV1 = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : StatusV1;
  };

  public type Status = { #active; #revoked : { reason : Text; at : ?Nat } };
  public type Record = {
    owner : Principal;
    artifactHash : Blob;
    title : Text;
    status : Status;
  };

  public func migration(old : { records : Map.Map<Nat, RecordV1>; schemaVersion : Nat }) : {
    records : Map.Map<Nat, Record>;
    revokedCount : Nat;
    schemaVersion : Nat;
  } {
    var revoked = 0;
    let records = Map.map<Nat, RecordV1, Record>(
      old.records,
      func(_ : Nat, record : RecordV1) : Record {
        let status : Status = switch (record.status) {
          case (#active) #active;
          case (#revoked(reason)) {
            revoked += 1;
            #revoked({ reason; at = null })
          };
        };
        {
          owner = record.owner;
          artifactHash = record.artifactHash;
          title = record.title;
          status;
        }
      },
    );
    assert old.schemaVersion == 1;
    { records; revokedCount = revoked; schemaVersion = 2 }
  };
};
