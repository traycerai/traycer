import { createContext } from "react";

/**
 * Whether the surrounding composer surface is "active" - visible and allowed
 * to keep its catalog/provider queries subscribed. Defaults to `true` so
 * surfaces that never gate activity (e.g. the chat composer today) need no
 * provider at all.
 */
export const SurfaceActivityContext = createContext<boolean>(true);
