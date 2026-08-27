# Tab drag evaluation fixture

This directory contains a development-only fixture bridge for reproducing the
tab-drag regression matrices without depending on whatever epics happen to be
open on a machine.

The fixture can create:

- unequal-width task tiles, including a sustained-overflow strip;
- two pane groups for cross-group and pane-corridor gestures;
- count-driven header tabs for header reorder, merge, and overflow checks; and
- a draft header tab for detach coverage.

It mutates the in-memory canvas and landing-draft stores. It snapshots the
target canvas before seeding and exposes explicit teardown, scroll restoration,
and seeded-header purging. Do not use it against production or user data you
cannot safely restore.

## Production exclusion

`traycer-app.tsx` reaches the bridge through a dynamic import guarded by
`import.meta.env.DEV && import.meta.env.MODE !== "test"`. Production builds
eliminate the branch and the module. `SEED_FIXTURE_SENTINEL` exists only to
make that exclusion testable in a built artifact.

The bridge is attached with `Reflect.set`, so production TypeScript does not
gain a `Window.__traycerSeedFixture` API. It is also disabled under Vitest,
where `DEV` is true.

## Driver

Run the desktop development stack first. Its normal remote-debugging port is 37723. Then, from the `traycer/` repository:

```bash
# Discover bridge-enabled windows and their seedable epic tabs.
bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs inspect

# Replace one epic canvas with the canonical 6+2 unequal-width fixture.
bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs seed-canvas

# Add five deterministic header tabs to the selected window.
bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs seed-header

# Add one draft header tab for detach coverage.
bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs seed-draft

# Restore seeded canvases and scroll, remove seeded headers and drafts on every
# bridge-enabled window. Always run this before stopping the stack.
bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs cleanup
```

The driver selects the seedable tab with the most existing tiles. Pin a window
or tab when several are open:

```bash
TARGET=6E0F8D3A TAB_ID=01abc... \
  bun clients/gui-app/scripts/seed-canvas-fixture-browser.mjs seed-canvas
```

Configuration is via environment variables:

| Variable           | Default        | Purpose                                                |
| ------------------ | -------------- | ------------------------------------------------------ |
| `CDP_PORT`         | `37723`        | Electron remote-debugging port                         |
| `TARGET`           | auto           | Full or prefix CDP page target id                      |
| `TAB_ID`           | largest canvas | Exact epic tab id to replace                           |
| `SOURCE_TILES`     | `6`            | Tiles in the overflowing source pane                   |
| `TARGET_TILES`     | `2`            | Tiles in the second pane                               |
| `TWO_GROUPS`       | `true`         | Set `false` for a single pane                          |
| `REQUIRE_OVERFLOW` | `true`         | Fail unless overflow is at least twice the widest tile |
| `SEED_HOST_ID`     | `seed-host`    | Host id placed on synthetic workspace-file refs        |
| `HEADER_TABS`      | `5`            | Header tabs added by `seed-header`                     |

`seed-canvas` refuses to report success unless the refs survive schema
round-trip and the settled DOM satisfies the requested overflow magnitude. The
driver prints the target id, tab id, fingerprint, pane composition, and measured
overflow so later probes can declare their exact precondition. Re-seeding the
same tab preserves the original teardown snapshot; attempting to seed a second
tab before cleanup is refused.

## Cleanup guarantees and limits

`cleanup` visits every bridge-enabled window because only the window that
performed canvas seeding retains the pre-seed snapshot. A `canvas=none` result
is therefore expected on other windows. For the seeded window, cleanup waits
for the structural restore to render before restoring DOM scroll offsets.

Header ids use the `seed-header-` namespace, so they can be purged even after a
reload loses the original in-memory snapshot. Draft cleanup removes only ids
created by this bridge process. If the app or dev stack crashes before cleanup,
restart the same development slot and run `cleanup`; header purging remains
available, while an in-memory canvas snapshot cannot survive a process restart.

The driver intentionally packages only fixture construction and cleanup. Motion
and pointer probes should live beside the regression they automate rather than
accumulating as undocumented one-off scripts.
