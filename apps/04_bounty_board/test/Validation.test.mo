import Validation "../backend/src/Validation";
assert Validation.isDigest("12345678901234567890123456789012");
assert Validation.validText("bounty", 1, 100);
assert Validation.pageLimit(200) == 100;
