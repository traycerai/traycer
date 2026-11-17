import { createContext } from "react";

export const BotReadPresenceContext = createContext(true);

/** A visit ends with the surface, not when its window loses focus. */
export const BotVisitPresenceContext = createContext(true);
