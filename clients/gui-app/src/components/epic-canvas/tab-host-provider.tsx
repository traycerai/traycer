/**
 * Per-tile host binding context.
 *
 * CLAUDE.md mandates that chat / terminal artifacts are bound to a host
 * for life. The renderer addresses **two host scopes** simultaneously:
 *
 *   - **Default host** - machine-local host for app-wide features
 *     (Epic list, opening artifacts, host-status footer). Read with
 *     `useReactiveActiveHostId()` / `useHostClient()`.
 *   - **Tab-scoped host** - per-tile binding from the artifact schema
 *     (`EpicNodeRef.hostId`). Read with `useTabHostId()` (from
 *     `./use-tab-host-id`); never with `useReactiveActiveHostId()`.
 *
 * The renderer registry wraps every tile in
 * `<TabHostProvider hostId={node.hostId}>` so consumers inside a
 * tile body always read the binding their tile was opened with - even
 * after the user swaps the global default host.
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
