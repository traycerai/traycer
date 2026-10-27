import { createContext, useContext } from "react";
import type { BrowserCatalogModel } from "@/hooks/browser/use-browser-catalog-inventory";

/** Task-wide discovery stays outside every owner-specific browser boundary. */
export const BrowserCatalogContext = createContext<BrowserCatalogModel | null>(
  null,
);

export function useBrowserCatalogContext(): BrowserCatalogModel | null {
  return useContext(BrowserCatalogContext);
}
