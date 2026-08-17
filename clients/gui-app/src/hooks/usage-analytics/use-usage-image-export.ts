import { useCallback } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsUsageImageExportSource,
} from "@/lib/analytics";
import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { copyImageBlobPromiseToClipboard } from "@/lib/images/copy-image-to-clipboard";
import { captureUsageExportImageBlob } from "@/lib/usage-analytics/usage-export-image";
import { appLogger } from "@/lib/logger";
import { imageMutationKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

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
 * activation, and a `mutationFn` body can run a tick later. The download
 * leg has no such constraint, so it hands over the node and captures inside
 * the mutation.
 */
export type UsageImageExportInput =
  | { readonly action: "copy"; readonly started: Promise<void> }
  | { readonly action: "download"; readonly node: HTMLElement };

/**
 * The saved file name on a completed download, `null` on a copy (nothing is
 * named) and on a download the user cancelled out of the save picker.
 * Callers discriminate on the VARIABLES, never on this - both no-name cases
 * are the same `null`.
 */
export type UsageImageExportMutation = UseMutationResult<
  string | null,
  Error,
  UsageImageExportInput
>;

export interface UseUsageImageExportResult {
  readonly mutation: UsageImageExportMutation;
  readonly copyImage: () => void;
  readonly downloadImage: () => void;
}

/**
 * "Copy image" / "Download image" for a usage dialog: rasterise the
 * dialog's summary region (headline, tiles, trend chart) to a PNG, then
 * hand it to the clipboard or the save-to-disk path. Both legs reuse the
 * app-wide runtime-aware plumbing - `copyImageBlobPromiseToClipboard` falls
 * back to the desktop nativeImage bridge, `saveBlobToDisk` to the native save
 * dialog - so this hook only owns capture + toasts.
 *
 * ONE mutation carries both legs, discriminated by its variables: a capture
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

  const mutation = useMutation<string | null, Error, UsageImageExportInput>({
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
      return saveBlobToDisk(blob, fileName);
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
      // `null` is the user cancelling the picker - a no-op, not a success.
      if (saved !== null) {
        Analytics.getInstance().track(AnalyticsEvent.UsageImageExported, {
          action: "download",
          source: analyticsSource,
        });
        toast.success(`Saved ${saved}`);
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
  const copyImage = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutate({
      action: "copy",
      started: copyImageBlobPromiseToClipboard(
        captureUsageExportImageBlob({ region: node, heading, subheading }),
      ),
    });
  }, [getExportNode, heading, subheading, mutate]);

  const downloadImage = useCallback(() => {
    const node = getExportNode();
    if (node === null) return;
    mutate({ action: "download", node });
  }, [getExportNode, mutate]);

  return { mutation, copyImage, downloadImage };
}
