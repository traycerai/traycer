import { useEffect, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import type {
  TileChromeCapabilities,
  TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { normalizeBrowserAddressInput } from "@/lib/browser-view/browser-tab-display";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import { useAddressDraft } from "@/components/epic-canvas/renderers/use-address-draft";
import { formatByteSize } from "@/lib/format-byte-size";
import {
  progressSuccessToast,
  progressToast,
} from "@/lib/toast/progress-toast";
import type { BrowserSessionProfileKind } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
  BrowserViewElectronTabControlAction,
  BrowserViewTileKey,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

interface UseElectronTabChromeArgs {
  readonly profile: BrowserSessionProfileKind;
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly surfaceServices: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
  readonly initialUrl: string;
  readonly capabilities: TileChromeCapabilities;
  readonly annotation: BrowserAnnotationSessionController | null;
  readonly statusUrl: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  readonly onAttemptedUrl: (url: string) => void;
}

interface ElectronTabChrome {
  readonly controller: TileController;
  readonly navigateToUrl: (url: string) => void;
  readonly certificateError: BrowserViewCertificateErrorChange | null;
  readonly certificateProceeding: boolean;
  readonly proceedCertificate: () => void;
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
    profile,
    control,
    surfaceServices,
    tileKey,
    initialUrl,
    capabilities,
    annotation,
    statusUrl,
    canGoBack,
    canGoForward,
    zoomPercent,
    onAttemptedUrl,
  } = args;
  const [certificateError, setCertificateError] =
    useState<BrowserViewCertificateErrorChange | null>(null);
  const [certificateProceeding, setCertificateProceeding] = useState(false);

  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  const draft = useAddressDraft(liveUrl);
  const addressValue = draft.addressValue;

  useEffect(() => {
    if (surfaceServices === null) return;
    // Keep only unfinished downloads: false means the user closed the toast.
    const progressToasts = new Map<string, boolean>();
    const subscription = surfaceServices.onDownloadChange((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      const id = `browser-download:${change.downloadId}`;
      const dismissed = progressToasts.get(id) === false;
      // An "updated" interruption is still active; only the final event
      // clears canCancel. Do not expire an unfinished transfer.
      if (!change.canCancel) {
        progressToasts.delete(id);
        if (dismissed) return;
        const options = {
          id,
          description: downloadLabel(change),
          duration: 4000,
          icon: undefined,
          action: null,
          onDismiss: undefined,
        };
        if (change.state === "completed") {
          progressSuccessToast(change.filename, options);
        } else if (change.state === "interrupted") {
          toast.warning(change.filename, options);
        } else {
          toast.message(change.filename, options);
        }
        return;
      }
      if (dismissed) return;
      progressToasts.set(id, true);
      progressToast(change.filename, {
        id,
        description: downloadLabel(change),
        duration: Infinity,
        action: {
          label: "Cancel",
          onClick: (event) => {
            event.preventDefault();
            void surfaceServices
              .cancelDownload({ downloadId: change.downloadId })
              .catch(ignoreError);
          },
        },
        onDismiss: () => {
          if (progressToasts.has(id)) progressToasts.set(id, false);
        },
      });
    });
    return () => {
      subscription.dispose();
      // The app toaster outlives this surface; its persistent progress must not.
      for (const [id, visible] of progressToasts) {
        if (visible) toast.dismiss(id);
      }
      progressToasts.clear();
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
    viewport: null,
    capabilities,
    profile,
    url: liveUrl,
    addressValue,
    selectAddressOnFocus: false,
    setAddressInput: draft.setAddressInput,
    focusAddress: draft.focusAddress,
    canGoBack,
    canGoForward,
    zoomPercent,
    disabled: false,
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
    onOpenDevTools: () => {
      void control({ kind: "openDevTools" }).catch(ignoreError);
    },
    // The tile key is all that crosses: main derives the site from this tile's
    // current URL, so a renderer cannot name a site it is not looking at.
    onClearSite:
      surfaceServices === null
        ? null
        : () => {
            void surfaceServices.clearSite(tileKey).catch(ignoreError);
          },
  };

  return {
    controller,
    navigateToUrl,
    certificateError,
    certificateProceeding,
    proceedCertificate,
  };
}

function downloadLabel(download: BrowserViewDownloadChange): string {
  if (download.state === "prompting") return "Waiting for save location";
  if (download.state === "completed") return "Download complete";
  if (download.state === "cancelled") return "Download cancelled";
  if (download.state === "interrupted") return "Download interrupted";
  const received = formatByteSize(download.receivedBytes);
  const sizeLabel =
    download.totalBytes > 0
      ? `${received} of ${formatByteSize(download.totalBytes)}`
      : received;
  return download.dangerType === null
    ? sizeLabel
    : `${sizeLabel} · ${download.dangerType} confirmed`;
}
