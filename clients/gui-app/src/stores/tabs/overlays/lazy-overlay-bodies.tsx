import { lazy, Suspense, type ReactNode } from "react";
import { DelayedRoutePendingScreen } from "@/components/loading/route-pending-screen";
import type { SettingsSectionId } from "@/lib/settings-sections";

// The overlay registry is imported at boot, so its bodies are `lazy()`: a
// static import here would be a path from the entry into the whole Settings
// panel graph (charts, editor themes, entity tables). Desktop warms both
// modules at idle (`warmRouteChunks`); the phone never opens the modal.
const SettingsModalContent = lazy(() =>
  import("@/components/settings/settings-modal-content").then((module) => ({
    default: module.SettingsModalContent,
  })),
);

const HistoryModalContent = lazy(() =>
  import("@/components/epics/history-modal-content").then((module) => ({
    default: module.HistoryModalContent,
  })),
);

export function LazySettingsModalBody(props: {
  readonly section: SettingsSectionId | null;
}): ReactNode {
  return (
    <Suspense fallback={<DelayedRoutePendingScreen />}>
      <SettingsModalContent section={props.section} />
    </Suspense>
  );
}

export function LazyHistoryModalBody(props: {
  readonly onSelectEpic: () => void;
}): ReactNode {
  return (
    <Suspense fallback={<DelayedRoutePendingScreen />}>
      <HistoryModalContent onSelectEpic={props.onSelectEpic} />
    </Suspense>
  );
}
