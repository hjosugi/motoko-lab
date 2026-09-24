// #3855: one use of a deprecated function, how many warnings? The issue used
// base's Hash.hash; core 2.6.0's deprecated Blob.fromArray shows the same.
import Blob "mo:core/Blob";

let inferred = Blob.fromArray;
let annotated : [Nat8] -> Blob = Blob.fromArray;
ignore inferred([1]);
ignore annotated([2]);
