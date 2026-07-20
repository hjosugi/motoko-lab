.PHONY: validate api-surface check-apps protocol-test issues-dry-run labels-dry-run offline-checks package

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
