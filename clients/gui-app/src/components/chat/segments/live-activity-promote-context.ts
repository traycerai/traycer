import { createContext, useContext } from "react";

/** Non-null for rows rendered inside the bounded live activity window, where an in-place disclosure cannot be read. A row that finds a promote callback in context therefore does not expand where it stands. */
export const LiveActivityPromoteContext = createContext<(() => void) | null>(
  null,
);

export function useLiveActivityPromote(): (() => void) | null {
  return useContext(LiveActivityPromoteContext);
}
