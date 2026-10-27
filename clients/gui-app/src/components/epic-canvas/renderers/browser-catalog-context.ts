import { createContext, useContext } from "react";
import type { BrowserCatalogModel } from "@/hooks/browser/use-browser-catalog-inventory";

/** One task query is shared by the sidebar, header and mobile list. */
export const BrowserCatalogContext = createContext<BrowserCatalogModel | null>(
  null,
);

export function useBrowserCatalogContext(): BrowserCatalogModel | null {
  return useContext(BrowserCatalogContext);
}
