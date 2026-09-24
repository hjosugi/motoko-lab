import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Icrc3 "Icrc3";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Payment "Payment";
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

  // --------------------------------------------------- verified payment (#12)

  public type Account = Icrc3.Account;

  /// A ledger a controller has allowed, with the metadata that makes an amount
  /// mean something. `price` on a listing is in the ledger's base units; these
  /// say how many decimals that is and what the sender pays on top.
  public type TokenInfo = {
    ledger : Principal;
    symbol : Text;
    decimals : Nat8;
    fee : Nat;
    registeredAt : Nat;
  };

  /// Fixed per listing when it is created. `#verified` when its ledger was
  /// registered at that moment; listings created before #12, or against a
  /// ledger nobody registered, stay `#manual`.
  public type PaymentMode = { #manual; #verified };

  public type IntentStatus = {
    #awaitingPayment;
    #paid : { block : Nat; orderId : Nat; grantId : Nat; at : Nat };
    /// The payment verified, but the listing sold out between the intent and
    /// the confirmation. The payment is recorded and consumed — it must not be
    /// usable twice — and the buyer is owed a refund; see docs/PAYMENTS.md.
    #paidSoldOut : { block : Nat; at : Nat };
  };

  /// What a buyer must pay, to whom, with which memo, by when. Everything a
  /// wallet needs to make the transfer is in here, amounts in base units with
  /// the decimals beside them.
  public type PaymentIntent = {
    id : Nat;
    listingId : Nat;
    buyer : Principal;
    ledger : Principal;
    payTo : Account;
    amount : Nat;
    symbol : Text;
    decimals : Nat8;
    /// The ledger fee when the intent opened. Paid by the buyer on top of
    /// `amount`, never out of it.
    fee : Nat;
    memo : Blob;
    createdAt : Nat;
    expiresAt : Nat;
    status : IntentStatus;
    /// Rejected confirmations, for audit. A rejection does not close the
    /// intent: the buyer may submit the right block.
    rejections : [{ block : Nat; reason : Text; at : Nat }];
  };

  /// The ledger's own account of a payment that created a grant.
  public type VerifiedPayment = {
    intentId : Nat;
    ledger : Principal;
    block : Nat;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : Blob;
    timestamp : Nat;
    verifiedAt : Nat;
  };

  public type PaymentError = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    #soldOut;
    /// The ledger answered, and the block is not a payment for this intent.
    #rejected : Text;
    /// The ledger could not be asked. Nothing changed; retry the same call.
    #ledgerUnavailable : Text;
  };

  public type PaymentResult<T> = { #ok : T; #err : PaymentError };

  let listings = Map.empty<Nat, Listing>();
  let orders = Map.empty<Nat, Order>();
  let grants = Map.empty<Nat, LicenseGrant>();
  let paymentReceiptIndex = Map.empty<Text, Nat>();
  var nextListingId : Nat = 1;
  var nextOrderId : Nat = 1;
  var nextGrantId : Nat = 1;

  // Verified payment (#12). All side tables, so `Listing`, `Order` and
  // `LicenseGrant` keep their exact stable shape and no migration is needed.
  let ledgers = Map.empty<Principal, TokenInfo>();
  let paymentModes = Map.empty<Nat, PaymentMode>();
  let intents = Map.empty<Nat, PaymentIntent>();
  /// Grant id to the payment that created it. A grant with no entry here was
  /// settled by the seller's word under the manual flow.
  let grantPayments = Map.empty<Nat, VerifiedPayment>();
  var nextIntentId : Nat = 1;

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
    let mode : PaymentMode = switch (Map.get(ledgers, Principal.compare, input.currencyLedger)) {
      case (?_) #verified;
      case null #manual;
    };
    Map.add(paymentModes, Nat.compare, id, mode);
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
    // The manual flow is how a forged receipt becomes a grant: the canister
    // records a claim and the seller decides whether to believe it. A listing
    // whose ledger can be asked does not offer that path at all.
    if (modeOf(listing.id) == #verified) {
      return #err(#conflict("this listing only accepts ledger-verified payment: use openPurchase"))
    };
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

  func modeOf(listingId : Nat) : PaymentMode {
    switch (Map.get(paymentModes, Nat.compare, listingId)) {
      case (?mode) mode;
      case null #manual;
    }
  };

  /// Allows a ledger and records its metadata, read from the ledger itself.
  /// Controllers only: which tokens the marketplace accepts is operator policy,
  /// and an allowlisted ledger is trusted to report its own history.
  public shared ({ caller }) func registerLedger(ledger : Principal) : async PaymentResult<TokenInfo> {
    if (not Principal.isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(ledger)) return #err(#invalidInput("ledger is invalid"));
    let token : Icrc3.Ledger = actor (Principal.toText(ledger));
    let metadata = try {
      (await token.icrc1_symbol(), await token.icrc1_decimals(), await token.icrc1_fee())
    } catch (error) {
      return #err(#ledgerUnavailable("the ledger did not answer its ICRC-1 metadata queries: " # Error.message(error)))
    };
    let info : TokenInfo = {
      ledger;
      symbol = metadata.0;
      decimals = metadata.1;
      fee = metadata.2;
      registeredAt = nowNanos();
    };
    Map.add(ledgers, Principal.compare, ledger, info);
    #ok(info)
  };

  /// Opens a payment intent: the exact transfer that will buy this listing.
  public shared ({ caller }) func openPurchase(listingId : Nat) : async PaymentResult<PaymentIntent> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    let ?listing = Map.get(listings, Nat.compare, listingId) else return #err(#notFound);
    if (modeOf(listingId) != #verified) {
      return #err(#conflict("this listing settles manually: use submitPurchase"))
    };
    if (not listing.active) return #err(#conflict("listing is inactive"));
    if (Principal.equal(caller, listing.seller)) return #err(#invalidInput("the seller cannot buy their own listing"));
    switch (listing.supply) {
      case (?supply) { if (listing.sold >= supply) return #err(#soldOut) };
      case null {};
    };
    let ?token = Map.get(ledgers, Principal.compare, listing.currencyLedger) else {
      return #err(#conflict("the listing's ledger is no longer registered"))
    };
    let id = nextIntentId;
    nextIntentId += 1;
    let now = nowNanos();
    let intent : PaymentIntent = {
      id;
      listingId;
      buyer = caller;
      ledger = listing.currencyLedger;
      payTo = { owner = listing.seller; subaccount = null };
      amount = listing.price;
      symbol = token.symbol;
      decimals = token.decimals;
      fee = token.fee;
      memo = Payment.intentMemo(Principal.fromActor(LicenseMarketplace), id);
      createdAt = now;
      expiresAt = now + Payment.intentLifetimeNanos;
      status = #awaitingPayment;
      rejections = [];
    };
    Map.add(intents, Nat.compare, id, intent);
    #ok(intent)
  };

  /// Confirms an intent with the ledger block of its payment, and issues the
  /// grant if the ledger agrees.
  ///
  /// Safe to repeat. A call whose answer was lost — the grant issued, the
  /// response timed out — returns the same grant when repeated with the same
  /// block, and issues nothing new. A call that fails because the ledger could
  /// not be asked changes nothing and can be repeated as is.
  ///
  /// Everything that decides the outcome is re-read *after* the ledger call.
  /// Another message can run while this one waits: a concurrent confirmation of
  /// the same block, a sale that exhausts the supply. Checks made before the
  /// `await` describe a state that may no longer exist.
  public shared ({ caller }) func confirmPayment(intentId : Nat, block : Nat) : async PaymentResult<LicenseGrant> {
    switch (preflight(caller, intentId, block)) {
      case (#done(result)) return result;
      case (#fetch(intent)) {
        let ledger : Icrc3.Ledger = actor (Principal.toText(intent.ledger));
        let fetched = await* Payment.fetchBlock(ledger, block);
        // ---- state may have changed while the ledger was answering ----
        switch (preflight(caller, intentId, block)) {
          case (#done(result)) return result;
          case (#fetch(current)) settle(current, block, fetched);
        }
      };
    }
  };

  type Preflight = { #done : PaymentResult<LicenseGrant>; #fetch : PaymentIntent };

  func preflight(caller : Principal, intentId : Nat, block : Nat) : Preflight {
    let ?intent = Map.get(intents, Nat.compare, intentId) else return #done(#err(#notFound));
    if (not Principal.equal(intent.buyer, caller)) return #done(#err(#unauthorized));
    switch (intent.status) {
      case (#paid(paid)) {
        if (paid.block != block) return #done(#err(#conflict("this intent was paid by a different block")));
        let ?grant = Map.get(grants, Nat.compare, paid.grantId) else return #done(#err(#notFound));
        return #done(#ok(grant))
      };
      case (#paidSoldOut(_)) return #done(#err(#soldOut));
      case (#awaitingPayment) {};
    };
    switch (Map.get(paymentReceiptIndex, Text.compare, paymentKey(intent.ledger, block))) {
      case (?_) return #done(#err(#duplicate("this ledger block has already paid for something")));
      case null {};
    };
    #fetch(intent)
  };

  func reject(intent : PaymentIntent, block : Nat, reason : Text) : PaymentResult<LicenseGrant> {
    let updated : PaymentIntent = {
      intent with rejections = Array.concat(intent.rejections, [{ block; reason; at = nowNanos() }])
    };
    Map.add(intents, Nat.compare, intent.id, updated);
    #err(#rejected(reason))
  };

  func settle(intent : PaymentIntent, block : Nat, fetched : Payment.Fetched) : PaymentResult<LicenseGrant> {
    let raw = switch (fetched) {
      case (#unavailable(reason)) return #err(#ledgerUnavailable(reason));
      case (#missing) return reject(intent, block, "the ledger has no block at that index");
      case (#block(value)) value;
    };
    let transfer = switch (Icrc3.decode(raw)) {
      case (#malformed(reason)) return reject(intent, block, "the block is malformed: " # reason);
      case (#notTransfer(kind)) return reject(intent, block, "the block is not a transfer: " # kind);
      case (#transfer(transfer)) transfer;
    };
    let expected : Payment.Expectation = {
      payer = intent.buyer;
      payee = intent.payTo;
      amount = intent.amount;
      memo = intent.memo;
      notBefore = intent.createdAt;
      notAfter = intent.expiresAt;
    };
    switch (Payment.check(transfer, expected)) {
      case (#rejected(reason)) return reject(intent, block, reason);
      case (#accepted(_)) {};
    };

    // The payment is real. From here it is consumed whatever happens, so the
    // same block can never pay twice.
    let now = nowNanos();
    Map.add(paymentReceiptIndex, Text.compare, paymentKey(intent.ledger, block), intent.id);
    let ?listing = Map.get(listings, Nat.compare, intent.listingId) else return #err(#notFound);
    let soldOut = switch (listing.supply) { case (?supply) listing.sold >= supply; case null false };
    if (soldOut) {
      Map.add(intents, Nat.compare, intent.id, { intent with status = #paidSoldOut({ block; at = now }) });
      return #err(#soldOut)
    };

    let orderId = nextOrderId;
    nextOrderId += 1;
    let grantId = nextGrantId;
    nextGrantId += 1;
    let grant : LicenseGrant = {
      id = grantId; listingId = listing.id; orderId;
      seller = listing.seller; buyer = intent.buyer; proofCanister = listing.proofCanister;
      proofRecordId = listing.proofRecordId; artifactHash = listing.artifactHash;
      termsHash = listing.termsHash; termsUri = listing.termsUri; price = listing.price;
      currencyLedger = listing.currencyLedger; grantedAt = now;
    };
    // The order the manual flow would have produced, so every grant still has
    // one. Its receipt hash is the intent memo: the value the payment carries.
    let order : Order = {
      id = orderId; listingId = listing.id; buyer = intent.buyer; ledger = intent.ledger;
      paymentBlock = block; receiptHash = intent.memo; submittedAt = now;
      status = #accepted({ at = now; grantId });
    };
    Map.add(grants, Nat.compare, grantId, grant);
    Map.add(orders, Nat.compare, orderId, order);
    Map.add(grantPayments, Nat.compare, grantId, {
      intentId = intent.id;
      ledger = intent.ledger;
      block;
      from = transfer.from;
      to = transfer.to;
      amount = transfer.amount;
      fee = transfer.fee;
      memo = intent.memo;
      timestamp = transfer.timestamp;
      verifiedAt = now;
    });
    Map.add(intents, Nat.compare, intent.id, { intent with status = #paid({ block; orderId; grantId; at = now }) });

    let newSold = listing.sold + 1;
    let stillActive = switch (listing.supply) { case (?supply) newSold < supply; case null listing.active };
    Map.add(listings, Nat.compare, listing.id, { listing with sold = newSold; active = stillActive });
    #ok(grant)
  };

  public query func getLedger(ledger : Principal) : async ?TokenInfo { Map.get(ledgers, Principal.compare, ledger) };
  public query func getPaymentMode(listingId : Nat) : async ?PaymentMode {
    let ?_ = Map.get(listings, Nat.compare, listingId) else return null;
    ?modeOf(listingId)
  };
  public query func getIntent(id : Nat) : async ?PaymentIntent { Map.get(intents, Nat.compare, id) };
  /// How a grant was paid for. `null` means the seller settled it by hand.
  public query func getGrantPayment(grantId : Nat) : async ?VerifiedPayment {
    Map.get(grantPayments, Nat.compare, grantId)
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
