import { createContext, use } from "react";

export const EpicViewTabContext = createContext<string | null>(null);

export function useEpicViewTabId(): string | null {
  return use(EpicViewTabContext);
}
