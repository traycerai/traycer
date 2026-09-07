/**
 * Per-tile host binding. Consumers under this provider read `useTabHostId()`.
 */
import { type ReactNode } from "react";
import { TabHostContext } from "./hooks/use-tab-host-id";

export interface TabHostProviderProps {
  readonly hostId: string;
  readonly children: ReactNode;
}

export function TabHostProvider(props: TabHostProviderProps): ReactNode {
  return (
    <TabHostContext.Provider value={props.hostId}>
      {props.children}
    </TabHostContext.Provider>
  );
}
