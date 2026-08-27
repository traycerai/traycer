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
    // `commit-failed` (the delete/tombstone never landed) or `lock-busy`
    // (another traycer process holds the credentials lock): the credential was
    // NOT cleared, so we must not claim signed-out.
    throw cliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message:
        "Logout failed to clear the stored credentials - another traycer process may be busy; please try again.",
      details: null,
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
  // A clear that FAILS does not fail the logout, and that is a decision rather
  // than an oversight (CLI-017): the credential delete has already landed, so
  // the session IS over, and no amount of re-running logout can improve on a
  // filesystem that refuses the delete. Reporting exit 1 would tell every
  // caller "you are still signed in", which is false and the more dangerous of
  // the two errors.
  //
  // But it must not be silent either: the bytes it names are exactly what the
  // clear exists to remove. So the partial outcome is MODELLED - `chatCache`
  // carries the path, whether it went, and the reason it did not - and the
  // human line names the directory the user has to delete by hand.
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
    },
    human: ctx.runtime.json
      ? null
      : cacheClearError === null
        ? // "Cleared", not "removed N files": the clear succeeds against a
          // cache that was never written, and the sentence has to stay true in
          // that case too.
          `${loggedOutLine} Cleared the local published-chat cache at ${cachePath}.`
        : `${loggedOutLine} The cached published-chat content at ${cachePath} could not be removed (${cacheClearError.message}); delete that directory manually to finish clearing local data.`,
    exitCode: 0,
  };
};
