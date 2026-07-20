# Command Cheatsheet

## Install

```bash
npm install -g @icp-sdk/icp-cli @icp-sdk/ic-wasm
npm install -g ic-mops
```

## Verify

```bash
node --version
icp --version
mops --version
mops toolchain list
```

## Project

```bash
mops install
mops check
mops build
```

## Local network and deploy

```bash
icp network start -d
icp deploy
```

mainnet/environment commandはCLI versionで変わり得るため、実行前に確認します。

```bash
icp deploy --help
icp environment --help
```

## Kit

```bash
python3 scripts/validate_kit.py
./scripts/check_all_apps.sh
./scripts/create_issues.sh
APPLY=1 TARGET_REPO=owner/repo ./scripts/create_issues.sh
```

Issue scriptはdefault dry-runです。

## Compiler

```bash
git clone https://github.com/caffeinelabs/motoko.git
cd motoko
nix develop
make -C src
make -C rts
make -C test
nix build --no-link
```

## Diagnostics

```bash
moc --version
moc --help
mops check
mops check --fix
```

flagはcurrent `moc --help`で存在確認してから使用します。
