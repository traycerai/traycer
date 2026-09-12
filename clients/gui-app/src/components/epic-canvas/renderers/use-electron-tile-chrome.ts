import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import type {
  TileChromeCapabilities,
  TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { normalizeBrowserAddressInput } from "@/lib/browser-view/browser-tab-display";
import { toast } from "sonner";
import {
  createBrowserRecordingEncoder,
  type BrowserRecordingEncoder,
} from "@/lib/browser-view/recording/browser-recording-encoder";
import { DEFAULT_BROWSER_ZOOM_FACTOR } from "@/lib/browser-view/browser-tile-defaults";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import { useAddressDraft } from "@/components/epic-canvas/renderers/use-address-draft";
import type { BrowserSessionProfileKind } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewCertificateErrorChange,
  BrowserViewColorSchemePreference,
  BrowserViewDownloadChange,
  BrowserViewElectronTabControlAction,
  BrowserViewSaveCaptureResult,
  BrowserViewRecordingStopReason,
  BrowserViewTileKey,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

interface UseElectronTabChromeArgs {
  readonly profile: BrowserSessionProfileKind;
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly surfaceServices: BrowserViewBridge | null;
  /**
   * Identifies the native guest currently behind this tile, or `null` where
   * there is none.
   *
   * Distinct from `tileKey.pageSessionId`, which identifies the TAB: one tab
   * keeps its page session across a guest that crashes and is re-born, or is
   * moved to another window. Zoom is a property of the guest, so restoring it
   * has to follow the guest.
   */
  readonly registrationId: string | null;
  readonly tileKey: BrowserViewTileKey;
  readonly initialUrl: string;
  readonly capabilities: TileChromeCapabilities;
  readonly annotation: BrowserAnnotationSessionController | null;
  readonly statusUrl: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
  /**
   * How many zoom reports main has sent for this tile.
   *
   * A COUNT rather than a flag because the question the persist gate has to
   * answer is not "has main ever spoken" but "has main spoken since this guest
   * was restored" - and a report can repeat a value, so only a count can tell a
   * fresh report from no report.
   */
  readonly zoomReports: number;
  readonly faviconUrl: string | null;
  readonly persistZoomFactor: (factor: number) => void;
  readonly initialZoomFactor: number;
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
    registrationId,
    tileKey,
    initialUrl,
    capabilities,
    annotation,
    statusUrl,
    canGoBack,
    canGoForward,
    zoomPercent,
    zoomReports,
    faviconUrl,
    persistZoomFactor,
    initialZoomFactor,
    onAttemptedUrl,
  } = args;
  const [downloads, setDownloads] = useState<
    readonly BrowserViewDownloadChange[]
  >([]);
  const [certificateError, setCertificateError] =
    useState<BrowserViewCertificateErrorChange | null>(null);
  const [certificateProceeding, setCertificateProceeding] = useState(false);
  const [colorSchemePreference, setColorSchemePreference] =
    useState<BrowserViewColorSchemePreference>("system");
  const [muted, setMuted] = useState(false);

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

  /**
   * Restates this tile's emulation intent on a guest that did not receive it.
   *
   * The colour scheme and the mute flag live in this chrome, which outlives the
   * guest: a crash or a cross-window move produces a fresh webContents with the
   * system scheme and its audio on, while the toolbar goes on showing Dark and a
   * crossed-out speaker. Nothing in the status frame carries either value, so
   * neither would ever be corrected - the UI would simply be wrong about the page
   * until the user toggled it twice.
   *
   * Only non-default values are sent. A new guest already IS system-scheme and
   * unmuted, so restating those would be an IPC round trip to change nothing.
   */
  const restatedRegistrationRef = useRef<string | null>(null);
  useEffect(() => {
    if (registrationId === null) return;
    if (restatedRegistrationRef.current === registrationId) return;
    restatedRegistrationRef.current = registrationId;
    if (colorSchemePreference !== "system") {
      void control({
        kind: "setColorSchemePreference",
        preference: colorSchemePreference,
      }).catch(ignoreError);
    }
    if (muted) {
      void control({ kind: "setAudioMuted", muted: true }).catch(ignoreError);
    }
  }, [control, registrationId, colorSchemePreference, muted]);

  /**
   * Applies the remembered zoom to the guest, once.
   *
   * Keyed on the tab identity rather than run on mount: the chrome outlives a
   * guest that is replaced (a crash, a cross-window move), and re-applying on
   * every render would fight a user who is stepping zoom right now.
   */
  const zoomedRegistrationRef = useRef<string | null>(null);
  /**
   * The report count at the moment this guest's zoom was restored, or `null`
   * while no guest has been restored.
   *
   * The persist gate needs this because a replaced guest REPORTS before it is
   * restored: a fresh webContents is at Chromium's default, says so, and only
   * then receives the remembered factor. A gate that merely knew main had spoken
   * would take that default as the tile's value and write it over the very zoom
   * about to be re-applied - the same lost update the mount case had, one guest
   * later.
   */
  const restoredAtReportRef = useRef<number | null>(null);
  /**
   * The latest report count, readable from an async continuation.
   *
   * Synced in an effect rather than during render - a ref written while
   * rendering is not a ref anyone can reason about under Strict Mode - and
   * declared BEFORE the restore effect so it is already current when that one
   * runs.
   */
  const zoomReportsRef = useRef(zoomReports);
  useEffect(() => {
    zoomReportsRef.current = zoomReports;
  }, [zoomReports]);
  useEffect(() => {
    if (registrationId === null) return;
    // The guard, not the dependency list, is what makes this once-per-guest:
    // `control` is re-created every render, so a list that omitted it would be
    // lying about what this effect reads.
    //
    // Keyed on the REGISTRATION rather than the page session, which is the
    // identity that actually changes when the guest does: a crashed or moved
    // guest is a fresh webContents at Chromium's default zoom while the tab -
    // and so its page session - is the same one, and a guard on the page session
    // read as "already restored" and left the new guest unzoomed.
    if (zoomedRegistrationRef.current === registrationId) return;
    zoomedRegistrationRef.current = registrationId;
    // Captured so the completion below can tell whether it is still the current
    // guest's. A request for the PREVIOUS guest can settle after a replacement
    // has begun restoring, and its completion would otherwise open the gate for a
    // guest it never spoke to - which then persists that guest's default over the
    // remembered zoom.
    const restoringRegistration = registrationId;
    // Closed for this guest until it has been restored.
    restoredAtReportRef.current = null;
    if (initialZoomFactor === DEFAULT_BROWSER_ZOOM_FACTOR) {
      // Nothing to re-apply, so nothing to wait for: whatever the guest reports
      // IS the tile's zoom.
      restoredAtReportRef.current = zoomReportsRef.current;
      return;
    }
    void control({
      kind: "setZoomFactor",
      factor: initialZoomFactor,
    })
      // Opened on either outcome. A restore that FAILED still leaves the guest
      // at a real zoom the user can then change, and refusing to persist ever
      // again would be a worse answer than persisting what the guest actually
      // has.
      .catch(ignoreError)
      .finally(() => {
        if (zoomedRegistrationRef.current !== restoringRegistration) return;
        restoredAtReportRef.current = zoomReportsRef.current;
      });
  }, [control, initialZoomFactor, registrationId]);

  /**
   * Records what main reports, not what the chrome asked for: a zoom step is
   * applied by Chromium and reported back, and the reported value is the one a
   * reopened tile should restore.
   */
  useEffect(() => {
    if (zoomPercent <= 0) return;
    // Only a report that came AFTER this guest was restored. `zoomPercent` is
    // seeded at 100 and a replaced guest genuinely reports its default before the
    // remembered factor reaches it, so both are values that must not be written
    // back - and neither is distinguishable from a real 100% by value alone.
    const restoredAt = restoredAtReportRef.current;
    if (restoredAt === null || zoomReports <= restoredAt) return;
    persistZoomFactor(zoomPercent / 100);
  }, [zoomPercent, zoomReports, persistZoomFactor]);

  const [isRecording, setIsRecording] = useState(false);
  /**
   * The encoder for the recording in progress. A ref, not state: frames arrive
   * many times a second and each one would otherwise re-render the whole tile.
   */
  const encoderRef = useRef<BrowserRecordingEncoder | null>(null);

  /**
   * Finishes the file for a recording main has ended.
   *
   * Stable across renders so the subscription effect below can depend on it
   * honestly: everything it touches is a ref or a state setter, both of which
   * React guarantees are stable.
   */
  const finishRecording = useCallback(
    async (reason: BrowserViewRecordingStopReason): Promise<void> => {
      const encoder = encoderRef.current;
      encoderRef.current = null;
      setIsRecording(false);
      if (encoder === null) return;
      const video = await encoder.finish();
      if (video === null) {
        toast.error("Recording produced no frames");
        return;
      }
      saveRecordingFile(video);
      toast.success(recordingToastTitle(reason), {
        description: recordingToastDescription(reason),
      });
    },
    [],
  );

  /**
   * Streams frames from main into the encoder for as long as one is running.
   *
   * Subscribed for the tile's life rather than started with the recording: main
   * decides when a recording ends (its own duration and frame bounds, or a page
   * that went away), and a subscription that only existed while the renderer
   * thought it was recording would miss the frame that arrived alongside that
   * decision.
   */
  useEffect(() => {
    if (surfaceServices === null) return;
    const frames = surfaceServices.onRecordingFrame((frame) => {
      if (!isSameBrowserViewTile(frame, tileKey)) return;
      void encoderRef.current?.addFrame(frame.jpegBase64);
    });
    const stopped = surfaceServices.onRecordingStopped((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      void finishRecording(change.reason);
    });
    return () => {
      frames.dispose();
      stopped.dispose();
      // The listeners are gone, so the `stopped` event that would have finished
      // the file can no longer arrive - main may still be recording, and its
      // stop lands on nobody. Cancelling here releases the encoder's canvas and
      // MediaRecorder instead of leaving them held by a closure with no way to
      // be completed.
      const encoder = encoderRef.current;
      encoderRef.current = null;
      encoder?.cancel();
    };
  }, [finishRecording, surfaceServices, tileKey]);

  const toggleRecording = async (): Promise<void> => {
    if (surfaceServices === null) return;
    if (encoderRef.current !== null) {
      // Main owns the stop so the bounds and the button agree on one authority;
      // the `stopped` event is what finishes the file.
      await surfaceServices.stopRecording(tileKey).catch(ignoreError);
      return;
    }
    const encoder = createBrowserRecordingEncoder();
    if (encoder === null) {
      toast.error("This build cannot record video");
      return;
    }
    encoderRef.current = encoder;
    setIsRecording(true);
    const started = await surfaceServices
      .startRecording(tileKey)
      .catch(() => false);
    if (!started) {
      encoder.cancel();
      encoderRef.current = null;
      setIsRecording(false);
      toast.error("Could not start recording this page");
    }
  };

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
    faviconUrl,
    colorSchemePreference,
    muted,
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
    // A local guest is exactly what DevTools needs, so there is no reason here.
    devtoolsUnavailableReason: null,
    onOpenDevTools: () => {
      void control({ kind: "openDevTools" }).catch(ignoreError);
    },
    onHardReload: () => {
      setCertificateError(null);
      setCertificateProceeding(false);
      void control({ kind: "hardReload" }).catch(ignoreError);
    },
    onColorSchemePreferenceChange: (preference) => {
      // Optimistic: the emulation is a projection onto the guest, so the menu's
      // radio must follow the click rather than a round trip. A refused command
      // leaves the page on its previous scheme, which the next navigation
      // restates from this same intent.
      setColorSchemePreference(preference);
      void control({ kind: "setColorSchemePreference", preference }).catch(
        ignoreError,
      );
    },
    onClearCache: () => {
      void control({ kind: "clearCache" }).catch(ignoreError);
    },
    onSaveScreenshot:
      surfaceServices === null
        ? null
        : () => {
            void saveTileScreenshot(surfaceServices, tileKey);
          },
    isRecording,
    onToggleRecording:
      surfaceServices === null
        ? null
        : () => {
            void toggleRecording();
          },
    onTogglePreviewWindow: () => {
      void control({ kind: "togglePreviewWindow" }).catch(ignoreError);
    },
    onToggleMuted: () => {
      const next = !muted;
      setMuted(next);
      void control({ kind: "setAudioMuted", muted: next }).catch(ignoreError);
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
    downloads,
    certificateError,
    certificateProceeding,
    cancelDownload,
    proceedCertificate,
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

/**
 * Saves a screenshot of one tile and offers what a saved file is actually for:
 * finding it, and pasting it somewhere.
 *
 * The two affordances are deliberately different shapes. Reveal quotes the path
 * main just minted, so main can check it belongs to the directory it owns.
 * Copy re-reads the bytes through `capturePage` rather than the file, because
 * the renderer never gains filesystem read access - it has the image already or
 * it asks for it again.
 */
async function saveTileScreenshot(
  services: BrowserViewBridge,
  tileKey: BrowserViewTileKey,
): Promise<void> {
  let saved: BrowserViewSaveCaptureResult;
  try {
    saved = await services.saveCapture(tileKey);
  } catch {
    toast.error("Could not save a screenshot of this page");
    return;
  }
  toast.success("Screenshot saved", {
    description: fileNameOf(saved.path),
    action: {
      label: "Show in folder",
      onClick: () => {
        void services.revealCapture(saved.path).catch(ignoreError);
      },
    },
  });
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}

/**
 * Hands the encoded video to the browser's own download path.
 *
 * Not written through main like a screenshot is: a recording is produced IN the
 * renderer, so routing its bytes back through IPC to be written and then revealed
 * would move megabytes across a process boundary for no gain. An anchor download
 * puts it wherever the user's downloads go, which is where they will look.
 */
function saveRecordingFile(video: Blob): void {
  const url = URL.createObjectURL(video);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `page-recording-${String(Date.now())}.webm`;
  anchor.click();
  // Revoked on the next task rather than immediately: the click starts the save
  // asynchronously, and revoking in the same tick can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function recordingToastTitle(reason: BrowserViewRecordingStopReason): string {
  return reason === "requested" ? "Recording saved" : "Recording ended";
}

/**
 * Why a recording ended, when the user did not end it. A limit reached silently
 * would read as the app losing the recording.
 */
function recordingToastDescription(
  reason: BrowserViewRecordingStopReason,
): string | undefined {
  switch (reason) {
    case "requested":
      return undefined;
    case "duration-limit":
      return "Reached the maximum recording length.";
    case "frame-limit":
      return "Reached the maximum number of frames.";
    case "page-gone":
      return "The page closed while recording.";
  }
}
