import Validation "../backend/src/Validation";
assert Validation.isDigest("12345678901234567890123456789012");
assert not Validation.isDigest("bad");
assert Validation.validText("sha256", 1, 50);
assert Validation.pageLimit(101) == 100;
