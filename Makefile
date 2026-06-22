traycer_local_path := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

SHELL := /bin/bash

GIT_ROOT := $(shell git rev-parse --show-toplevel)

.DEFAULT_GOAL := build

# ---------------------------------------------------------------------------
# Developer stack
#
# Runs the desktop dev shell (Vite HMR) against PRODUCTION, with the Traycer
# host DOWNLOADED from GitHub Releases. The Traycer Host and cloud backend are
# not part of this repo — the CLI provisions the real signed host release and
# the clients talk to the production cloud. macOS/Linux.
#
#   make dev-desktop                 # download + run against the LATEST host
#   make dev-desktop VERSION=1.2.3   # pin a specific host release
#   make host-stop                   # stop the dev host (leaves it installed)
#   make host-clean                  # deregister + remove the dev host
#
# The CLI verifies the downloaded host against the signing public key committed
# in clients/traycer-cli/src/config.ts, so no key setup is needed. The dev host
# installs under the isolated `dev` slot (`~/.traycer/host/dev`, service label
# `ai.traycer.host.dev`), so it never touches a production Traycer install.
# Ctrl-C deregisters it; ~/.traycer user data (credentials, config) is preserved.
# ---------------------------------------------------------------------------

CLI := bun clients/traycer-cli/src/index.ts

dev-desktop:
	@bun run dev-desktop -- $(if $(strip $(VERSION)),--release $(VERSION),) $(ARGS)

# Stop the dev host service (leaves it installed).
host-stop:
	@$(CLI) host stop

# Deregister + remove the dev host install (keeps ~/.traycer user data).
host-clean:
	@$(CLI) host uninstall --all

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

install:
	@bun install

lint:
	@bun run lint

format:
	@bun run format

test:
	@bun run test

test-affected:
	@bun run test:affected

test-project:
	@bun run test:project $(ARGS)

workspace-checks:
	@scripts/pre_commit_workspace_checks.sh

pre-commit-checks:
	@pre-commit run --all-files

build:
	@bun install
	@bun run build

compile:
	@bun install
	@bun run compile

all: pre-commit-checks
	@echo "Done"

.PHONY: dev-desktop host-stop host-clean \
	install lint format test test-affected test-project workspace-checks \
	pre-commit-checks build compile all
