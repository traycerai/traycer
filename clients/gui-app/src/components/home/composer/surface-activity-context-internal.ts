import { createContext } from "react";

/** Defaults to `true` so surfaces that never gate activity (e.g. the chat composer today) need no provider at
 * all. */
export const SurfaceActivityContext = createContext<boolean>(true);
