import { useCallback } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsUsageImageExportSource,
} from "@/lib/analytics";
import {
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";
import { useOpenSavedFile } from "@/hooks/files/use-open-saved-file";
import { copyImageBlobPromiseToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { captureUsageExportImageBlob } from "@/lib/usage-analytics/usage-export-image";
import { appLogger } from "@/lib/logger";
import { imageMutationKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useFileSaveHost } from "@/hooks/files/use-file-save-host";

export interface UseUsageImageExportParams {
  /**
   * Resolves the region to rasterise at click time - `null` while no
   * loaded body is mounted (callers also disable the buttons then, so a
   * `null` here is a race, not a state).
   */
  readonly getExportNode: () => HTMLElement | null;
  readonly fileName: string;
  /** Heading drawn above the captured region ("Usage"). */
  readonly heading: string;
  /** Muted line beside the heading (scope or date range) - `null` for none. */
  readonly subheading: string | null;
  /** Names the surface in error-report drafts. */
  readonly errorSource: string;
  /** Names the surface in the `usage_image_exported` event - a bounded
   * analytics taxonomy, distinct from the display-copy `errorSource`. */
  readonly analyticsSource: AnalyticsUsageImageExportSource;
}

/**
 * Which export a run is, and everything that leg needs.
 *
 * The copy leg carries an ALREADY RUNNING promise rather than the node to
 * capture: the clipboard write has to be issued inside the click's user
 * activation, and a `mutationFn` body can run a tick later. The share and
 * download legs have no such constraint, so they hand over the node and
 * capture inside the mutation.
 */
export type UsageImageExportInput =
  | { readonly action: "copy"; readonly started: Promise<void> }
  | { readonly action: "share"; readonly node: HTMLElement }
  | { readonly action: "download"; readonly node: HTMLElement };

/** Which export control a run belongs to, for the per-button spinner. */
export type UsageImageExportAction = UsageImageExportInput["action"];

/**
 * The saved file on a completed download or share, `null` on a copy (nothing
 * is saved) and on a run the user cancelled out of the save picker or share
 * sheet. Callers discriminate on the VARIABLES, never on this - every no-file
 * case is the same `null`.
 */
export type UsageImageExportMutation = UseMutationResult<
  SavedFile | null,
  Error,
  UsageImageExportInput
>;

export interface UseUsageImageExportResult {
  readonly mutation: UsageImageExportMutation;
  /**
   * Which control's export is in flight, or `null` when none is. Derived here
   * rather than at each surface: one export runs at a time, so this is also
   * "an export is running", and the two facts must not be read differently by
   * two surfaces.
   */
  readonly pendingAction: UsageImageExportAction | null;
  /**
   * `null` where the shell cannot put an image on the system clipboard, in
   * which case the share sheet is where a user copies one (see
   * {@link useUsageImageExport}).
   */
  readonly copyImage: (() => void) | null;
  /** `null` where the shell owns no OS share surface to hand the image to. */
  readonly shareImage: (() => void) | null;
  readonly downloadImage: () => void;
}

/**
 * The export controls for a usage surface: rasterise the surface's summary
 * region (headline, tiles, trend chart) to a PNG, then hand it to the
 * clipboard, the OS share sheet, or the device's file storage. Every leg
 * reuses the app-wide runtime-aware plumbing - `copyImageBlobPromiseToClipboard`
 * falls back to the desktop nativeImage bridge, `saveBlobToDisk` and
 * `downloadBlobToDevice` to whichever routes this shell owns - so this hook
 * only owns capture, which controls exist, and the toasts.
 *
 * WHICH CONTROLS EXIST is decided here, once, off shell capability rather than
 * per surface, so no usage surface can drift into a different set:
 *
 * - A shell with a chooser-free download (`IFileSaveHost.downloadFile`) is one
 *   whose `saveFile` goes through an OS chooser instead - the installed mobile
 *   app, whose sheet hands the file to another app. There, share and download
 *   are genuinely two different acts and both are offered.
 * - Copy is offered everywhere else and NOT there. The installed app's WebView
 *   cannot put an image on the system clipboard: on Android the write resolves
 *   having written nothing, which is worse than no button, since the surface
 *   then reports a success the clipboard never received. The share sheet's own
 *   Copy action is the route that does work, and it is one tap away.
 *
 * ONE mutation carries every leg, discriminated by its variables: a capture
 * is an expensive full-region rasterisation, so two of them must never be in
 * flight at once. A single pending flag is what lets every export button
 * disable while any export runs.
 */
export function useUsageImageExport(
  params: UseUsageImageExportParams,
): UseUsageImageExportResult {
  const {
    getExportNode,
    fileName,
    heading,
    subheading,
    errorSource,
    analyticsSource,
  } = params;

  const fileSave = useFileSaveHost();
  const openSaved = useOpenSavedFile();
  const canShare = hasSeparateDownloadRoute(fileSave);
  const mutation = useMutation<SavedFile | null, Error, UsageImageExportInput>({
    mutationKey: imageMutationKeys.usageExport(),
    mutationFn: async (input) => {
      if (input.action === "copy") {
        // Started by `copyImage` and only *tracked* here, so this mutation
        // owns pending state and toasts for the copy leg and nothing else.
        await input.started;
        return null;
      }
      const blob = await captureUsageExportImageBlob({
        region: input.node,
        heading,
        subheading,
      });
      // `saveBlobToDisk` is the shell's own save route, which on a shell that
      // also owns a direct download is the share sheet - that is exactly what
      // makes it the SHARE leg here rather than a second download.
      if (input.action === "share") {
        return saveBlobToDisk(blob, fileName, fileSave);
      }
      return downloadBlobToDevice(blob, fileName, fileSave);
    },
    onSuccess: (saved, input) => {
      if (input.action === "copy") {
        Analytics.getInstance().track(AnalyticsEvent.UsageImageExported, {
          action: "copy",
          source: analyticsSource,
        });
        toast.success("Usage image copied");
        return;
      }
      // `null` is the user cancelling the picker or the sheet - a no-op, not
      // a success.
      if (saved !== null) {
        Analytics.getInstance().track(AnalyticsEvent.UsageImageExported, {
          action: input.action,
          source: analyticsSource,
        });
        toastSavedFile(saved, openSaved.mutate, fileSave);
      }
    },
    onError: (err, input) => {
      if (input.action === "copy") {
        appLogger.errorSummary("[usage] image copy failed", {}, err);
        reportableErrorToast("Failed to copy usage image", undefined, {
          title: "Could not copy usage image",
          message: null,
          code: null,
          source: errorSource,
        });
        return;
      }
      if (input.action === "share") {
        appLogger.errorSummary("[usage] image share failed", {}, err);
        reportableErrorToast("Failed to share usage image", undefined, {
          title: "Could not share usage image",
          message: null,
          code: null,
          source: errorSource,
        });
        return;
      }
      appLogger.errorSummary("[usage] image download failed", {}, err);
      reportableErrorToast("Failed to download usage image", undefined, {
        title: "Could not download usage image",
        message: null,
        code: null,
        source: errorSource,
      });
    },
  });

  const { mutate } = mutation;
  const startCopy = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutate({
      action: "copy",
      started: copyImageBlobPromiseToClipboard(
        captureUsageExportImageBlob({ region: node, heading, subheading }),
      ),
    });
  }, [getExportNode, heading, subheading, mutate]);

  const startShare = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutate({ action: "share", node });
  }, [getExportNode, mutate]);

  const downloadImage = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutate({ action: "download", node });
  }, [getExportNode, mutate]);

  return {
    mutation,
    pendingAction: mutation.isPending ? mutation.variables.action : null,
    copyImage: canShare ? null : startCopy,
    shareImage: canShare ? startShare : null,
    downloadImage,
  };
}
