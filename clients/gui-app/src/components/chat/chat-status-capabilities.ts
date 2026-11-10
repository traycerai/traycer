import { createContext, type ReactNode } from "react";

/** Whether the session surface is read-only, including layout editing. */
export const ChatStatusReadOnlyContext = createContext(false);

export interface ChatStatusExtraRow {
  readonly id: string;
  readonly content: ReactNode;
}

export const ChatStatusExtraRowsContext = createContext<
  readonly ChatStatusExtraRow[]
>([]);
export const ChatStatusFreshContext = createContext(true);
