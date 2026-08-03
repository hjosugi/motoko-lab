/// Deterministic word level tokenizer.
///
/// Every step here is integer or string comparison only. No hashing with a
/// random seed, no floating point, no iteration order that depends on memory
/// addresses: two replicas that start from the same corpus build the same
/// vocabulary in the same order, so token id `k` means the same thing on every
/// node of a subnet and in every shard of the cluster.
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Iter "mo:core/Iter";
import Text "mo:core/Text";
import Char "mo:core/Char";
import Nat32 "mo:core/Nat32";

module {

  public type TokenId = Nat;

  /// Sorted, de-duplicated token table. Lookup is a binary search over
  /// `tokens`, so no auxiliary hash map (and no hash seed) is involved.
  public type Vocab = {
    tokens : [Text];
  };

  /// Token emitted for anything the vocabulary does not contain.
  public let unknown : Text = "<unk>";

  /// Lowercases ASCII and drops characters that are neither letters, digits nor
  /// sentence punctuation. Non-ASCII is preserved verbatim.
  func normalizeChar(c : Char) : ?Char {
    let p = Char.toNat32(c);
    if (p >= 65 and p <= 90) return ?Nat32.toChar(p + 32); // A-Z -> a-z
    if (p >= 97 and p <= 122) return ?c;
    if (p >= 48 and p <= 57) return ?c;
    if (c == '.' or c == ',' or c == '?' or c == '!') return ?c;
    if (p < 128) return null;
    ?c;
  };

  func isSpace(c : Char) : Bool {
    c == ' ' or c == '\n' or c == '\t' or c == '\r';
  };

  func normalize(chunk : Text) : Text {
    Text.fromIter(Iter.filterMap(chunk.chars(), normalizeChar));
  };

  /// Splits raw text into normalized words. The corpus already separates
  /// sentence punctuation with spaces, so whitespace splitting is enough and
  /// `.` survives as its own token.
  public func words(raw : Text) : [Text] {
    Iter.toArray(
      Iter.filter(
        Iter.map(Text.split(raw, #predicate isSpace), normalize),
        func(t : Text) : Bool { t != "" },
      )
    );
  };

  /// Builds a vocabulary from a token stream.
  ///
  /// `<unk>` is pinned at id 0 so an out-of-vocabulary word keeps a stable id
  /// even when the corpus changes. It is *not* in sort position: `'<'` (0x3C)
  /// sorts after `'.'` (0x2E), `','` and the digits, so a corpus containing
  /// sentence punctuation would break a binary search that included index 0.
  /// The sorted, searchable region is therefore `[1, size)`, and `idOf`
  /// special-cases `<unk>` instead.
  public func buildVocab(tokens : [Text]) : Vocab {
    let sorted = Array.sort(tokens, Text.compare);
    let unique = VarArray.repeat<Text>("", sorted.size() + 1);
    unique[0] := unknown;
    var n = 1;
    var last = unknown;
    for (w in sorted.vals()) {
      if (w != unknown and w != last) {
        unique[n] := w;
        n += 1;
        last := w;
      };
    };
    { tokens = Array.tabulate<Text>(n, func(k : Nat) : Text { unique[k] }) };
  };

  public func size(v : Vocab) : Nat { v.tokens.size() };

  /// Binary search over the sorted region of the token table.
  ///
  /// The search starts at 1: index 0 holds `<unk>`, which is deliberately out
  /// of sort position (see `buildVocab`). Including it would make the search
  /// unsound for any token that sorts before `"<unk>"`, which is every
  /// punctuation and digit token.
  public func idOf(v : Vocab, word : Text) : TokenId {
    if (word == unknown) return 0;
    var lo = 1;
    var hi = v.tokens.size();
    while (lo < hi) {
      let mid = (lo + hi) / 2;
      switch (Text.compare(v.tokens[mid], word)) {
        case (#less) lo := mid + 1;
        case (#greater) hi := mid;
        case (#equal) return mid;
      };
    };
    0 // <unk>
  };

  public func textOf(v : Vocab, id : TokenId) : Text {
    if (id < v.tokens.size()) v.tokens[id] else unknown;
  };

  /// Encodes free text against an existing vocabulary.
  public func encode(v : Vocab, raw : Text) : [TokenId] {
    Array.map<Text, TokenId>(words(raw), func(w : Text) : TokenId { idOf(v, w) });
  };

  /// Decodes token ids back to text, attaching sentence punctuation to the
  /// preceding word so the output reads like a sentence.
  public func decode(v : Vocab, ids : [TokenId]) : Text {
    var out = "";
    for (id in ids.vals()) {
      let w = textOf(v, id);
      if (out == "") {
        out := w;
      } else if (w == "." or w == "," or w == "?" or w == "!") {
        out #= w;
      } else {
        out #= " " # w;
      };
    };
    out;
  };
};
