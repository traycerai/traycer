import { useEffect, useState } from "react";
import type {
  BrowserCookieCryptoState,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

interface BrowserCookieCryptoStateLoad {
  readonly state: BrowserCookieCryptoState;
}

const DEGRADED_COOKIE_CRYPTO_STATE: BrowserCookieCryptoState = {
  mode: "degraded",
  persistence: "ephemeral",
  reason: "unresolved",
  storageBackend: null,
  encryptionAvailable: false,
  mockKeychainEnabled: false,
};

export function useBrowserCookieCryptoState(
  browserView: BrowserViewBridge | null,
): BrowserCookieCryptoState | null {
  const [load, setLoad] = useState<BrowserCookieCryptoStateLoad | null>(null);

  useEffect(() => {
    if (browserView === null) return;
    let active = true;
    browserView
      .getCookieCryptoState()
      .then((nextState) => {
        if (active) setLoad({ state: nextState });
      })
      .catch(() => {
        if (active) setLoad({ state: DEGRADED_COOKIE_CRYPTO_STATE });
      });
    return () => {
      active = false;
    };
  }, [browserView]);

  if (browserView === null) return null;
  return load?.state ?? null;
}
