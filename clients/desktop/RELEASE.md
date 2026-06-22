# Desktop release pipeline

Desktop releases — the signed `.dmg` / `.zip` / Windows / Linux installers and
the auto-update feeds — are **built and signed in Traycer's internal
repository** and published to this repo's [Releases](../../releases) cross-repo.
Signing secrets never enter this open-source repo, so the release workflows live
internally rather than here.

For local development and packaging from this repo:

- `make dev-desktop` — run the desktop dev shell against production with a
  downloaded host. See [`AGENTS.md`](AGENTS.md) and
  [`../../docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md).
- `bun run package` — produce an **unsigned** packaged Electron binary.
- `bun run package:dir` — unpacked package for a faster smoke test.
