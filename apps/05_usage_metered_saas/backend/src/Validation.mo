module {
  public func isDigest(value : Blob) : Bool { value.size() == 32 };
  public func validText(value : Text, min : Nat, max : Nat) : Bool { value.size() >= min and value.size() <= max };
  public func pageLimit(requested : Nat) : Nat { if (requested == 0) 25 else if (requested > 100) 100 else requested };
};
