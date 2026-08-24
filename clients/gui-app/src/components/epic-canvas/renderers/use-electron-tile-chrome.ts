import { useEffect, useState, type SyntheticEvent } from "react";
import type { TileChromeCapabilities, TileController } from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { normalizeBrowserAddressInput } from "@/lib/browser-view/browser-link-routing-core";
import type {
  BrowserCookieCryptoState,
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
  BrowserViewElectronTabControlAction,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
  DesktopBrowserViewBridge,
} from "@/lib/browser-view/desktop-browser-view";

interface AddressDraft {
  readonly sourceUrl: string | null;
  readonly value: string;
}

interface UseElectronTabChromeArgs {
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly surfaceServices: DesktopBrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
  readonly initialUrl: string;
  readonly capabilities: TileChromeCapabilities;
  readonly annotation: BrowserAnnotationSessionController | null;
  readonly cookieCryptoState: BrowserCookieCryptoState | null;
  readonly statusUrl: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  readonly persistViewportPreset: (
    preset: BrowserViewViewportPresetId,
  ) => void;
  readonly initialViewportPreset: BrowserViewViewportPresetId;
  readonly onAttemptedUrl: (url: string) => void;
}

export interface ElectronTabChrome {
  readonly controller: TileController;
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
  const [addressDraft, setAddressDraft] = useState<AddressDraft>({
    sourceUrl: null,
    value: "",
  });
  const [viewportPreset, setViewportPreset] =
    useState<BrowserViewViewportPresetId>(initialViewportPreset);
  const [downloads, setDownloads] = useState<
    readonly BrowserViewDownloadChange[]
  >([]);
  const [certificateError, setCertificateError] =
    useState<BrowserViewCertificateErrorChange | null>(null);
  const [certificateProceeding, setCertificateProceeding] = useState(false);

  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  const addressValue =
    addressDraft.sourceUrl === liveUrl ? addressDraft.value : liveUrl;

  useEffect(() => {
    if (surfaceServices === null) return;
    const subscription = surfaceServices.onDownloadChange((change) => {
      if (!isChangeForTile(change, tileKey)) return;
      setDownloads((current) => upsertDownload(current, change));
    });
    return () => {
      subscription.dispose();
    };
  }, [surfaceServices, tileKey]);

  useEffect(() => {
    if (surfaceServices === null) return;
    const subscription = surfaceServices.onCertificateError((change) => {
      if (!isChangeForTile(change, tileKey)) return;
      setCertificateProceeding(false);
      setCertificateError(change);
    });
    return () => {
      subscription.dispose();
    };
  }, [surfaceServices, tileKey]);

  const navigateToAddress = (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): void => {
    event.preventDefault();
    const nextUrl = normalizeBrowserAddressInput(addressValue);
    setAddressDraft({ sourceUrl: nextUrl, value: nextUrl });
    if (nextUrl === liveUrl) return;
    onAttemptedUrl(nextUrl);
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "navigate", url: nextUrl }).catch(ignoreChromeError);
  };

  const reload = (): void => {
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "reload" }).catch(ignoreChromeError);
  };

  const goBack = (): void => {
    if (!canGoBack) return;
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "goBack" }).catch(ignoreChromeError);
  };

  const goForward = (): void => {
    if (!canGoForward) return;
    setCertificateError(null);
    setCertificateProceeding(false);
    void control({ kind: "goForward" }).catch(ignoreChromeError);
  };

  const applyViewportPreset = (preset: BrowserViewViewportPresetId): void => {
    setViewportPreset(preset);
    persistViewportPreset(preset);
    void control({ kind: "setViewportPreset", viewportPreset: preset }).catch(
      ignoreChromeError,
    );
  };

  const cancelDownload = (downloadId: string): void => {
    if (surfaceServices === null) return;
    void surfaceServices.cancelDownload({ downloadId }).catch(ignoreChromeError);
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
        ignoreChromeError(error);
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
    onAddressChange: (value) => {
      setAddressDraft({ sourceUrl: liveUrl, value });
    },
    onBack: goBack,
    onForward: goForward,
    onReload: reload,
    onZoomOut: () => {
      void control({ kind: "zoomOut" }).catch(ignoreChromeError);
    },
    onZoomIn: () => {
      void control({ kind: "zoomIn" }).catch(ignoreChromeError);
    },
    onResetZoom: () => {
      void control({ kind: "resetZoom" }).catch(ignoreChromeError);
    },
    onViewportPresetChange: applyViewportPreset,
    onOpenDevTools: () => {
      void control({ kind: "openDevTools" }).catch(ignoreChromeError);
    },
  };

  return {
    controller,
    downloads,
    certificateError,
    certificateProceeding,
    cancelDownload,
    proceedCertificate,
    viewportPreset,
  };
}

function isChangeForTile(
  change: BrowserViewTileKey,
  key: BrowserViewTileKey,
): boolean {
  return (
    change.viewTabId === key.viewTabId &&
    change.paneId === key.paneId &&
    change.tileInstanceId === key.tileInstanceId &&
    change.pageSessionId === key.pageSessionId
  );
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

function ignoreChromeError(_error: unknown): void {}
