// Runs `commitment.ts` over the vector list `crosscheck.mjs` writes.
//
// One vector per line as the JSON array `["principal","manifest-hex",
// "salt-hex"]`; one result per line, `OK<TAB>preimage-hex<TAB>commitment-hex`
// or `ERR<TAB>reason`. Same wire format as `commitment.rs`, so the two are
// compared the same way.

import { readFileSync } from "node:fs";
import { build } from "./commitment.ts";

const input = readFileSync(process.argv[2], "utf8");
const lines: string[] = [];

for (const line of input.split("\n")) {
  if (line.length === 0) continue;
  const [principal = "", manifestHash = "", salt = ""] = JSON.parse(line) as string[];
  try {
    const { preimageHex, commitmentHex } = build({ principal, manifestHash, salt });
    lines.push(`OK\t${preimageHex}\t${commitmentHex}`);
  } catch (error) {
    lines.push(`ERR\t${(error as Error).message}`);
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
