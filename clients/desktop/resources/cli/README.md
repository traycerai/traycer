# `resources/cli/` - bundled CLI staging directory

This directory is the staging location for the bundled Traycer CLI binary that
ships inside a packaged Electron build.

## Contract

At packaging time the desktop release pipeline stages the CLI artifact into an
arch-scoped subdirectory:

- `resources/cli/<platform>-<arch>/traycer` (macOS / Linux)
- `resources/cli/<platform>-<arch>/traycer.exe` (Windows)
- `resources/cli/<platform>-<arch>/version.json` - bundled CLI version metadata
  consumed by Desktop's `readBundledCliVersion()`.

`electron-builder` maps `resources/cli/**` into `process.resourcesPath/cli/**`
via the `extraResources` entry in `package.json`. At runtime, the Electron main
process resolves the CLI binary from
`process.resourcesPath/cli/<platform>-<arch>/<binary>` via the discovery layer
in `src/electron-main/cli/cli-discovery.ts`.

## First-launch self-heal

On a clean machine, the bundled CLI is silently copied into the per-user stable
path (`~/.traycer/cli/bin/<binary>`) by the first-launch setup splash. The CLI
manifest at `~/.traycer/cli/manifest.json` is written by the same step.

If the manifest later points at a missing or non-executable binary AND the
bundled CLI is still present, the discovery layer silently re-stages the bundled
CLI to the stable path. This is the self-heal contract from the Native Packaging
Tech Plan (Decision 6).

## Dev vs. prod resolution

**Dev and prod use the same resolution code path.** `cli-discovery.ts` has no
`app.isPackaged` branch - the discovery layer resolves the bundled CLI from
`process.resourcesPath/cli/<platform>-<arch>/` in every build. Dev orchestrators
(`make dev-desktop` → `scripts/dev-desktop.js`) inject a
`TRAYCER_CLI_BUNDLED_BIN` env var pointing at a wrapper under
`~/.traycer/cli/dev/bin/traycer`. The discovery layer reads that override
transparently and falls back to the arch-scoped resources tree when the override
is unset or empty.

If you need to point the desktop at an alternate CLI build during development
(e.g. a custom branch of `clients/traycer-cli/`), set
`TRAYCER_CLI_BUNDLED_BIN=<absolute path>` on the shell that launches Electron.
There is no separate "dev vs prod" code path to maintain.

## Missing-binary behavior

The discovery layer throws so the user sees a precise "CLI resource missing -
packaging bug" message rather than a cryptic spawn failure later. The host-mode
`prepack:check-cli` precheck
(`clients/desktop/scripts/prepack/check-cli-resource.cjs`) catches
missing arch-scoped binaries before `electron-builder` packages the bundle.
Release workflows invoke the precheck in matrix mode with explicit
`--platform`/`--arch` flags so the per-arch presence + sibling `version.json`
are validated strictly.

## Why `.gitkeep`

The directory is intentionally empty in source control. Only the release
pipeline populates the arch-scoped subdirectories; committing a binary here
would bloat the repo and bypass signing
/ notarization. The repo's `clients/desktop/.gitignore` matches
`resources/cli/*/` so the arch dirs stay untracked without affecting `.gitkeep`
or this README.
