# Development guide

Deeper notes for working on the Traycer clients, CLI, and protocol.

## Toolchain

- **Bun 1.3.12** — pinned via `packageManager`
- **Node 24**
- **Nx** runs the workspace targets (`build` / `lint` / `test` / `format`) with caching

```sh
bun install
bun run build           # all packages
bunx nx run @traycer/protocol:build   # a single package
```

## Pre-commit hooks

Install the hygiene hooks once with `pipx install pre-commit && pre-commit install --hook-type pre-commit --hook-type commit-msg`; they then run on every commit (`pre-commit run --all-files` to run manually). The `commit-msg` hook type is required for DCO sign-off enforcement. Lint and format are enforced in CI.

## Workspace layout

| Path                   | Package                        | Responsibility                                                                      |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `protocol/`            | `@traycer/protocol`            | The versioned client⇄host wire contract (schemas, RPC, framework versioning).       |
| `clients/traycer-cli/` | `@traycer-clients/traycer-cli` | The `traycer` CLI — provisions/upgrades the host, auth, agent & workspace commands. |
| `clients/shared/`      | `@traycer-clients/shared`      | Transport (WebSocket/RPC), auth (PKCE/bearer), comment & agent formatting.          |
| `clients/gui-app/`     | `@traycer-clients/gui-app`     | The GUI renderer (React).                                                           |
| `clients/desktop/`     | `@traycer-clients/desktop`     | Electron shell around `gui-app`.                                                    |

## Protocol versioning

`@traycer/protocol` defines the contract with **per-method `{ major, minor }` versioning negotiated at runtime** (not npm semver). Because the handshake negotiates compatibility, clients and the host can ship independently as long as their versions remain compatible. The CLI **inlines** the protocol at build time, so the published CLI has no runtime dependency on a protocol package.

## Config targets (dev / staging / production)

Each client's `src/config.ts` defaults to **dev** — `localhost` endpoints, empty host trust keys, no pinned host version. Production values (real endpoints, the host's trusted minisign public keys, the pinned host version) are **stamped at release time** by `scripts/set-deploy-target.cjs --target=production` from CI environment variables; they are never committed. The embedded host public keys are public trust anchors (safe to ship), and `--restore` returns the file to dev defaults after a build.

## Running against a local host

The CLI normally downloads and verifies a **signed** host binary. For local development you can side-load an unsigned host (dogfood) — see the CLI's `scripts/set-deploy-target.cjs` (`--allow-empty-pubkeys`) and the `make install-desktop-*` flows. A staging/production build with no embedded trust root deliberately refuses to install registry host archives.

## Releases

Releases are **built and signed in Traycer's internal repository** and published to this repo's [Releases](../../releases) cross-repo — signed CLI, host, and desktop binaries plus update feeds. Signing secrets never enter this repository, so **contributors need no secrets to build or test** the open-source code here.
