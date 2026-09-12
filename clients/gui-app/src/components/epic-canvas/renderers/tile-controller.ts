import type { BrowserViewportController } from "@/components/browser-tile/use-browser-viewport";
import type { SyntheticEvent } from "react";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import type { BrowserViewColorSchemePreference } from "@traycer-clients/shared/platform/browser-view";
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
  readonly devtools: boolean;
  readonly find: boolean;
  readonly siteInfo: boolean;
  readonly annotate: boolean;
  /** Saving a screenshot of the page. */
  readonly screenshot: boolean;
  /** Recording the page to a video file. */
  readonly recording: boolean;
  /** A small always-on-top window on this tile's page. */
  readonly previewWindow: boolean;
  /** Cache-bypassing reload, beside the ordinary one in the Developer group. */
  readonly hardReload: boolean;
  /** Emulated `prefers-color-scheme` for this tile's page. */
  readonly appearance: boolean;
  /** Dropping this tile's cached responses. */
  readonly clearCache: boolean;
  /** Silencing a page that plays audio. */
  readonly audio: boolean;
}

export interface TileController {
  readonly viewport: BrowserViewportController | null;
  readonly capabilities: TileChromeCapabilities;
  /**
   * The session's credential-sharing profile. `isolated` is a private
   * session: the toolbar says so, and offers no action, because there is
   * nothing here to save or clear.
   */
  readonly profile: BrowserSessionProfileKind;
  readonly url: string;
  readonly addressValue: string;
  readonly selectAddressOnFocus: boolean;
  /** Callback ref for the address field (a ref OBJECT may not cross render). */
  readonly setAddressInput: (node: HTMLInputElement | null) => void;
  /** Put the caret in the address field - Cmd+L over a focused guest. */
  readonly focusAddress: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  /** The page's own icon, or `null` when it declares none. */
  readonly faviconUrl: string | null;
  /** What this tile's page is currently told about `prefers-color-scheme`. */
  readonly colorSchemePreference: BrowserViewColorSchemePreference;
  /** Whether this tile's page is currently silenced. */
  readonly muted: boolean;
  /** Whether a recording is running right now, so the button can say "stop". */
  readonly isRecording: boolean;
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
  readonly onOpenDevTools: () => void;
  /**
   * Why DevTools cannot be opened on this tile, or `null` when they can.
   *
   * A reason rather than a missing row. DevTools needs a raw, bidirectional CDP
   * channel to a page in THIS process - the frontend drives dozens of domains and
   * streams events back - and a screencast tile's page is running on another
   * machine, reachable only through a curated command set. A row that simply
   * vanished there reads as a bug in the app; naming the reason answers the
   * question the user actually has.
   */
  readonly devtoolsUnavailableReason: string | null;
  /**
   * Reload with the HTTP cache bypassed. Separate from {@link onReload} for the
   * same reason main keeps two port methods: a developer watching a rebuilt
   * asset needs the request to leave the machine.
   */
  readonly onHardReload: () => void;
  readonly onColorSchemePreferenceChange: (
    preference: BrowserViewColorSchemePreference,
  ) => void;
  /**
   * Drops this tile's cached responses. Deliberately NOT beside
   * {@link onClearSite} in intent: that one is a sign-out and goes through
   * main's jar machinery, this one only discards copies of public responses.
   */
  readonly onClearCache: () => void;
  readonly onToggleMuted: () => void;
  /**
   * Saves a screenshot. `null` where there is no local guest to capture - a
   * screencast tile's pixels live on another machine.
   */
  readonly onSaveScreenshot: (() => void) | null;
  /** Starts or stops recording. `null` where there is no local guest. */
  readonly onToggleRecording: (() => void) | null;
  /**
   * Opens the always-on-top window on this page, or closes the one already up.
   * Main owns the toggle, so the row never has to track whether one exists.
   */
  readonly onTogglePreviewWindow: () => void;
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
  devtools: true,
  find: true,
  siteInfo: true,
  annotate: true,
  screenshot: true,
  recording: true,
  previewWindow: true,
  hardReload: true,
  appearance: true,
  clearCache: true,
  audio: true,
};
