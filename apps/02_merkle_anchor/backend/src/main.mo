import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor MerkleAnchor {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate;
    #conflict : Text;
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type Status = {
    #active;
    #revoked : { at : Nat; reason : Text };
  };
  public type Batch = {
    id : Nat;
    owner : Principal;
    root : Blob;
    leafCount : Nat;
    hashAlgorithm : Text;
    treeVersion : Text;
    schemaUri : Text;
    policyUri : Text;
    manifestUri : Text;
    supersedes : ?Nat;
    createdAt : Nat;
    status : Status;
  };
  public type AnchorInput = {
    root : Blob;
    leafCount : Nat;
    hashAlgorithm : Text;
    treeVersion : Text;
    schemaUri : Text;
    policyUri : Text;
    manifestUri : Text;
    supersedes : ?Nat;
  };
  public type Stats = { batches : Nat; active : Nat; revoked : Nat };

  let batches = Map.empty<Nat, Batch>();
  let rootIndex = Map.empty<Blob, Nat>();
  var nextId : Nat = 1;
  var activeCount : Nat = 0;
  var revokedCount : Nat = 0;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func validate(input : AnchorInput) : ?Error {
    if (not Validation.isDigest(input.root)) return ?#invalidInput("root must be 32 bytes");
    if (input.leafCount == 0 or input.leafCount > 1_000_000) {
      return ?#invalidInput("leafCount must be between 1 and 1,000,000")
    };
    if (not Validation.validText(input.hashAlgorithm, 1, 50)) return ?#invalidInput("hashAlgorithm length is invalid");
    if (not Validation.validText(input.treeVersion, 1, 50)) return ?#invalidInput("treeVersion length is invalid");
    if (not Validation.validText(input.schemaUri, 1, 2048)) return ?#invalidInput("schemaUri length is invalid");
    if (not Validation.validText(input.policyUri, 1, 2048)) return ?#invalidInput("policyUri length is invalid");
    if (not Validation.validText(input.manifestUri, 1, 2048)) return ?#invalidInput("manifestUri length is invalid");
    null
  };

  public shared ({ caller }) func anchor(input : AnchorInput) : async Result<Batch> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    switch (validate(input)) { case (?error) return #err(error); case null {} };
    switch (Map.get(rootIndex, Blob.compare, input.root)) {
      case (?_) return #err(#duplicate);
      case null {};
    };
    switch (input.supersedes) {
      case (?previousId) {
        let ?previous = Map.get(batches, Nat.compare, previousId) else return #err(#notFound);
        if (previous.owner != caller) return #err(#unauthorized);
      };
      case null {};
    };
    let id = nextId;
    nextId += 1;
    let batch : Batch = {
      id = id;
      owner = caller;
      root = input.root;
      leafCount = input.leafCount;
      hashAlgorithm = input.hashAlgorithm;
      treeVersion = input.treeVersion;
      schemaUri = input.schemaUri;
      policyUri = input.policyUri;
      manifestUri = input.manifestUri;
      supersedes = input.supersedes;
      createdAt = nowNanos();
      status = #active;
    };
    Map.add(batches, Nat.compare, id, batch);
    Map.add(rootIndex, Blob.compare, input.root, id);
    activeCount += 1;
    #ok(batch)
  };

  public shared ({ caller }) func revoke(id : Nat, reason : Text) : async Result<Batch> {
    if (not Validation.validText(reason, 1, 1000)) return #err(#invalidInput("reason length is invalid"));
    let ?current = Map.get(batches, Nat.compare, id) else return #err(#notFound);
    if (current.owner != caller) return #err(#unauthorized);
    switch (current.status) {
      case (#active) {};
      case (#revoked(_)) return #err(#conflict("batch is already revoked"));
    };
    let updated : Batch = {
      id = current.id;
      owner = current.owner;
      root = current.root;
      leafCount = current.leafCount;
      hashAlgorithm = current.hashAlgorithm;
      treeVersion = current.treeVersion;
      schemaUri = current.schemaUri;
      policyUri = current.policyUri;
      manifestUri = current.manifestUri;
      supersedes = current.supersedes;
      createdAt = current.createdAt;
      status = #revoked({ at = nowNanos(); reason = reason });
    };
    Map.add(batches, Nat.compare, id, updated);
    activeCount -= 1;
    revokedCount += 1;
    #ok(updated)
  };

  public query func getBatch(id : Nat) : async ?Batch { Map.get(batches, Nat.compare, id) };

  public query func getByRoot(root : Blob) : async ?Batch {
    let ?id = Map.get(rootIndex, Blob.compare, root) else return null;
    Map.get(batches, Nat.compare, id)
  };

  public query func listBatches(start : Nat, limit : Nat) : async [Batch] {
    let entries = Iter.take(Map.entriesFrom(batches, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, Batch), Batch>(entries, func(entry : (Nat, Batch)) : Batch { entry.1 }))
  };

  public query func stats() : async Stats {
    { batches = Map.size(batches); active = activeCount; revoked = revokedCount }
  };
};
