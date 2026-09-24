// #3993: `or` patterns over variants. The unannotated form from the issue is
// now rejected up front (M0184); the annotated form is the one that reaches
// the IR type checker.
func three(x : { #a; #b; #c }) : Nat {
  switch x {
    case (#a or #b) 1;
    case (#c) 2;
  };
};
func three2((#a or #b or #c) : { #a; #b; #c }) {};
assert three(#b) == 1;
three2(#c);
