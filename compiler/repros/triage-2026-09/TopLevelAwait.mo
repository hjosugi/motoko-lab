// #3624: `await` at the top level of a non-actor program. Compile with -c.
func foo() : async Nat {
  return await async 4;
};
assert (await foo()) == 4;
