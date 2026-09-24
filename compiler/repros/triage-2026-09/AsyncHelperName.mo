// #3117: a user method named like the compiler-generated one.
persistent actor {
  public func _motoko_async_helper() : async () {};
  public func ping() : async Nat { 1 };
};
