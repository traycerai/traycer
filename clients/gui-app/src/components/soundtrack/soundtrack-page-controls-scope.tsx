import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { SoundtrackPageControlsContext } from "./soundtrack-page-controls-context";

export function SoundtrackPageControlsScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const settingsOpen = useRouterState({
    select: (state) =>
      parseSystemTabOverlayView(state.location.search).settingsOverlay,
  });
  return (
    <SoundtrackPageControlsContext value={!settingsOpen}>
      {props.children}
    </SoundtrackPageControlsContext>
  );
}
