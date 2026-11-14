import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { StoredCredentials } from "../../ipc-contracts/auth-types";
import type { DesktopLocalAuthSessionRestoreResult } from "../../ipc-contracts/window-types";
import { log } from "../app/logger";
import { parseTokenRotateExpected } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

const MAX_LOCAL_RESTORE_READS = 3;

/** The user and token a window holds, which main's own store must carry. */
export interface LocalSessionExpectation {
  readonly userId: string;
  readonly token: string;
}

export type RestoreLocalSession = (
  expected: LocalSessionExpectation,
) => Promise<DesktopLocalAuthSessionRestoreResult>;

/**
 * An unverified renderer can use the local host, but cannot vouch for an
 * account to main. Restore from main's credentials store, requiring the pair
 * this window actually holds. This never verifies a cloud session or signs
 * sibling windows in; their auth services restore from the same file.
 *
 * Returns the same restore for main's own use: a signed-in window whose token
 * main cannot check yet is held under exactly this rule (`auth-ipc.ts`).
 */
export function registerLocalAuthSessionRestore(
  bridge: RunnerIpcBridge,
): RestoreLocalSession {
  let storeRevision = 0;
  bridge.disposeFns.push(
    bridge.authTokenStore.subscribe(() => {
      storeRevision += 1;
    }),
  );
  const restore: RestoreLocalSession = async (expected) => {
    const generation = bridge.authSession.beginSet();
    for (let attempt = 0; attempt < MAX_LOCAL_RESTORE_READS; attempt += 1) {
      const revision = storeRevision;
      let stored: StoredCredentials | null;
      try {
        stored = await bridge.authTokenStore.get();
      } catch {
        log.warn("[auth] could not read the stored local session");
        return "unavailable";
      }
      // Watcher hints may repeat the same pair. Re-read an invalidated
      // answer: dropping it silently could strand main on signed-out with
      // no later renderer transition to retry. A real deletion or rotation
      // is rejected once observed; continuous churn is surfaced as a fault.
      if (revision !== storeRevision) continue;
      if (
        stored === null ||
        stored.token.length === 0 ||
        stored.token !== expected.token ||
        stored.user.id !== expected.userId
      ) {
        return "superseded";
      }
      const restored = bridge.authSession.setLocal(
        {
          status: "unverified",
          token: stored.token,
          profile: {
            userId: stored.user.id,
            userName: stored.user.name,
            email: stored.user.email,
          },
        },
        generation,
      );
      return restored ? "restored" : "superseded";
    }
    return "unavailable";
  };
  bridge.handleInvoke(
    RunnerHostInvoke.authSessionRestoreLocal,
    async (_event, input: unknown) => restore(parseTokenRotateExpected(input)),
  );
  return restore;
}
