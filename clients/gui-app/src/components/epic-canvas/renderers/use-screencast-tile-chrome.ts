import { useState, type SyntheticEvent } from "react";
import type {
  BrowserNavState,
  BrowserScreencastUnsupportedFeature,
} from "@traycer/protocol/host/browser/contracts";
import type {
  TileChromeCapabilities,
  TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import { normalizeBrowserAddressInput } from "@/lib/browser-view/link-routing/browser-link-routing-core";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import { toast } from "sonner";

export const EMPTY_SCREENCAST_NAV_STATE: BrowserNavState = {
  url: "",
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

const SCREENCAST_TILE_CHROME_CAPABILITIES: TileChromeCapabilities = {
  navigate: true,
  back: true,
  forward: true,
  reload: true,
  zoom: false,
  viewportPreset: false,
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
};

const SCREENCAST_UNSUPPORTED_INTERACTION_TOASTS = {
  fileUpload: "File upload not supported",
  download: "Download saved on the host",
} as const;

const UNUSED_VIEWPORT_PRESET: BrowserViewViewportPresetId = "responsive";

interface AddressDraft {
  readonly focused: boolean;
  readonly submitted: boolean;
  readonly value: string;
}

const EMPTY_DRAFT: AddressDraft = {
  focused: false,
  submitted: false,
  value: "",
};

interface UseScreencastTileChromeArgs {
  readonly navState: BrowserNavState;
  readonly initialUrl: string;
  readonly disabled: boolean;
  readonly onNavigateUrl: (url: string) => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
}

export interface ScreencastTileChrome {
  readonly controller: TileController;
  readonly onAddressFocusChange: (focused: boolean) => void;
}

export function toastScreencastUnsupportedInteraction(
  feature: BrowserScreencastUnsupportedFeature,
): void {
  toast(SCREENCAST_UNSUPPORTED_INTERACTION_TOASTS[feature]);
}

/**
 * Shared-toolbar controller for a headless screencast tile. Capabilities
 * are nav-only; the address draft stays owned by focus, so an in-flight
 * agent navigation cannot clobber a URL the user is still editing.
 * A submitted draft yields to the next navState so redirects land.
 */
export function useScreencastTileChrome(
  args: UseScreencastTileChromeArgs,
): ScreencastTileChrome {
  const {
    navState,
    initialUrl,
    disabled,
    onNavigateUrl,
    onBack,
    onForward,
    onReload,
  } = args;
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_DRAFT);
  const liveUrl = navState.url.length > 0 ? navState.url : initialUrl;
  const [seenNavState, setSeenNavState] = useState(navState);
  if (seenNavState !== navState) {
    setSeenNavState(navState);
    if (draft.submitted) {
      setDraft(EMPTY_DRAFT);
    }
  }
  const addressValue = draft.focused || draft.submitted ? draft.value : liveUrl;

  const onAddressFocusChange = (focused: boolean): void => {
    setDraft((current) => {
      if (focused) {
        if (current.focused) return current;
        return { focused: true, submitted: false, value: liveUrl };
      }
      return EMPTY_DRAFT;
    });
  };

  const controller: TileController = {
    capabilities: SCREENCAST_TILE_CHROME_CAPABILITIES,
    url: liveUrl,
    addressValue,
    canGoBack: navState.canGoBack,
    canGoForward: navState.canGoForward,
    zoomPercent: 100,
    viewportPreset: UNUSED_VIEWPORT_PRESET,
    disabled,
    cookieCryptoState: null,
    zoomLocked: false,
    annotation: null,
    onNavigate: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
      event.preventDefault();
      const url = normalizeBrowserAddressInput(addressValue);
      setDraft({ focused: true, submitted: true, value: url });
      onNavigateUrl(url);
    },
    onAddressChange: (value) => {
      setDraft({ focused: true, submitted: false, value });
    },
    onBack: () => {
      if (!navState.canGoBack) return;
      onBack();
    },
    onForward: () => {
      if (!navState.canGoForward) return;
      onForward();
    },
    onReload,
    onZoomOut: ignoreChromeAction,
    onZoomIn: ignoreChromeAction,
    onResetZoom: ignoreChromeAction,
    onViewportPresetChange: ignoreViewportPreset,
    onOpenDevTools: ignoreChromeAction,
  };

  return {
    controller,
    onAddressFocusChange,
  };
}

function ignoreChromeAction(): void {}

function ignoreViewportPreset(_preset: BrowserViewViewportPresetId): void {}
