import { createContext } from "react";

export interface AutomationTerminalOpen {
  readonly run: () => void;
  readonly retry: () => void;
  readonly starting: boolean;
  readonly failed: boolean;
  readonly hostId: string | null;
}

export const AutomationTerminalOpenContext =
  createContext<AutomationTerminalOpen | null>(null);
