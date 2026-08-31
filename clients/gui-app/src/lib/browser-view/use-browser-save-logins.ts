import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { browserMutationKeys, browserQueryKeys } from "@/lib/query-keys";

/**
 * Does this machine keep browser logins across restarts? On by default,
 * Chrome-style; Settings ▸ Browser is the only surface that reads or writes it.
 *
 * Read on mount, every mount. The pref is machine-wide but each window has its
 * own bridge, and the pivot deleted the fan-out that used to push a change to
 * the others - so a cached read would leave a second window's toggle showing a
 * value that has been wrong since another window changed it. `staleTime: 0` is
 * that contract in Query's terms - the entry is stale the moment it lands - and
 * `refetchOnMount: "always"` states it a second way that no staleTime default
 * can quietly take back.
 */

export interface BrowserSaveLoginsController {
  /** Null until the first read settles, and after a read that failed. */
  readonly enabled: boolean | null;
  /** A set call is in flight. */
  readonly pending: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

export function useBrowserSaveLogins(
  browserView: BrowserViewBridge | null,
): BrowserSaveLoginsController {
  const queryClient = useQueryClient();
  const saveLogins = useQuery({
    queryKey: browserQueryKeys.saveLogins(),
    queryFn: async (): Promise<boolean> => {
      // Unreachable while `enabled` gates the fetch on the same condition; the
      // bridge is nullable, so the read has to say so rather than assert.
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return await browserView.getSaveLogins();
    },
    enabled: browserView !== null,
    staleTime: 0,
    refetchOnMount: "always",
    // One machine-local read: a retry would only delay the toggle's answer.
    retry: false,
  });
  const setSaveLogins = useMutation<boolean, Error, boolean>({
    mutationKey: browserMutationKeys.setSaveLogins(),
    mutationFn: async (next: boolean): Promise<boolean> => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return await browserView.setSaveLogins(next);
    },
    // The SETTLED value, not the requested one: a desktop that kept a different
    // answer is the authority on what this machine now does.
    onSuccess: (settled) => {
      queryClient.setQueryData<boolean>(browserQueryKeys.saveLogins(), settled);
    },
    // A refused write settled nothing, so the toggle goes back to whatever the
    // machine still holds - re-read rather than reconstructed here, which is
    // what keeps this hook from carrying a second copy of the truth.
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: browserQueryKeys.saveLogins(),
      });
    },
  });

  return {
    enabled:
      saveLogins.isError || saveLogins.data === undefined
        ? null
        : saveLogins.data,
    pending: setSaveLogins.isPending,
    setEnabled: (next: boolean) => {
      if (browserView === null || setSaveLogins.isPending) return;
      setSaveLogins.mutate(next);
    },
  };
}
