VERSION := $(shell node -p "require('./package.json').version")

.PHONY: bump-patch bump-minor bump-major tag help

# ── Usage ──────────────────────────────────────────────────────
#
#   Release flow:
#     1. make bump-minor          # bump version in package.json
#     2. git add package.json package-lock.json
#     3. git commit -m "chore: bump to $(VERSION)"
#     4. merge PR to main
#     5. git checkout main && git pull
#     6. make tag                 # create and push git tag
#

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

bump-patch: ## Bump patch version (bug fixes, e.g. 0.1.0 → 0.1.1)
	npm version patch --no-git-tag-version
	@echo "Bumped to $$(node -p "require('./package.json').version")"

bump-minor: ## Bump minor version (new features, e.g. 0.1.0 → 0.2.0)
	npm version minor --no-git-tag-version
	@echo "Bumped to $$(node -p "require('./package.json').version")"

bump-major: ## Bump major version (breaking changes, e.g. 0.1.0 → 1.0.0)
	npm version major --no-git-tag-version
	@echo "Bumped to $$(node -p "require('./package.json').version")"

tag: ## Create and push a git tag for the current version (run after merge to main)
	git tag v$(VERSION)
	git push origin v$(VERSION)
	@echo "Tagged v$(VERSION)"
