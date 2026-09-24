// `verifyCertifiedValue` for callers that hold a canister id as text.
//
// protocol/tools/c2pa-bridge.mjs verifies saved certified records offline and
// is dependency-free by design, so it cannot import `@dfinity/principal`
// itself: a bare specifier resolves relative to the importing file, and the
// agent libraries live here, in tools/pocket-ic/node_modules. This module is
// the seam. It is only importable once `node tools/pocket-ic/setup.mjs` has
// installed them, and the bridge treats its absence as "certificate not
// checked" rather than as a failure.

import { Principal } from '@dfinity/principal';

import { verifyCertifiedValue } from './certificate.mjs';

export function verifyCertifiedRecord({ canisterId, ...rest }) {
  return verifyCertifiedValue({ canisterId: Principal.fromText(canisterId), ...rest });
}
