import { useState, type ReactNode } from "react";
import {
  createSubagentOpenStoreForProvider,
  SubagentOpenStoreContext,
} from "./subagent-open-store-context";

interface SubagentOpenStoreProviderProps {
  readonly children: ReactNode;
}

export function SubagentOpenStoreProvider(
  props: SubagentOpenStoreProviderProps,
) {
  const [store] = useState(createSubagentOpenStoreForProvider);
  return (
    <SubagentOpenStoreContext.Provider value={store}>
      {props.children}
    </SubagentOpenStoreContext.Provider>
  );
}
