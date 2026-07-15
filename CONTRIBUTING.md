# Contributing to Traycer

Thanks for helping improve Traycer! This repo holds the open-source clients, CLI, and protocol.

## Prerequisites

- **Bun 1.3.12** — the `packageManager` is pinned; install from <https://bun.sh>
- **Node 24**

## Setup

```sh
git clone https://github.com/traycerai/traycer.git
cd traycer
bun install
```

## Common tasks

| Command          | What it does            |
| ---------------- | ----------------------- |
| `bun run build`  | Build all packages (Nx) |
| `bun run test`   | Run tests (Vitest)      |
| `bun run lint`   | Lint (ESLint)           |
| `bun run format` | Format (Prettier)       |

Nx caches and only rebuilds what changed. To target one package:

```sh
bunx nx run @traycer-clients/traycer-cli:build
```

## Repo layout

| Path                   | Package                                         |
| ---------------------- | ----------------------------------------------- |
| `protocol/`            | `@traycer/protocol` — client⇄host wire contract |
| `clients/traycer-cli/` | the `traycer` CLI                               |
| `clients/shared/`      | shared transport / auth / formatting            |
| `clients/gui-app/`     | GUI renderer                                    |
| `clients/desktop/`     | Electron shell                                  |

## Pre-commit hooks

We use [pre-commit](https://pre-commit.com) for hygiene checks (whitespace, large files, private keys, YAML/JSON, shell scripts). Install once:

```sh
pipx install pre-commit   # or: brew install pre-commit
pre-commit install
```

The hooks then run on every commit; run them on demand with `pre-commit run --all-files`. Lint and format are enforced separately in CI.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; add or update tests where it makes sense.
3. Make sure `bun run build`, `bun run lint`, `bun run test`, and formatting all pass — CI runs the same four checks.
4. Open a PR with the template and link any related issue.

## Developer Certificate of Origin (DCO)

Every commit must be **signed off** — it certifies you wrote the patch or have the right to submit it under MIT. Use `-s`:

```sh
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. See <https://developercertificate.org/>. PRs whose commits aren't signed off will be asked to amend.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
