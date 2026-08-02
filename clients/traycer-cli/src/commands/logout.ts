import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";

// Runner-aware `traycer logout`. JSON mode emits exactly one terminal
// NDJSON `result` event; human mode prints a single human line.
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
    const outcome = await withCommitRetry(() => store.signOut(null));
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
  return {
    data: { loggedOut: hadSession },
    human: ctx.runtime.json
      ? null
      : hadSession
        ? "Logged out."
        : "Not logged in.",
    exitCode: 0,
  };
};
