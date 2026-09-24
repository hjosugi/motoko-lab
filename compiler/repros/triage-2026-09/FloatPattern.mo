// #4701: a Float literal pattern. Accepted by the type checker; the question
// is what the compiled code does with it. Run with -r and compile with -c.
func classify(number : Float) : Text {
  switch (number) {
    case (0) "zero";
    case (_) "not zero";
  };
};
assert classify(0.0) == "zero";
assert classify(1.5) == "not zero";
