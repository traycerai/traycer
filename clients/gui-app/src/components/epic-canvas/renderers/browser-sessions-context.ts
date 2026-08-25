import { createContext, useContext } from "react";
import type {
  BrowserSessionInfo,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";

type PromoteStateFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "promoteState" }
>;

type LendResultFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "lendResult" }
>;

type BrowserStorageLendPayload = Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "lendStorage" }
>["storage"];

export type BrowserSessionsLifecycle =
  "connecting" | "live" | "reconnecting" | "closed" | "failed";

export interface BrowserSessionsState {
  readonly lifecycle: BrowserSessionsLifecycle;
  /** True only after the current stream incarnation supplied its full snapshot. */
  readonly inventoryReady: boolean;
  readonly items: readonly BrowserSessionInfo[];
  readonly errorMessage: string | null;
  readonly routingChatId: string | null;
  readonly retry: () => void;
  readonly closeSession: (sessionId: string) => void;
  readonly closeTab: (sessionId: string, tabId: string) => Promise<void>;
  readonly requestPromoteState: (
    sessionId: string,
  ) => Promise<PromoteStateFrame>;
  readonly requestLendStorage: (
    sessionId: string,
    origin: string,
    storage: BrowserStorageLendPayload,
  ) => Promise<LendResultFrame>;
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
