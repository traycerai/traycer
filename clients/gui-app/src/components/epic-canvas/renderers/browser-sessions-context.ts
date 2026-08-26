import { createContext, useContext } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";

export type BrowserSessionsLifecycle =
  "connecting" | "live" | "reconnecting" | "closed" | "failed";

export interface OpenBrowserTabResult {
  readonly sessionId: string;
  readonly tabId: string;
}

export interface BrowserSessionsState {
  readonly hostId: string | null;
  readonly lifecycle: BrowserSessionsLifecycle;
  /** True only after the current stream incarnation supplied its full snapshot. */
  readonly inventoryReady: boolean;
  readonly items: readonly BrowserSessionInfo[];
  readonly errorMessage: string | null;
  readonly retry: () => void;
  readonly openTab: (
    sessionId: string | null,
    url: string,
  ) => Promise<OpenBrowserTabResult>;
  readonly closeTab: (sessionId: string, tabId: string) => Promise<void>;
}

export const BrowserSessionsContext =
  createContext<BrowserSessionsState | null>(null);

export function useMaybeBrowserSessionsContext(): BrowserSessionsState | null {
  return useContext(BrowserSessionsContext);
}

export function useBrowserSessionsContext(): BrowserSessionsState {
  const value = useMaybeBrowserSessionsContext();
  if (value === null) {
    throw new Error("BrowserSessionsProvider is not mounted.");
  }
  return value;
}
