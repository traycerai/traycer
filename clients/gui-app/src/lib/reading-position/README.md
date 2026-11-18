# Reading-position ownership

`service.ts` is the renderer's single reading-position registry. Durable
records are account-scoped, stored one record per localStorage key, and keyed
twice:

- `viewKey` is the exact canvas tile instance.
- `contentKey` is the stable domain coordinate used when a closed surface is
  reopened as a new tile.

Durable chat, artifact, workspace-file, git/snapshot diff, bundle diff, and PR
diff surfaces use both coordinates. Each surface owns and validates its anchor
payload; the registry owns identity, persistence, cleanup, cross-window storage
events, and lifecycle capture.

Managed-command output and xterm are deliberately renderer-live:

- managed output keys its in-memory anchor to the live output-store instance;
  rebuilding that store starts at the current tail;
- xterm keeps the actual engine and container in `xterm-host-registry`, so its
  normal-buffer viewport travels with same-window reparenting and warm-session
  rekeys. Rebuilding the renderer or moving windows starts naturally at latest
  output. Alternate-screen state is never restored by Traycer.

The persistence family uses the `reading-position` entry in the central key
catalog. Sign-out clears the active account bucket, and epic access loss
tombstones the epic before deleting its prefix so late writers cannot recreate
durable records.
