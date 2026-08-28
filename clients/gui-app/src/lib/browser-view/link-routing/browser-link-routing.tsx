import { useMemo, type ReactNode } from "react";
import { type BrowserLinkSource } from "@/lib/browser-view/link-routing/browser-link-routing-core";
import {
  BrowserLinkRoutingContext,
  type BrowserLinkRoutingContextValue,
} from "@/lib/browser-view/link-routing/browser-link-routing-context";

interface BrowserLinkRoutingProviderProps {
  readonly source: BrowserLinkSource;
  readonly children: ReactNode;
}

export function BrowserLinkRoutingProvider(
  props: BrowserLinkRoutingProviderProps,
) {
  const { hostId, paneId, viewTabId } = props.source;
  const value = useMemo<BrowserLinkRoutingContextValue>(
    () => ({ source: { hostId, paneId, viewTabId } }),
    [hostId, paneId, viewTabId],
  );
  return (
    <BrowserLinkRoutingContext.Provider value={value}>
      {props.children}
    </BrowserLinkRoutingContext.Provider>
  );
}
