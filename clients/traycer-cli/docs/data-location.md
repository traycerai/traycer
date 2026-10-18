# Where Traycer keeps its data

Traycer keeps everything it manages in one data folder: sign-ins and
credentials, chat and agent history, Traycer-managed provider accounts,
managed worktrees, downloaded hosts, models and runtimes. By default that is
`~/.traycer` (`C:\Users\<you>\.traycer` on Windows).

> **Availability.** On Windows, `traycer data init` and `traycer data migrate`
> can put the data folder on a different fixed local NTFS drive. On macOS and
> Linux both refuse without changing anything. `traycer data status`,
> `traycer data migrate --dry-run`, `traycer data recover` and
> `traycer data cleanup` work on every platform.

## Commands

| Command                                        | What it does                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `traycer data status`                          | Shows the data folder, whether Traycer can start, any move in progress and the commands that are valid for it now. Changes nothing. |
| `traycer data init --to <folder>`              | New installations only: keep the data in `<folder>` from the start.                                                                 |
| `traycer data migrate --to <folder> --dry-run` | Shows what a move would involve. Changes nothing.                                                                                   |
| `traycer data migrate --to <folder>`           | Moves an existing installation's data folder.                                                                                       |
| `traycer data recover`                         | Continues a move that was interrupted.                                                                                              |
| `traycer data recover --rollback`              | Undoes a move that has not taken effect yet.                                                                                        |
| `traycer data cleanup <migration-id>`          | Permanently deletes the copy a move no longer uses.                                                                                 |

Every command takes `--json`. Commands that change something ask first; pass
`--yes` to skip the question.

## Choosing the folder

`--to` names the folder. Without it, `data init` and `data migrate` use the
`TRAYCER_DATA_DIR` environment variable. That variable is read **only** by
these two commands, as a default: `--to` always wins, the folder is shown
before anything is written, and Traycer itself never reads the variable when
it runs. The choice is stored in `~/.traycer-bootstrap/location.json`, which
always stays in your home folder.

The folder must be new or empty, on a fixed local drive, and not inside (or
containing) the current data folder. Network drives, removable drives,
FAT/exFAT, links and junctions are refused. If the selected drive is missing,
Traycer does not start, and it never falls back to `~/.traycer`: reconnect
the drive.

`data init` is for a machine with no Traycer data yet. It refuses when an
installation already exists; use `data migrate` to move that one.

## Moving an installation

1. Run `traycer data migrate --to <folder> --dry-run`. It checks the paths,
   free space and installed Traycer versions. It cannot check Traycer's
   stores and sessions; that happens when the move starts, and the move can
   still stop then.
2. Quit Traycer Desktop, let any other `traycer` commands finish, and close
   shells or editors open in managed worktrees.
3. Run `traycer data migrate --to <folder>`. Traycer shows what moves and
   what stays, then how each chat and terminal agent will continue (below),
   and asks before it starts. It stops Traycer hosts and their agents itself,
   then waits for every other Traycer process to exit; if one is still
   running after about two minutes, the move stops and tells you which.
4. Traycer copies and verifies everything, updates worktree links and login
   items, and then switches to the new folder. The old folder is never
   changed during the move.

If the move is interrupted (a crash, Ctrl+C, a full disk), Traycer stays
stopped and `traycer data status` says where it stopped:

- **Before the move took effect**, `traycer data recover` continues it and
  `traycer data recover --rollback` puts everything back in the old folder.
- **After it took effect**, Traycer uses the new folder and the move can no
  longer be undone, even if nothing has been written there yet.
  `traycer data recover` finishes it. Moving back is a new move.

## Chats and terminal agents after a move

Traycer predicts, per session, how it continues in the new folder and shows
it before the move starts:

- **Expected to continue**: the provider resumes its session.
- **New provider session**: the chat continues from the history Traycer
  shows; provider-only state (todos, permissions, background tasks) does not
  carry over.
- **Held**: the session cannot resume yet; start a new agent to keep
  working. The original stays as it was.

Provider files are copied unchanged. Terminal agents keep their native
transcript, but Traycer cannot show it as chat history. Links in old chat
history can still show old paths.

If any session would continue in a new provider session or is uncertain, the
move needs your acceptance. Without a prompt (`--yes`, scripts), Traycer
prints the report and its digest; run the command again with
`--accept-session-impact <digest>`. A changed report needs a new acceptance.

If a host's relocation record cannot be read after a move, every agent on that
host is held, new ones included; run `traycer data status`.

## After a move: the old folder

The old folder stays as a backup until you delete it, and it still uses its
disk space. Delete it promptly once Traycer works from the new folder:

```bash
traycer data cleanup <migration-id>
```

- It deletes only content the move recorded and that is unchanged. If
  anything there was added or changed, nothing is deleted and you are told
  what.
- Provider files are kept unless the same bytes are verified in the new
  folder.
- It never touches the new folder or `~/.traycer-bootstrap`; the move's
  records are kept permanently.
- Deletion cannot be undone.

**Do not run an older Traycer version after moving.** Older versions ignore
the location record and use `~/.traycer`: they can start from the backup and
repeat queued or scheduled work (sending messages or making changes a second
time), or create a second installation. Traycer warns at startup and in
`data status` when the default folder is populated but is not a known backup;
it never merges or deletes either folder. While the folder is moved, Traycer
refuses to install an older host.

After a rollback, `traycer data cleanup <migration-id>` instead deletes the
unused copy in the destination. Your data stays in, and is still used from,
the old folder.

## What does not move

- The Traycer app itself. On Windows the installer already lets you choose
  where it is installed.
- Desktop caches and the updater cache.
- System temp files.
- Provider folders outside Traycer, such as `~/.claude`.
- `~/.traycer-bootstrap`, which records the location.

Uninstalling the Traycer app leaves the data folder and its location record
in place. On Windows, the old folder's background-start launcher stays inside
the backup and no longer runs; `traycer data cleanup` deletes it with the
backup.
