ROOT := ../..
# `?=` so an environment that already knows where `moc` is - a Nix shell, a
# vendored toolchain, CI - does not need the Mops registry to find it.
MOC ?= $(shell mops toolchain bin moc 2>/dev/null)
CORE := .mops/core@2.6.0/src
SRC := backend/src
MOFLAGS := --package core $(CORE)

.PHONY: install check build test deploy-local sim vendor check-offline test-offline candid latency e2e all-offline

# ---------------------------------------------------------------- online --
# The normal path. Needs the Mops registry, which lives on the Internet
# Computer, so it needs `icp-api.io` to be reachable.

install:
	mops install

check:
	mops check

build:
	mops build

test:
	mops test

# Order matters here, and both extra steps are load-bearing.
#
# The identity must exist and be selected *before the first deploy*. `icp deploy`
# makes the current identity the canisters' controller, and every gated endpoint
# rejects the anonymous principal - so deploying as `anonymous` produces a
# cluster nobody can wire up, and switching identity afterwards makes the next
# deploy fail with IC0512 because the new identity is not a controller.
#
# The top-up is needed because `icp deploy` provisions about 1.4T cycles locally,
# below the 3T floor the orchestrator refuses to run under. On mainnet the
# canister is funded separately and this step does not apply.
deploy-local:
	icp identity list | grep -q '\boperator\b' || icp identity new --storage plaintext operator
	icp identity default operator
	icp network start -d
	icp deploy
	icp canister top-up backend --amount 10t
	icp canister call backend autoWire '()'
	icp canister call backend benchmark '("speculative decoding uses", 24, 4, 2)'

# --------------------------------------------------------------- offline --
# Same compiler, same sources, no registry. `vendor` puts `mo:core` into
# `.mops/` - fetched from raw.githubusercontent.com, or failing that out of the
# `motoko` npm package - which is the only thing `mops check`, `mops test` and
# `mops build` actually need the registry for. After `make vendor` the ordinary
# targets above work offline too; the ones below drive `moc` directly and skip
# `mops` entirely.

vendor:
	$(ROOT)/scripts/vendor_core_offline.sh $(CURDIR)

check-offline: vendor
	@test -n "$(MOC)" || { echo "moc not found; run ../../scripts/bootstrap_toolchain.sh" >&2; exit 1; }
	$(MOC) --check $(MOFLAGS) $(SRC)/main.mo
	$(MOC) --check $(MOFLAGS) worker/src/main.mo
	$(MOC) --check $(MOFLAGS) llm_shim/src/main.mo
	$(MOC) --check $(MOFLAGS) test/fixtures/LyingWorker.mo

test-offline: vendor
	@for f in test/*.test.mo; do \
		printf '%-24s ' "$$(basename $$f)"; \
		if $(MOC) -r $(MOFLAGS) "$$f" 2>&1 | grep -v M0155 | grep -v '^  Nat$$' | grep -q .; then \
			echo FAIL; $(MOC) -r $(MOFLAGS) "$$f"; exit 1; \
		else echo ok; fi; \
	done

# Runs the whole cluster - four shard workers, an orchestrator and an LLM shim -
# in the Motoko interpreter's actor scheduler. Real message passing, no replica.
sim: vendor
	$(MOC) -r $(MOFLAGS) sim/Cluster.mo

# Turns the counters the simulation measured into latency estimates under
# several network profiles.
latency:
	node tools/latency-model.mjs
	node tools/latency-model.test.mjs

# The same cluster on a real replica: canister installation, Candid on the wire,
# the `ic0.*` system API, cycle accounting and a real `caller`. `sim` cannot
# exercise any of those, which is where the access, quota, cycle and byzantine
# checks live.
e2e:
	node tools/pocket-ic-setup.mjs
	node tools/pocket-ic-e2e.mjs

candid: vendor
	$(MOC) --idl $(MOFLAGS) -o backend/candid/backend.did $(SRC)/main.mo
	$(MOC) --idl $(MOFLAGS) -o worker/candid/worker.did worker/src/main.mo
	$(MOC) --idl $(MOFLAGS) -o llm_shim/candid/llm_shim.did llm_shim/src/main.mo

all-offline: check-offline test-offline sim latency
