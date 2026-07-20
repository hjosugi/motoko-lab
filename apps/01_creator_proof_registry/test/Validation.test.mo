import Validation "../backend/src/Validation";

assert Validation.isDigest("12345678901234567890123456789012");
assert not Validation.isDigest("short");
assert Validation.validSalt("1234567890123456");
assert not Validation.validSalt("short");
assert Validation.validText("proof", 1, 10);
assert Validation.pageLimit(0) == 25;
assert Validation.pageLimit(500) == 100;
