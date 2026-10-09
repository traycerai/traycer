import { useCallback, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { subscribeHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { urlCarriesCredentials } from "@/components/providers/credential-bearing-values";
import {
  hostEntryTakesCredentials,
  SANDBOX_CREDENTIALS_REFUSED,
} from "@/components/settings/host-scope/host-option-model";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostBinding } from "@/lib/host";

/**
 * Why a credential may not be sent to `hostId`, or `null` when it may.
 *
 * A sandbox never takes a user credential (`hostEntryTakesCredentials`), and
 * the only safe refusal is the one made before the RPC: a sandbox's own
 * refusal would come after the key was already on its machine. So every
 * control that sends a sign-in, a key or an env override disables itself on
 * this answer and shows it as its reason.
 *
 * `null` for `hostId` means the surface's own host (`useAddressableHostId`):
 * inside Settings that is the SCOPED host, everywhere else the app-wide one,
 * which is the host a `null`-targeted client would send to.
 *
 * Null-tolerant like `useAddressableHostId`: with no host runtime there is no
 * client to send through either, so there is nothing to refuse.
 */
export function useHostCredentialRefusal(hostId: string | null): string | null {
  const binding = useHostBinding();
  const addressableHostId = useAddressableHostId();
  const resolvedHostId = hostId ?? addressableHostId;
  const directory = binding === null ? null : binding.directory;
  const subscribe = useCallback(
    (callback: () => void) => {
      if (directory === null) return () => undefined;
      const unsubscribeRow =
        resolvedHostId === null
          ? () => undefined
          : subscribeHostRowChanged(resolvedHostId, callback);
      const subscription = directory.onChange(() => {
        callback();
      });
      return () => {
        subscription.dispose();
        unsubscribeRow();
      };
    },
    [directory, resolvedHostId],
  );
  // A boolean, so the snapshot is stable across directory churn.
  const getSnapshot = useCallback((): boolean => {
    if (directory === null || resolvedHostId === null) return true;
    return hostEntryTakesCredentials(directory.findById(resolvedHostId));
  }, [directory, resolvedHostId]);
  const takesCredentials = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return takesCredentials ? null : SANDBOX_CREDENTIALS_REFUSED;
}

/** What a refused URL's toast says to do about it. */
export const CREDENTIALED_URL_REFUSAL_DESCRIPTION =
  "Remove the sign-in from this URL to open it here.";

/**
 * Why `url` may not be sent to the browser of the host behind `hostEntry`, or
 * `null` when it may. A sandbox's browser is never sent a URL that carries a
 * sign-in (`https://user:token@…`).
 *
 * Called before the RPC at every seam that sends a URL a user gave to a
 * host's browser: the tile's address bar, a link opened in a browser tile,
 * and the palette's "Open <url>". As with the other credential refusals, the
 * sandbox's own refusal would come after the secret was already on its
 * machine.
 */
export function credentialedUrlRefusal(
  hostEntry: HostDirectoryEntry | null,
  url: string,
): string | null {
  return !hostEntryTakesCredentials(hostEntry) && urlCarriesCredentials(url)
    ? SANDBOX_CREDENTIALS_REFUSED
    : null;
}
