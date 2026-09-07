import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { clearDiskChatPartCache } from "../store/chat-part-cache";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";
import { cliChatPartCacheDir } from "../store/paths";

// Runner-aware `traycer logout`.
// JSON mode emits exactly one terminal NDJSON `result` event; human mode prints a single human line.
export const logoutCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  const { hadSession, signOut } = await runWithCliStore(async (store) => {
    const before = await store.read();
    const outcome = await withCommitRetry(() => store.signOut(null), null);
    return { hadSession: before !== null, signOut: outcome };
  });
  if (signOut.outcome !== "deleted") {
    // `lock-busy` (another traycer process holds the credentials lock) or `commit-failed`.
    // Neither can claim signed-out - but neither can claim still-signed-in either: `commitMutation` DELETES the credentials file at its apply step and only then finalizes the sidecar, so a finalize fault returns `commit-failed` with the file already gone.
    throw cliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message:
        "Logout could not confirm that the stored credentials were cleared - another traycer process may be busy. You may or may not still be signed in; run `traycer logout` again, then `traycer whoami` to check.",
      details: { signOutOutcome: signOut.outcome },
      exitCode: 1,
    });
  }
  // Published chat bytes do not survive leaving the account. Delete the cache on logout, not later.
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
      // Deprecated alias for `chatCache.cleared`, kept because `--json` is a documented automation surface and this CLI ships to machines whose scripts we cannot grep.
      // Remove on the next intentional break.
      chatCacheCleared: cacheClearError === null,
    },
    human: ctx.runtime.json
      ? null
      : cacheClearError === null
        ? // "Cleared", not "removed N files": the sentence stays true even when the cache was never written.
          `${loggedOutLine} Cleared the local published-chat cache at ${cachePath}.`
        : `${loggedOutLine} The cached published-chat content at ${cachePath} could not be removed (${cacheClearError.message}); delete that directory manually to finish clearing local data.`,
    exitCode: cacheClearError === null ? 0 : 1,
  };
};
