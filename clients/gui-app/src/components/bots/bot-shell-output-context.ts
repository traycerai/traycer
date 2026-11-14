import { createContext } from "react";

export const BotShellOutputContext = createContext<
  ((commandId: string, trigger: HTMLElement) => void) | null
>(null);
