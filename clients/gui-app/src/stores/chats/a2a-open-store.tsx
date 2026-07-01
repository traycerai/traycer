import { useState, type ReactNode } from "react";
import {
  A2AOpenStoreContext,
  createA2AOpenStore,
} from "./a2a-open-store-context";

interface A2AOpenStoreProviderProps {
  readonly children: ReactNode;
}

export function A2AOpenStoreProvider(props: A2AOpenStoreProviderProps) {
  const [store] = useState(createA2AOpenStore);
  return (
    <A2AOpenStoreContext.Provider value={store}>
      {props.children}
    </A2AOpenStoreContext.Provider>
  );
}
