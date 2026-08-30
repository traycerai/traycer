import { useCallback, useEffect, useState } from "react";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";

/**
 * Does this machine keep browser logins across restarts? On by default,
 * Chrome-style; Settings ▸ Browser is the only surface that reads or writes it.
 *
 * Read on mount, every mount. The pref is machine-wide but each window has its
 * own bridge, and the pivot deleted the fan-out that used to push a change to
 * the others - so a cached read would leave a second window's toggle showing a
 * value that has been wrong since another window changed it.
 */

export interface BrowserSaveLoginsController {
  /** Null until the first read settles, and on a bridge that predates this. */
  readonly enabled: boolean | null;
  /** A set call is in flight. */
  readonly pending: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

export function useBrowserSaveLogins(
  browserView: BrowserViewBridge | null,
): BrowserSaveLoginsController {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (browserView === null) return;
    let cancelled = false;
    // Wrapped so a bridge older than this call rejects rather than throwing
    // synchronously out of the effect.
    void Promise.resolve()
      .then(() => browserView.getSaveLogins())
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        if (!cancelled) setEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, [browserView]);

  const requestEnabled = useCallback(
    (next: boolean) => {
      if (browserView === null || pending) return;
      setPending(true);
      void Promise.resolve()
        .then(() => browserView.setSaveLogins(next))
        // The settled value, not the requested one: a desktop that refused the
        // durable write rejects, and the toggle stays where it was.
        .then((settled) => {
          setEnabled(settled);
        })
        .catch(() => undefined)
        .finally(() => {
          setPending(false);
        });
    },
    [browserView, pending],
  );

  return { enabled, pending, setEnabled: requestEnabled };
}
