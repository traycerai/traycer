import { createContext } from "react";
import type { BrowserLinkSource } from "@/lib/browser-view/browser-link-routing-core";

export interface BrowserLinkRoutingContextValue {
  readonly source: BrowserLinkSource;
}

export const BrowserLinkRoutingContext =
  createContext<BrowserLinkRoutingContextValue | null>(null);
