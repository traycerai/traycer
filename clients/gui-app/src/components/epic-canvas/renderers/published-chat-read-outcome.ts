import { createContext } from "react";

export type PublishedChatReadOutcome = "awaiting" | "readable" | "unavailable";

export const PublishedChatReadOutcomeContext = createContext<
  ((outcome: PublishedChatReadOutcome) => void) | null
>(null);
