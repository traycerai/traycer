import { createContext } from "react";

/**
 * True beneath `TeamViewingHostBinding`. A read there goes to the team's
 * viewing host, which no Settings scope names, so a component shared with a
 * team page keeps its own error line there (`HostReadFailure`) and names a
 * computer only where it is mounted for the picked one.
 */
export const TeamViewingHostReadContext = createContext(false);
