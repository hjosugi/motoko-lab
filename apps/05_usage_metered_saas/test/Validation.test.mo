import Validation "../backend/src/Validation";
assert Validation.isDigest("12345678901234567890123456789012");
assert Validation.validText("pro", 1, 20);
assert Validation.pageLimit(100) == 100;
