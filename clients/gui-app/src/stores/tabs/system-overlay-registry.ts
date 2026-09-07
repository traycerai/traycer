/**
 * Registry for system overlay kinds (history | settings). System tabs have a dual presentation
 * mode:
 */
import type { ComponentType, ReactNode } from "react";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type {
  SystemModalActive,
  SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";
import { historyOverlayModule } from "@/stores/tabs/overlays/history";
import { settingsOverlayModule } from "@/stores/tabs/overlays/settings";

const SYSTEM_OVERLAYS = {
  history: historyOverlayModule,
  settings: settingsOverlayModule,
} as const;


export interface SystemOverlayModule<K extends SystemOverlayKind> {
  readonly kind: K;
  /** Display label shown in the modal header. */
  readonly label: string;
  /** Lucide icon component shown next to the label. */
  readonly Icon: ComponentType<{ className: string | undefined }>;
  readonly renderBody: (
    active: SystemModalActive,
    onClose: () => void,
  ) => ReactNode;
  readonly promotionIntent: (active: SystemModalActive) => TabNavigationIntent;
  readonly isOverlayPath: (pathname: string) => boolean;
}


export function renderOverlayBody(
  active: SystemModalActive,
  onClose: () => void,
): ReactNode {
  switch (active.kind) {
    case "settings":
      return SYSTEM_OVERLAYS.settings.renderBody(active, onClose);
    case "history":
      return SYSTEM_OVERLAYS.history.renderBody(active, onClose);
  }
}

export function overlayMeta(active: SystemModalActive): {
  readonly label: string;
  readonly Icon: ComponentType<{ className: string | undefined }>;
} {
  return SYSTEM_OVERLAYS[active.kind];
}

/** Attempts to route a system-tab `intent` through the modal bridge API. */
export function routeIntentViaModalBridge(
  intent: TabNavigationIntent,
  api: {
    readonly openHistory: () => void;
    readonly openSettings: (opts: {
      readonly section:
        | import("@/lib/settings-sections").SettingsSectionId
        | null;
      readonly resetToGeneral: boolean;
    }) => void;
  },
): boolean {
  if (intent.kind === "history") {
    api.openHistory();
    return true;
  }
  if (intent.kind === "settings") {
    api.openSettings({ section: intent.section, resetToGeneral: false });
    return true;
  }
  return false;
}
