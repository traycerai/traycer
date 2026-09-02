import type { SyntheticEvent } from "react";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserSessionProfileKind } from "@traycer/protocol/host/browser/contracts";

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
  /**
   * The session's credential-sharing profile. `isolated` is a private
   * session: the toolbar says so, and offers no action, because there is
   * nothing here to save or clear.
   */
  readonly profile: BrowserSessionProfileKind;
  readonly url: string;
  readonly addressValue: string;
  /** Callback ref for the address field (a ref OBJECT may not cross render). */
  readonly setAddressInput: (node: HTMLInputElement | null) => void;
  /** Put the caret in the address field - Cmd+L over a focused guest. */
  readonly focusAddress: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  readonly viewportPreset: BrowserViewViewportPresetId;
  readonly disabled: boolean;
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
  /**
   * "Clear cookies for this site" (spec §6.5): removes this tile's registrable
   * domain from the shared `primary` jar, here and - through the host's
   * tombstones - in every other live context for this user. `null` where there
   * is no desktop jar to clear (a screencast tile). The site is derived in the
   * main process from this tile's own URL, so the toolbar names it but never
   * chooses it.
   */
  readonly onClearSite: (() => void) | null;
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
