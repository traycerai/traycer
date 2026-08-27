import { useEffect, useState } from "react";
import type {
  BrowserCookieCryptoState,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

const DEGRADED_COOKIE_CRYPTO_STATE: BrowserCookieCryptoState = {
  mode: "degraded",
  persistence: "ephemeral",
  reason: "unresolved",
  storageBackend: null,
  encryptionAvailable: false,
};

export function useBrowserCookieCryptoState(
  browserView: BrowserViewBridge | null,
): BrowserCookieCryptoState | null {
  const [state, setState] = useState<BrowserCookieCryptoState | null>(null);

  useEffect(() => {
    if (browserView === null) return;
    let active = true;
    browserView
      .getCookieCryptoState()
      .then((nextState) => {
        if (active) setState(nextState);
      })
      .catch(() => {
        if (active) setState(DEGRADED_COOKIE_CRYPTO_STATE);
      });
    return () => {
      active = false;
    };
  }, [browserView]);

  if (browserView === null) return null;
  return state;
}
