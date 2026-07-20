# Compiler Bootstrap

```bash
git clone https://github.com/caffeinelabs/motoko.git
cd motoko

# Install Nix with flakes enabled, then:
nix profile install --accept-flake-config nixpkgs#cachix
cachix use ic-hs-test
nix develop

make -C src
make -C rts
make -C test
nix build --no-link
```

OS/Nix version、commit SHA、command、durationを記録します。failureはenvironment issueとsource issueを分離します。
