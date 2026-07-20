import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor CreatorBountyBoard {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate;
    #conflict : Text;
    #deadlinePassed;
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type BountyStatus = {
    #open;
    #awarded : { submissionId : Nat; awardId : Nat; at : Nat };
    #cancelled : { at : Nat; reason : Text };
  };
  public type Bounty = {
    id : Nat;
    owner : Principal;
    title : Text;
    descriptionHash : Blob;
    descriptionUri : Text;
    criteriaHash : Blob;
    reward : Nat;
    ledger : Principal;
    deadline : Nat;
    createdAt : Nat;
    status : BountyStatus;
  };
  public type BountyInput = {
    title : Text;
    descriptionHash : Blob;
    descriptionUri : Text;
    criteriaHash : Blob;
    reward : Nat;
    ledger : Principal;
    deadline : Nat;
  };
  public type Submission = {
    id : Nat;
    bountyId : Nat;
    submitter : Principal;
    artifactHash : Blob;
    proofCanister : Principal;
    proofRecordId : Nat;
    evidenceUri : Text;
    note : Text;
    submittedAt : Nat;
  };
  public type SubmissionInput = {
    bountyId : Nat;
    artifactHash : Blob;
    proofCanister : Principal;
    proofRecordId : Nat;
    evidenceUri : Text;
    note : Text;
  };
  public type Award = {
    id : Nat;
    bountyId : Nat;
    submissionId : Nat;
    owner : Principal;
    winner : Principal;
    reward : Nat;
    ledger : Principal;
    awardedAt : Nat;
  };
  public type Stats = { bounties : Nat; submissions : Nat; awards : Nat };

  let bounties = Map.empty<Nat, Bounty>();
  let submissions = Map.empty<Nat, Submission>();
  let awards = Map.empty<Nat, Award>();
  let submitterIndex = Map.empty<Text, Nat>();
  var nextBountyId : Nat = 1;
  var nextSubmissionId : Nat = 1;
  var nextAwardId : Nat = 1;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func submissionKey(bountyId : Nat, submitter : Principal) : Text {
    Nat.toText(bountyId) # ":" # Principal.toText(submitter)
  };

  public shared ({ caller }) func createBounty(input : BountyInput) : async Result<Bounty> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    if (not Validation.validText(input.title, 1, 200)) return #err(#invalidInput("title length is invalid"));
    if (not Validation.isDigest(input.descriptionHash)) return #err(#invalidInput("descriptionHash must be 32 bytes"));
    if (not Validation.isDigest(input.criteriaHash)) return #err(#invalidInput("criteriaHash must be 32 bytes"));
    if (not Validation.validText(input.descriptionUri, 1, 2048)) return #err(#invalidInput("descriptionUri length is invalid"));
    if (input.reward == 0) return #err(#invalidInput("reward must be greater than zero"));
    if (Principal.isAnonymous(input.ledger)) return #err(#invalidInput("ledger is invalid"));
    if (input.deadline <= nowNanos()) return #err(#invalidInput("deadline must be in the future"));

    let id = nextBountyId;
    nextBountyId += 1;
    let bounty : Bounty = {
      id = id; owner = caller; title = input.title; descriptionHash = input.descriptionHash;
      descriptionUri = input.descriptionUri; criteriaHash = input.criteriaHash;
      reward = input.reward; ledger = input.ledger; deadline = input.deadline;
      createdAt = nowNanos(); status = #open;
    };
    Map.add(bounties, Nat.compare, id, bounty);
    #ok(bounty)
  };

  public shared ({ caller }) func submit(input : SubmissionInput) : async Result<Submission> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    let ?bounty = Map.get(bounties, Nat.compare, input.bountyId) else return #err(#notFound);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is not open")) };
    if (nowNanos() > bounty.deadline) return #err(#deadlinePassed);
    if (not Validation.isDigest(input.artifactHash)) return #err(#invalidInput("artifactHash must be 32 bytes"));
    if (Principal.isAnonymous(input.proofCanister)) return #err(#invalidInput("proofCanister is invalid"));
    if (not Validation.validText(input.evidenceUri, 1, 2048)) return #err(#invalidInput("evidenceUri length is invalid"));
    if (not Validation.validText(input.note, 0, 1000)) return #err(#invalidInput("note length is invalid"));
    let key = submissionKey(input.bountyId, caller);
    switch (Map.get(submitterIndex, Text.compare, key)) { case (?_) return #err(#duplicate); case null {} };

    let id = nextSubmissionId;
    nextSubmissionId += 1;
    let submission : Submission = {
      id = id; bountyId = input.bountyId; submitter = caller; artifactHash = input.artifactHash;
      proofCanister = input.proofCanister; proofRecordId = input.proofRecordId;
      evidenceUri = input.evidenceUri; note = input.note; submittedAt = nowNanos();
    };
    Map.add(submissions, Nat.compare, id, submission);
    Map.add(submitterIndex, Text.compare, key, id);
    #ok(submission)
  };

  public shared ({ caller }) func award(bountyId : Nat, submissionId : Nat) : async Result<Award> {
    let ?bounty = Map.get(bounties, Nat.compare, bountyId) else return #err(#notFound);
    if (bounty.owner != caller) return #err(#unauthorized);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is already closed")) };
    let ?submission = Map.get(submissions, Nat.compare, submissionId) else return #err(#notFound);
    if (submission.bountyId != bountyId) return #err(#invalidInput("submission belongs to another bounty"));

    let id = nextAwardId;
    nextAwardId += 1;
    let now = nowNanos();
    let award : Award = {
      id = id; bountyId = bountyId; submissionId = submissionId; owner = bounty.owner;
      winner = submission.submitter; reward = bounty.reward; ledger = bounty.ledger; awardedAt = now;
    };
    Map.add(awards, Nat.compare, id, award);
    let updated : Bounty = {
      id = bounty.id; owner = bounty.owner; title = bounty.title;
      descriptionHash = bounty.descriptionHash; descriptionUri = bounty.descriptionUri;
      criteriaHash = bounty.criteriaHash; reward = bounty.reward; ledger = bounty.ledger;
      deadline = bounty.deadline; createdAt = bounty.createdAt;
      status = #awarded({ submissionId = submissionId; awardId = id; at = now });
    };
    Map.add(bounties, Nat.compare, bountyId, updated);
    #ok(award)
  };

  public shared ({ caller }) func cancelBounty(id : Nat, reason : Text) : async Result<Bounty> {
    if (not Validation.validText(reason, 1, 1000)) return #err(#invalidInput("reason length is invalid"));
    let ?bounty = Map.get(bounties, Nat.compare, id) else return #err(#notFound);
    if (bounty.owner != caller) return #err(#unauthorized);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is already closed")) };
    let updated : Bounty = {
      id = bounty.id; owner = bounty.owner; title = bounty.title;
      descriptionHash = bounty.descriptionHash; descriptionUri = bounty.descriptionUri;
      criteriaHash = bounty.criteriaHash; reward = bounty.reward; ledger = bounty.ledger;
      deadline = bounty.deadline; createdAt = bounty.createdAt;
      status = #cancelled({ at = nowNanos(); reason = reason });
    };
    Map.add(bounties, Nat.compare, id, updated);
    #ok(updated)
  };

  public query func getBounty(id : Nat) : async ?Bounty { Map.get(bounties, Nat.compare, id) };
  public query func getSubmission(id : Nat) : async ?Submission { Map.get(submissions, Nat.compare, id) };
  public query func getAward(id : Nat) : async ?Award { Map.get(awards, Nat.compare, id) };

  public query func listBounties(start : Nat, limit : Nat) : async [Bounty] {
    let entries = Iter.take(Map.entriesFrom(bounties, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, Bounty), Bounty>(entries, func(entry : (Nat, Bounty)) : Bounty { entry.1 }))
  };

  public query func stats() : async Stats {
    { bounties = Map.size(bounties); submissions = Map.size(submissions); awards = Map.size(awards) }
  };
};
