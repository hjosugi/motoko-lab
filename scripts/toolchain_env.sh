#!/usr/bin/env bash

motoko_toolchain_prefix() {
  if [[ -n "${MOTOKO_TOOLCHAIN_PREFIX:-}" ]]; then
    printf '%s\n' "$MOTOKO_TOOLCHAIN_PREFIX"
  else
    printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/motoko-lab/npm"
  fi
}

motoko_add_toolchain_to_path() {
  local prefix
  prefix="$(motoko_toolchain_prefix)"
  if [[ -d "$prefix/bin" ]]; then
    export PATH="$prefix/bin:$PATH"
  fi
}
