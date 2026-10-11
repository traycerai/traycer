import { createContext, useContext } from "react";

interface CollapsibleState {
  readonly open: boolean;
  readonly disabled: boolean;
  readonly contentId: string;
}

export const CollapsibleStateContext = createContext<CollapsibleState | null>(
  null,
);

export function useCollapsibleState(): CollapsibleState {
  const state = useContext(CollapsibleStateContext);
  if (state === null) throw new Error("Collapsible content requires a root");
  return state;
}
