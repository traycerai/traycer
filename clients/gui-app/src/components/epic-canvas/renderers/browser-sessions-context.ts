import { createContext, useContext } from "react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

export type { BrowserSessionsLifecycle } from "@/lib/browser-view/sessions/browser-sessions-stream";
export type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

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
