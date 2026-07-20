import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor LicenseMarketplace {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    #soldOut;
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type Listing = {
    id : Nat;
    seller : Principal;
    proofCanister : Principal;
    proofRecordId : Nat;
    artifactHash : Blob;
    title : Text;
    termsHash : Blob;
    termsUri : Text;
    price : Nat;
    currencyLedger : Principal;
    supply : ?Nat;
    sold : Nat;
    active : Bool;
    createdAt : Nat;
  };
  public type ListingInput = {
    proofCanister : Principal;
    proofRecordId : Nat;
    artifactHash : Blob;
    title : Text;
    termsHash : Blob;
    termsUri : Text;
    price : Nat;
    currencyLedger : Principal;
    supply : ?Nat;
  };
  public type OrderStatus = {
    #paymentSubmitted;
    #accepted : { at : Nat; grantId : Nat };
    #rejected : { at : Nat; reason : Text };
  };
  public type Order = {
    id : Nat;
    listingId : Nat;
    buyer : Principal;
    ledger : Principal;
    paymentBlock : Nat;
    receiptHash : Blob;
    submittedAt : Nat;
    status : OrderStatus;
  };
  public type PurchaseInput = {
    listingId : Nat;
    ledger : Principal;
    paymentBlock : Nat;
    receiptHash : Blob;
  };
  public type LicenseGrant = {
    id : Nat;
    listingId : Nat;
    orderId : Nat;
    seller : Principal;
    buyer : Principal;
    proofCanister : Principal;
    proofRecordId : Nat;
    artifactHash : Blob;
    termsHash : Blob;
    termsUri : Text;
    price : Nat;
    currencyLedger : Principal;
    grantedAt : Nat;
  };
  public type Stats = { listings : Nat; orders : Nat; grants : Nat };

  let listings = Map.empty<Nat, Listing>();
  let orders = Map.empty<Nat, Order>();
  let grants = Map.empty<Nat, LicenseGrant>();
  let paymentReceiptIndex = Map.empty<Text, Nat>();
  var nextListingId : Nat = 1;
  var nextOrderId : Nat = 1;
  var nextGrantId : Nat = 1;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func paymentKey(ledger : Principal, block : Nat) : Text {
    Principal.toText(ledger) # ":" # Nat.toText(block)
  };

  func validateListing(input : ListingInput) : ?Error {
    if (Principal.isAnonymous(input.proofCanister)) return ?#invalidInput("proofCanister is invalid");
    if (Principal.isAnonymous(input.currencyLedger)) return ?#invalidInput("currencyLedger is invalid");
    if (not Validation.isDigest(input.artifactHash)) return ?#invalidInput("artifactHash must be 32 bytes");
    if (not Validation.isDigest(input.termsHash)) return ?#invalidInput("termsHash must be 32 bytes");
    if (not Validation.validText(input.title, 1, 200)) return ?#invalidInput("title length is invalid");
    if (not Validation.validText(input.termsUri, 1, 2048)) return ?#invalidInput("termsUri length is invalid");
    if (input.price == 0) return ?#invalidInput("price must be greater than zero");
    switch (input.supply) {
      case (?supply) { if (supply == 0) return ?#invalidInput("supply must be greater than zero") };
      case null {};
    };
    null
  };

  public shared ({ caller }) func createListing(input : ListingInput) : async Result<Listing> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    switch (validateListing(input)) { case (?error) return #err(error); case null {} };
    let id = nextListingId;
    nextListingId += 1;
    let listing : Listing = {
      id = id;
      seller = caller;
      proofCanister = input.proofCanister;
      proofRecordId = input.proofRecordId;
      artifactHash = input.artifactHash;
      title = input.title;
      termsHash = input.termsHash;
      termsUri = input.termsUri;
      price = input.price;
      currencyLedger = input.currencyLedger;
      supply = input.supply;
      sold = 0;
      active = true;
      createdAt = nowNanos();
    };
    Map.add(listings, Nat.compare, id, listing);
    #ok(listing)
  };

  public shared ({ caller }) func setListingActive(id : Nat, active : Bool) : async Result<Listing> {
    let ?current = Map.get(listings, Nat.compare, id) else return #err(#notFound);
    if (current.seller != caller) return #err(#unauthorized);
    let updated : Listing = {
      id = current.id; seller = current.seller; proofCanister = current.proofCanister;
      proofRecordId = current.proofRecordId; artifactHash = current.artifactHash;
      title = current.title; termsHash = current.termsHash; termsUri = current.termsUri;
      price = current.price; currencyLedger = current.currencyLedger; supply = current.supply;
      sold = current.sold; active = active; createdAt = current.createdAt;
    };
    Map.add(listings, Nat.compare, id, updated);
    #ok(updated)
  };

  public shared ({ caller }) func submitPurchase(input : PurchaseInput) : async Result<Order> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    if (not Validation.isDigest(input.receiptHash)) return #err(#invalidInput("receiptHash must be 32 bytes"));
    let ?listing = Map.get(listings, Nat.compare, input.listingId) else return #err(#notFound);
    if (not listing.active) return #err(#conflict("listing is inactive"));
    if (input.ledger != listing.currencyLedger) return #err(#invalidInput("ledger does not match listing"));
    switch (listing.supply) {
      case (?supply) { if (listing.sold >= supply) return #err(#soldOut) };
      case null {};
    };
    let key = paymentKey(input.ledger, input.paymentBlock);
    switch (Map.get(paymentReceiptIndex, Text.compare, key)) {
      case (?_) return #err(#duplicate("payment receipt already used"));
      case null {};
    };
    let id = nextOrderId;
    nextOrderId += 1;
    let order : Order = {
      id = id; listingId = input.listingId; buyer = caller; ledger = input.ledger;
      paymentBlock = input.paymentBlock; receiptHash = input.receiptHash;
      submittedAt = nowNanos(); status = #paymentSubmitted;
    };
    Map.add(orders, Nat.compare, id, order);
    Map.add(paymentReceiptIndex, Text.compare, key, id);
    #ok(order)
  };

  public shared ({ caller }) func acceptPurchase(orderId : Nat) : async Result<LicenseGrant> {
    let ?order = Map.get(orders, Nat.compare, orderId) else return #err(#notFound);
    let ?listing = Map.get(listings, Nat.compare, order.listingId) else return #err(#notFound);
    if (listing.seller != caller) return #err(#unauthorized);
    switch (order.status) {
      case (#paymentSubmitted) {};
      case _ return #err(#conflict("order is already settled"));
    };
    switch (listing.supply) {
      case (?supply) { if (listing.sold >= supply) return #err(#soldOut) };
      case null {};
    };

    let grantId = nextGrantId;
    nextGrantId += 1;
    let grant : LicenseGrant = {
      id = grantId; listingId = listing.id; orderId = order.id;
      seller = listing.seller; buyer = order.buyer; proofCanister = listing.proofCanister;
      proofRecordId = listing.proofRecordId; artifactHash = listing.artifactHash;
      termsHash = listing.termsHash; termsUri = listing.termsUri; price = listing.price;
      currencyLedger = listing.currencyLedger; grantedAt = nowNanos();
    };
    Map.add(grants, Nat.compare, grantId, grant);

    let acceptedOrder : Order = {
      id = order.id; listingId = order.listingId; buyer = order.buyer; ledger = order.ledger;
      paymentBlock = order.paymentBlock; receiptHash = order.receiptHash;
      submittedAt = order.submittedAt; status = #accepted({ at = nowNanos(); grantId = grantId });
    };
    Map.add(orders, Nat.compare, order.id, acceptedOrder);

    let newSold = listing.sold + 1;
    let stillActive = switch (listing.supply) { case (?supply) newSold < supply; case null listing.active };
    let updatedListing : Listing = {
      id = listing.id; seller = listing.seller; proofCanister = listing.proofCanister;
      proofRecordId = listing.proofRecordId; artifactHash = listing.artifactHash;
      title = listing.title; termsHash = listing.termsHash; termsUri = listing.termsUri;
      price = listing.price; currencyLedger = listing.currencyLedger; supply = listing.supply;
      sold = newSold; active = stillActive; createdAt = listing.createdAt;
    };
    Map.add(listings, Nat.compare, listing.id, updatedListing);
    #ok(grant)
  };

  public shared ({ caller }) func rejectPurchase(orderId : Nat, reason : Text) : async Result<Order> {
    if (not Validation.validText(reason, 1, 1000)) return #err(#invalidInput("reason length is invalid"));
    let ?order = Map.get(orders, Nat.compare, orderId) else return #err(#notFound);
    let ?listing = Map.get(listings, Nat.compare, order.listingId) else return #err(#notFound);
    if (listing.seller != caller) return #err(#unauthorized);
    switch (order.status) { case (#paymentSubmitted) {}; case _ return #err(#conflict("order is already settled")) };
    let updated : Order = {
      id = order.id; listingId = order.listingId; buyer = order.buyer; ledger = order.ledger;
      paymentBlock = order.paymentBlock; receiptHash = order.receiptHash;
      submittedAt = order.submittedAt; status = #rejected({ at = nowNanos(); reason = reason });
    };
    Map.add(orders, Nat.compare, order.id, updated);
    #ok(updated)
  };

  public query func getListing(id : Nat) : async ?Listing { Map.get(listings, Nat.compare, id) };
  public query func getOrder(id : Nat) : async ?Order { Map.get(orders, Nat.compare, id) };
  public query func getGrant(id : Nat) : async ?LicenseGrant { Map.get(grants, Nat.compare, id) };

  public query func listListings(start : Nat, limit : Nat) : async [Listing] {
    let entries = Iter.take(Map.entriesFrom(listings, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, Listing), Listing>(entries, func(entry : (Nat, Listing)) : Listing { entry.1 }))
  };

  public query func stats() : async Stats {
    { listings = Map.size(listings); orders = Map.size(orders); grants = Map.size(grants) }
  };
};
