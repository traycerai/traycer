import { useCallback } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsUsageImageExportSource,
} from "@/lib/analytics";
import {
  canDownloadToDevice,
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
import { useCanCopyImages } from "@/hooks/images/use-can-copy-images";

export interface UseUsageImageExportParams {
  /** Resolves the region to rasterise at click time - `null` while no loaded body is mounted (callers also disable the buttons then, so a `null` here is a race, not a state). */
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

/** The copy leg carries an ALREADY RUNNING promise rather than the node to capture: the clipboard write has to be issued inside the click's user activation, and a `mutationFn` body can run a tick later. */
export type UsageImageExportInput =
  | { readonly action: "copy"; readonly started: Promise<void> }
  | { readonly action: "share"; readonly node: HTMLElement }
  | { readonly action: "download"; readonly node: HTMLElement };

/** Which export control a run belongs to, for the per-button spinner. */
export type UsageImageExportAction = UsageImageExportInput["action"];

/** Callers discriminate on the VARIABLES, never on this - every no-file case is the same `null`. */
export type UsageImageExportMutation = UseMutationResult<
  SavedFile | null,
  Error,
  UsageImageExportInput
>;

export interface UseUsageImageExportResult {
  readonly mutation: UsageImageExportMutation;
  /** Derived here rather than at each surface: one export runs at a time, so this is also "an export is running", and the two facts must not be read differently by two surfaces. */
  readonly pendingAction: UsageImageExportAction | null;
  /** `null` where the shell cannot put an image on the system clipboard, in which case the share sheet is where a user copies one (see {@link useUsageImageExport}). */
  readonly copyImage: (() => void) | null;
  /** `null` where the shell owns no OS share surface to hand the image to. */
  readonly shareImage: (() => void) | null;
  /** `null` where this device has no download destination at all. */
  readonly downloadImage: (() => void) | null;
}

/** One mutation for every leg so two captures cannot run at once. */
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
  const canCopy = useCanCopyImages();
  const canDownload = canDownloadToDevice(fileSave);
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
        toastSavedFile(
          saved,
          openSaved.mutate,
          fileSave,
          input.action === "share" ? "share" : "save",
        );
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
    copyImage: canCopy ? startCopy : null,
    shareImage: canShare ? startShare : null,
    downloadImage: canDownload ? downloadImage : null,
  };
}
