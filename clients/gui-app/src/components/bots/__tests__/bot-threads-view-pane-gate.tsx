/**
 * The pane visibility the tab host provides in the app, driven here by the
 * `pane` in `bot-threads-view-state.ts`.
 */
import { type ReactNode, useSyncExternalStore } from "react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { pane } from "./bot-threads-view-state";

/** The pane's visibility as the tab host provides it, driven by `setPaneVisible`. */
export function PaneGate(props: { readonly children: ReactNode }): ReactNode {
  const visible = useSyncExternalStore(
    (listener) => {
      pane.listeners.add(listener);
      return () => pane.listeners.delete(listener);
    },
    () => pane.visible,
  );
  return (
    <PaneVisibilityContext value={visible}>
      {props.children}
    </PaneVisibilityContext>
  );
}
