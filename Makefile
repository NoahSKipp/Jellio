# Release mechanics taken as-is from Gelato (https://github.com/lostb1t/Gelato,
# GPL-3.0), unmodified, same reasoning as build.yaml and the workflows.
release:
	@# Resumable: run it again (or with VERSION=x.y.z) after a failure part
	@# way; DRY_RUN=1 prints what it would do.
	scripts/release.sh

test:
	@echo "Fetching tags..."
	git fetch --tags
	@echo "Bumping version with git-cliff..."
	@# Commits marked [skip changelog] don't count toward git-cliff's bump,
	@# so a release made only of those would reuse the last tag: bump the
	@# patch number instead.
	$(eval NEW_VERSION := $(shell v=$$(git cliff --bumped-version 2>/dev/null); last=$$(git describe --tags --abbrev=0 2>/dev/null); if [ -n "$$last" ] && [ "$$v" = "$$last" ]; then echo "$$last" | awk -F. -v OFS=. '{$$NF=$$NF+1; print}'; else echo "$$v"; fi))
	@echo "New version will be: $(NEW_VERSION)"
	@echo "Generating changelog..."
	@git cliff --unreleased --tag $(NEW_VERSION) --strip all > /tmp/release_notes.md
	@cat /tmp/release_notes.md

.PHONY: release test
