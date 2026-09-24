// #3819: `await` on an `async` whose body has type None.
import Prim "mo:⛔";

persistent actor {
  public func test() : async () {
    await async {
      Prim.trap("");
    };
  };
};
