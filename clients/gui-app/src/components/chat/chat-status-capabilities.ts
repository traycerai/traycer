import { createContext, type ReactNode } from "react";

/** Whether the status surfaces may offer actions that change the session. */
export const ChatStatusReadOnlyContext = createContext(false);

export interface ChatStatusExtraRow {
  readonly id: string;
  readonly content: ReactNode;
}

export const ChatStatusExtraRowsContext = createContext<
  readonly ChatStatusExtraRow[]
>([]);
export const ChatStatusFreshContext = createContext(true);
