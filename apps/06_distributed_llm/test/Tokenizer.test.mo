import Text "mo:core/Text";
import Corpus "../backend/src/Corpus";
import Tokenizer "../backend/src/Tokenizer";

let vocab = Tokenizer.buildVocab(Tokenizer.words(Corpus.text));

// `<unk>` owns id 0 so an out-of-vocabulary word has a stable id.
assert Tokenizer.textOf(vocab, 0) == Tokenizer.unknown;
assert Tokenizer.idOf(vocab, "definitelynotinthecorpus") == 0;

// The searchable region `[1, size)` is sorted and duplicate free; binary search
// depends on both. Index 0 is `<unk>`, which is out of sort position on purpose
// because `'<'` sorts after `'.'` and the digits.
assert Text.compare(vocab.tokens[1], Tokenizer.unknown) == #less;
var previous = vocab.tokens[1];
var index = 2;
while (index < Tokenizer.size(vocab)) {
  let current = vocab.tokens[index];
  assert Text.compare(previous, current) == #less;
  previous := current;
  index += 1;
};

// The token that would break a naive binary search: `.` sorts before `<unk>`,
// so looking it up must still find its real id rather than falling through to 0.
assert Tokenizer.idOf(vocab, ".") > 0;
assert Tokenizer.textOf(vocab, Tokenizer.idOf(vocab, ".")) == ".";

// Every word of the corpus round-trips to its own id.
for (word in Tokenizer.words(Corpus.text).vals()) {
  assert Tokenizer.textOf(vocab, Tokenizer.idOf(vocab, word)) == word;
};

// Case and punctuation normalisation.
assert Tokenizer.words("A Canister IS...") == ["a", "canister", "is..."];
assert Tokenizer.words("  spaced \n out\t") == ["spaced", "out"];
assert Tokenizer.words("") == [];

// Sentence punctuation is its own token because the corpus separates it.
assert Tokenizer.words("a canister is a smart contract .").size() == 7;

// Decoding reattaches punctuation to the preceding word.
let ids = Tokenizer.encode(vocab, "a canister is a smart contract .");
assert Tokenizer.decode(vocab, ids) == "a canister is a smart contract.";

// Encoding is a pure function of the vocabulary and the text.
assert Tokenizer.encode(vocab, "a canister") == Tokenizer.encode(vocab, "A CANISTER");

// Building the vocabulary twice gives the identical table: no hash seed, no
// iteration-order dependency, so every replica agrees on token ids.
let again = Tokenizer.buildVocab(Tokenizer.words(Corpus.text));
assert Tokenizer.size(again) == Tokenizer.size(vocab);
var k = 0;
while (k < Tokenizer.size(vocab)) {
  assert again.tokens[k] == vocab.tokens[k];
  k += 1;
};
