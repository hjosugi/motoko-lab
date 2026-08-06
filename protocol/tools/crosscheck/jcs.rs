// RFC 8785 canonicalization via the `serde_jcs` crate.
//
// Reads a JSON document on stdin and writes its canonical form on stdout, or a
// reason on stderr with a non-zero exit. `crosscheck.mjs` runs it once per
// vector.
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let value: serde_json::Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("PARSE_ERROR {e}");
            std::process::exit(2);
        }
    };
    match serde_jcs::to_string(&value) {
        Ok(s) => print!("{s}"),
        Err(e) => {
            eprintln!("SERIALIZE_ERROR {e}");
            std::process::exit(3);
        }
    }
}
