import type { SyntheticEvent } from "react";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import type { BrowserPersistenceController } from "@/lib/browser-view/use-browser-persistence-state";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";

/**
 * Runtime capabilities of one Electron tile. A toolbar control renders
 * iff its flag is true - never based on who created the tile.
 */
export interface TileChromeCapabilities {
  readonly navigate: boolean;
  readonly back: boolean;
  readonly forward: boolean;
  readonly reload: boolean;
  readonly zoom: boolean;
  readonly viewportPreset: boolean;
  readonly devtools: boolean;
  readonly find: boolean;
  readonly siteInfo: boolean;
  readonly annotate: boolean;
}

export interface TileController {
  readonly capabilities: TileChromeCapabilities;
  readonly url: string;
  readonly addressValue: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  readonly viewportPreset: BrowserViewViewportPresetId;
  readonly disabled: boolean;
  /**
   * Desktop browser-login persistence for this tile's runtime, or null where
   * there is no desktop to ask (a screencast tile). One shared store backs it,
   * so every tile's shield reads the same answer.
   */
  readonly persistence: BrowserPersistenceController | null;
  readonly zoomLocked: boolean;
  readonly annotation: BrowserAnnotationSessionController | null;
  readonly onNavigate: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => void;
  readonly onAddressChange: (value: string) => void;
  /**
   * Caret entering or leaving the address field. The draft is focus-owned
   * (`use-address-draft.ts`), so the toolbar reports it rather than each tile
   * sniffing focus events off its own DOM subtree.
   */
  readonly onAddressFocusChange: (focused: boolean) => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomIn: () => void;
  readonly onResetZoom: () => void;
  readonly onViewportPresetChange: (
    preset: BrowserViewViewportPresetId,
  ) => void;
  readonly onOpenDevTools: () => void;
}

/** Full chrome on the primary-profile runtime. */
export const PRIMARY_TILE_CHROME_CAPABILITIES: TileChromeCapabilities = {
  navigate: true,
  back: true,
  forward: true,
  reload: true,
  zoom: true,
  viewportPreset: true,
  devtools: true,
  find: true,
  siteInfo: true,
  annotate: true,
};
