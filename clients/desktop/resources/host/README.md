# `resources/host/` - empty placeholder for legacy `extraResources` entry

> **Empty by design.** Desktop **never** bundles a host binary. Host
> install/update/uninstall is owned by the **Traycer CLI** and backed by the
> hosted registry (`versions.json` + minisign). See
> [`docs/DEVELOPMENT.md`](../../../../docs/DEVELOPMENT.md) for the CLI-driven
> host lifecycle.

This directory exists only because `package.json`'s `build.extraResources`
references it; the `electron-builder` filter is restricted to the explanatory
placeholder files (`README.md`, `.gitkeep`) so nothing accidentally lands inside
a packaged Desktop release. Desktop's main process discovers the host at
runtime through **PID metadata** written by the CLI-installed host at
`~/.traycer/host/pid.json` (prod channel) and `~/.traycer/host/dev/pid.json`
(dev channel), not through this directory. See
`src/electron-main/host/host-paths.ts` for the canonical layout.

## Do not stage host binaries or wrapper scripts here

The Desktop release pipeline does **not** download a host archive into this
directory; `traycer host install latest` (invoked by the Setup splash at first
launch) is the single source of truth for host install, update, and uninstall.

If you need to side-load a local host archive (instead of the released one),
install it through the CLI's `--from <path>` option:

```bash
traycer host install --from /absolute/path/to/host.tgz
```

## Why keep an empty directory?

- `electron-builder`'s `extraResources` reads from this path during packaging -
  removing the directory without also removing the `extraResources` entry would
  break `bun run package`.
- The placeholder is the cheapest way to keep the packaging job deterministic
  while making it clear at a glance that Desktop has no business shipping host
  bytes.

## What about `resolveHostBinaryPath` / `TRAYCER_HOST_BINARY`?

Both have been **removed** with the CLI-owned lifecycle cutover. They are no
longer honored anywhere in `clients/desktop/`. Any local notes still
referencing them are stale.
