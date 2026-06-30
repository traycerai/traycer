/**
 * Registry for system overlay kinds (history | settings).
 *
 * System tabs have a dual presentation mode:
 *  - URL `?settingsOverlay=` / `?historyOverlay=` query param → MODAL
 *  - URL `/settings/...` / `/epics` path                       → STRIP TAB
 *
 * This file centralises all overlay-specific dispatch so consumer code
 * can call `renderOverlayBody(active, onClose)` instead of switching on
 * `active.kind`.
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

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

export interface SystemOverlayModule<K extends SystemOverlayKind> {
  readonly kind: K;
  /** Display label shown in the modal header. */
  readonly label: string;
  /** Lucide icon component shown next to the label. */
  readonly Icon: ComponentType<{ className: string | undefined }>;
  /**
   * Renders the body component for this overlay kind.
   * The dispatch helpers guarantee `active.kind === kind` at call time.
   */
  readonly renderBody: (
    active: SystemModalActive,
    onClose: () => void,
  ) => ReactNode;
  /**
   * Builds the `TabNavigationIntent` used when the overlay is promoted
   * to a strip tab.
   * The dispatch helpers guarantee `active.kind === kind` at call time.
   */
  readonly promotionIntent: (active: SystemModalActive) => TabNavigationIntent;
  /**
   * Returns `true` when `pathname` matches this overlay's strip-tab
   * route (used to light up the header trigger even when on the tab
   * rather than the modal).
   */
  readonly isOverlayPath: (pathname: string) => boolean;
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Renders the modal body component for the currently active overlay.
 * Eliminates `if (kind === "settings") / else` switches in the modal host.
 */
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

/**
 * Returns the label and Icon for the active overlay kind.
 * Used by the modal header to avoid per-kind switches in the component.
 */
export function overlayMeta(active: SystemModalActive): {
  readonly label: string;
  readonly Icon: ComponentType<{ className: string | undefined }>;
} {
  return SYSTEM_OVERLAYS[active.kind];
}

/**
 * Attempts to route a system-tab `intent` through the modal bridge API.
 * Returns `true` when the intent was handled (the API is live and the
 * intent kind is a known overlay kind); `false` when the caller should
 * fall through to direct TanStack navigation.
 *
 * `api.openSettings` receives `section` extracted from the intent;
 * `api.openHistory` receives no arguments.
 */
export function routeIntentViaModalBridge(
  intent: TabNavigationIntent,
  api: {
    readonly openHistory: () => void;
    readonly openSettings: (opts: {
      readonly section:
        import("@/lib/settings-sections").SettingsSectionId | null;
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
