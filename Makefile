.PHONY: replica-tests docs docs-serve validate api-surface check-apps protocol-test issues-dry-run labels-dry-run offline-checks package

validate:
	python3 scripts/validate_kit.py

api-surface:
	python3 scripts/check_api_surface.py

check-apps:
	./scripts/check_all_apps.sh

protocol-test:
	node protocol/tools/provenance-cli.test.mjs

issues-dry-run:
	./scripts/create_issues.sh

labels-dry-run:
	./scripts/create_labels.sh

offline-checks:
	./scripts/run_offline_checks.sh

package:
	python3 scripts/package_kit.py

# Installs the replica and Candid tooling on first run, then exercises every
# application on a real replica. This is the gate `mops test` cannot be: the
# interpreter has no caller, no upgrade, and no clock.
replica-tests:
	node tools/pocket-ic/setup.mjs
	node tools/pocket-ic/run.mjs

# Documentation site. `site-src/` is staged from the repository rather than
# being a second copy of it; see scripts/build_docs_site.py.
docs:
	python3 scripts/build_docs_site.py --self-test
	python3 scripts/build_docs_site.py --check
	mkdocs build --strict

docs-serve:
	python3 scripts/build_docs_site.py --check
	mkdocs serve
