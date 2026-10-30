import { createContext, type ReactNode } from "react";

/** A sandbox state said in the composer's place, with its actions. */
export interface ChatStateLine {
  readonly line: string;
  readonly actions: ReactNode;
}

/**
 * Nobody sends to a sandbox that is destroyed or between two states, whatever
 * their role, so the composer's slot is that one line for an owner and a
 * viewer alike. `null` leaves the composer as it is.
 */
export const ChatStateLineContext = createContext<ChatStateLine | null>(null);

/** A sandbox's slot or footer already explains this chat's availability. */
export const ChatSandboxLineContext = createContext(false);
