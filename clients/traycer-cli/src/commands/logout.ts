import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { clearDiskChatPartCache } from "../store/chat-part-cache";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";
import { cliChatPartCacheDir } from "../store/paths";

// Runner-aware `traycer logout`. JSON mode emits exactly one terminal
// NDJSON `result` event; human mode prints a single human line.
//
// `logout` does TWO things, and the help says both (CLI-017): it forgets the
// stored credentials, and it deletes the local published-chat cache. The second
// is not a bonus tidy-up - the cache holds chat content this account published,
// so leaving it behind would mean signing out without the content leaving the
// machine.
//
// Sign-out runs through the locked mutation store (§7): `signOut` deletes the
// credentials file under the lock AND advances the tombstone, so a concurrent or
// subsequent automatic `rotate` (a background monitor, the desktop app) can
// never resurrect the signed-out session by re-spending a refresh token. A
// pre-read reports whether a session actually existed so scripts can still
// branch on `data.loggedOut`; a failed delete surfaces honestly (§5) instead of
// the old best-effort path that reported "Not logged in." even when the file was
// still on disk.
export const logoutCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  const { hadSession, signOut } = await runWithCliStore(async (store) => {
    const before = await store.read();
    const outcome = await withCommitRetry(() => store.signOut(null), null);
    return { hadSession: before !== null, signOut: outcome };
  });
  if (signOut.outcome !== "deleted") {
    // `lock-busy` (another traycer process holds the credentials lock) or
    // `commit-failed`. Neither can claim signed-out - but neither can claim
    // still-signed-in either: `commitMutation` DELETES the credentials file at
    // its apply step and only then finalizes the sidecar, so a finalize fault
    // returns `commit-failed` with the file already gone. The message says
    // "could not confirm" because that is the whole of what is known, and
    // points at the one action that resolves it either way - logout is
    // idempotent, so re-running is always safe.
    throw cliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message:
        "Logout could not confirm that the stored credentials were cleared - another traycer process may be busy. You may or may not still be signed in; run `traycer logout` again, then `traycer whoami` to check.",
      details: { signOutOutcome: signOut.outcome },
      exitCode: 1,
    });
  }
  // Published chat bytes do not survive leaving the account.
  //
  // The store is shared across environments and signed-in users on purpose - an
  // entry is named by the sha256 of its own bytes, so it cannot be stale for
  // anyone, only absent - which is exactly why an explicit logout has to be the
  // thing that drops it. Every entry is a copy of bytes the cloud still holds,
  // so deleting the directory is always safe and costs one cold read.
  //
  // AFTER the delete is confirmed, and awaited: unlike the GUI there is no
  // process left to finish the work, so a fire-and-forget clear here would race
  // the command's own exit.
  //
  // A clear that FAILS does not undo the sign-out - the credential delete has
  // already landed, and no amount of re-running logout improves on a filesystem
  // that refuses the delete - but it IS reported as a failure (exit 1), because
  // this command now advertises two deletions and only one of them happened.
  //
  // The exit code is the only part of the result an unattended caller reads.
  // `traycer logout && hand-over-the-machine` must not proceed with the user's
  // published-chat content still on disk, and the two errors are not
  // symmetric: a false alarm stops a script that can be re-run, while a false
  // all-clear leaves content behind on a machine somebody is walking away from.
  // The runner supports exactly this (`runner.ts`: a non-zero exit on an `ok`
  // result, as `whoami` uses for "not signed in"), so nothing here claims the
  // sign-out failed - `data.loggedOut` still reports it landed, and the human
  // line still leads with "Logged out."
  const cachePath = cliChatPartCacheDir();
  const cacheClearError = await clearDiskChatPartCache(cachePath);
  const loggedOutLine = hadSession ? "Logged out." : "Not logged in.";
  return {
    data: {
      loggedOut: hadSession,
      chatCache: {
        path: cachePath,
        cleared: cacheClearError === null,
        error: cacheClearError === null ? null : cacheClearError.message,
      },
      // Deprecated alias for `chatCache.cleared`, kept because `--json` is a
      // documented automation surface and this CLI ships to machines whose
      // scripts we cannot grep. Remove on the next intentional break.
      chatCacheCleared: cacheClearError === null,
    },
    human: ctx.runtime.json
      ? null
      : cacheClearError === null
        ? // "Cleared", not "removed N files": the clear succeeds against a
          // cache that was never written, and the sentence has to stay true in
          // that case too.
          `${loggedOutLine} Cleared the local published-chat cache at ${cachePath}.`
        : `${loggedOutLine} The cached published-chat content at ${cachePath} could not be removed (${cacheClearError.message}); delete that directory manually to finish clearing local data.`,
    exitCode: cacheClearError === null ? 0 : 1,
  };
};
