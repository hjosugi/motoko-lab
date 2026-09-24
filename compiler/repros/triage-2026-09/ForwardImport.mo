// #4733: a destructured import used as the last expression of an actor class.
import { debugPrint } = "mo:⛔";

persistent actor class C() = Self {
  debugPrint "So far so good!";
};
