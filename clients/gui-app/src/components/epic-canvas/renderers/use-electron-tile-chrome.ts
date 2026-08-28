import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  TileChromeCapabilities,
  TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { normalizeBrowserAddressInput } from "@/lib/browser-view/link-routing/browser-link-routing-core";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import { useAddressDraft } from "@/components/epic-canvas/renderers/use-address-draft";
import type {
  BrowserCookieCryptoState,
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
  BrowserViewElectronTabControlAction,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

interface UseElectronTabChromeArgs {
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly surfaceServices: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
  readonly initialUrl: string;
  readonly capabilities: TileChromeCapabilities;
  readonly annotation: BrowserAnnotationSessionController | null;
  readonly cookieCryptoState: BrowserCookieCryptoState | null;
  readonly statusUrl: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  readonly persistViewportPreset: (preset: BrowserViewViewportPresetId) => void;
  readonly initialViewportPreset: BrowserViewViewportPresetId;
  readonly onAttemptedUrl: (url: string) => void;
}

interface ElectronTabChrome {
  readonly controller: TileController;
  readonly navigateToUrl: (url: string) => void;
  readonly downloads: readonly BrowserViewDownloadChange[];
  readonly certificateError: BrowserViewCertificateErrorChange | null;
  readonly certificateProceeding: boolean;
  readonly cancelDownload: (downloadId: string) => void;
  readonly proceedCertificate: () => void;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

/**
 * Builds chrome for one host-owned Electron tab. Navigation and page controls
 * use the durable tab identity; the tile key is reserved for services that
 * exist only while this particular surface is mounted.
 */
export function useElectronTabChrome(
  args: UseElectronTabChromeArgs,
): ElectronTabChrome {
  const {
    control,
    surfaceServices,
    tileKey,
    initialUrl,
    capabilities,
    annotation,
    cookieCryptoState,
    statusUrl,
    canGoBack,
    canGoForward,
    zoomPercent,
    persistViewportPreset,
    initialViewportPreset,
    onAttemptedUrl,
  } = args;
  const [viewportPreset, setViewportPreset] =
    useState<BrowserViewViewportPresetId>(initialViewportPreset);
  const [downloads, setDownloads] = useState<
    readonly BrowserViewDownloadChange[]
  >([]);
  const [certificateError, setCertificateError] =
    useState<BrowserViewCertificateErrorChange | null>(null);
  const [certificateProceeding, setCertificateProceeding] = useState(false);

  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  const draft = useAddressDraft(liveUrl);
  const addressValue = draft.addressValue;

  useEffect(() => {
    if (surfaceServices === null) return;
    const subscription = surfaceServices.onDownloadChange((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      setDownloads((current) => upsertDownload(current, change));
    });
    return () => {
      subscription.dispose();
    };
  }, [surfaceServices, tileKey]);

  useEffect(() => {
    if (surfaceServices === null) return;
    const subscription = surfaceServices.onCertificateError((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      setCertificateProceeding(false);
      setCertificateError(change);
    });
    return () => {
      subscription.dispose();
    };
  }, [surfaceServices, tileKey]);

  const navigateToUrl = (nextUrl: string): void => {
    draft.onAddressSubmitted(nextUrl);
    if (nextUrl === liveUrl) return;
    onAttemptedUrl(nextUrl);
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "navigate", url: nextUrl }).catch(ignoreError);
  };

  const navigateToAddress = (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): void => {
    event.preventDefault();
    navigateToUrl(normalizeBrowserAddressInput(addressValue));
  };

  const reload = (): void => {
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "reload" }).catch(ignoreError);
  };

  const goBack = (): void => {
    if (!canGoBack) return;
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "goBack" }).catch(ignoreError);
  };

  const goForward = (): void => {
    if (!canGoForward) return;
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "goForward" }).catch(ignoreError);
  };

  const applyViewportPreset = (preset: BrowserViewViewportPresetId): void => {
    setViewportPreset(preset);
    persistViewportPreset(preset);
    void control({ kind: "setViewportPreset", viewportPreset: preset }).catch(
      ignoreError,
    );
  };

  const cancelDownload = (downloadId: string): void => {
    if (surfaceServices === null) return;
    void surfaceServices.cancelDownload({ downloadId }).catch(ignoreError);
  };

  const proceedCertificate = (): void => {
    if (certificateError === null) return;
    if (surfaceServices === null) return;
    setCertificateProceeding(true);
    void surfaceServices
      .trustCertificate({
        ...tileKey,
        certificateErrorId: certificateError.certificateErrorId,
      })
      .then(() => {
        setCertificateError(null);
        setCertificateProceeding(false);
      })
      .catch((error: unknown) => {
        setCertificateProceeding(false);
        ignoreError(error);
      });
  };

  const controller: TileController = {
    capabilities,
    url: liveUrl,
    addressValue,
    canGoBack,
    canGoForward,
    zoomPercent,
    viewportPreset,
    disabled: false,
    cookieCryptoState,
    zoomLocked: annotation?.zoomLocked === true,
    annotation,
    onNavigate: navigateToAddress,
    onAddressChange: draft.onAddressChange,
    onAddressFocusChange: draft.onAddressFocusChange,
    onBack: goBack,
    onForward: goForward,
    onReload: reload,
    onZoomOut: () => {
      void control({ kind: "zoomOut" }).catch(ignoreError);
    },
    onZoomIn: () => {
      void control({ kind: "zoomIn" }).catch(ignoreError);
    },
    onResetZoom: () => {
      void control({ kind: "resetZoom" }).catch(ignoreError);
    },
    onViewportPresetChange: applyViewportPreset,
    onOpenDevTools: () => {
      void control({ kind: "openDevTools" }).catch(ignoreError);
    },
  };

  return {
    controller,
    navigateToUrl,
    downloads,
    certificateError,
    certificateProceeding,
    cancelDownload,
    proceedCertificate,
    viewportPreset,
  };
}

function upsertDownload(
  current: readonly BrowserViewDownloadChange[],
  change: BrowserViewDownloadChange,
): readonly BrowserViewDownloadChange[] {
  const existingIndex = current.findIndex(
    (download) => download.downloadId === change.downloadId,
  );
  if (existingIndex < 0) {
    return [...current, change].slice(-5);
  }
  return current
    .map((download, index) => (index === existingIndex ? change : download))
    .slice(-5);
}
