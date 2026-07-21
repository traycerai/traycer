import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import { validateAuthTokenIdentityAccessOnly } from "@traycer-clients/shared/auth/auth-validation";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import {
  assertString,
  parseDesktopAuthSession,
  parseStoredAuthTokens,
  parseStoredCredentialsIdentity,
  parseTokenRotateExpected,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * Auth IPC handlers: token *validation* against the authn service, plus the
 * credentials-file token store (tech plan §3). Credential persistence now lives
 * in the main-process `FileTokenStore` (single machine-local file + lock/WAL),
 * reached through the `authTokenStore*` channels; the renderer's `ITokenStore`
 * is an IPC client of it. Validation stays access-only here — a token *spend*
 * happens only inside `tokenStore.rotate`, under the file lock.
 */
export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.validateAuthTokenIdentity,
    async (_event, token: unknown) => {
      assertString(token, "validateAuthTokenIdentity");
      // Access-only (§3): no refresh-on-401. A stale token comes back `rejected`
      // and the renderer routes the spend through the locked `tokenStore.rotate`.
      return validateAuthTokenIdentityAccessOnly(
        bridge.options.authnBaseUrl,
        token,
      );
    },
  );

  // Credentials-file token store (tech plan §3). The renderer's `ITokenStore` is
  // an IPC client of the main `FileTokenStore`; `rotate` performs the refresh
  // spend in main, inside the file lock.
  bridge.handleInvoke(RunnerHostInvoke.authTokenStoreGet, () => {
    return bridge.authTokenStore.get();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreSignIn,
    (_event, tokens: unknown, identity: unknown) => {
      return bridge.authTokenStore.signIn(
        parseStoredAuthTokens(tokens),
        parseStoredCredentialsIdentity(identity),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreRotate,
    (_event, expected: unknown) => {
      return bridge.authTokenStore.rotate(parseTokenRotateExpected(expected));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.authTokenStoreDelete, () => {
    return bridge.authTokenStore.delete();
  });
  // §6 one-time legacy→file migration. The renderer decrypts its legacy
  // localStorage token pair and hands it over; main single-flights the reconcile
  // across windows. Same fail-closed `{ token, refreshToken }` parse as signIn.
  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreMigrateLegacy,
    (_event, legacy: unknown) => {
      return bridge.authTokenStore.migrateLegacyCredentials(
        parseStoredAuthTokens(legacy),
      );
    },
  );

  // Fan the owned-watcher change events out to every window (source lands in §4;
  // a live registration that never fires until then). Torn down on dispose,
  // which also disposes the underlying mutation store.
  const unsubscribeTokenStore = bridge.authTokenStore.subscribe((change) => {
    bridge.fanOut(RunnerHostEvent.authTokenStoreChange, change);
  });
  bridge.disposeFns.push(unsubscribeTokenStore);
  bridge.disposeFns.push(() => bridge.authTokenStore.dispose());

  bridge.handleInvoke(RunnerHostInvoke.authSessionGet, () => {
    return bridge.authSession.get();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.authSessionSet,
    (_event, snapshot: unknown) => {
      bridge.authSession.set(parseDesktopAuthSession(snapshot));
    },
  );

  const onAuthSessionChange = (snapshot: DesktopAuthSessionSnapshot): void => {
    bridge.fanOut(RunnerHostEvent.authSessionChange, snapshot);
  };
  bridge.authSession.on("change", onAuthSessionChange);
  bridge.disposeFns.push(() => {
    bridge.authSession.off("change", onAuthSessionChange);
  });

  bridge.fanOut(RunnerHostEvent.authSessionChange, bridge.authSession.get());
}
