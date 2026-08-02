import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import { ProgressToastIcon } from "@/components/ui/progress-toast-icon";

const PROGRESS_SUCCESS_TOAST_DURATION_MS = 4000;

/**
 * Sonner's loading variant intentionally omits its close button. Render
 * progress through the regular toast variant instead so every persistent
 * progress surface stays dismissible while retaining the shared spinner.
 */
export function progressToast(
  message: ReactNode,
  options: ExternalToast,
): string | number {
  return toast.message(message, {
    ...options,
    closeButton: true,
    dismissible: true,
    icon: <ProgressToastIcon />,
  });
}

/**
 * Replaces a persistent progress toast with a transient success. Sonner merges
 * updates that reuse an id, so both fields must be reset explicitly or the
 * success inherits the progress toast's infinite lifetime and animated icon.
 */
export function progressSuccessToast(
  message: ReactNode,
  options: ExternalToast,
): string | number {
  return toast.success(message, {
    duration: PROGRESS_SUCCESS_TOAST_DURATION_MS,
    ...options,
    icon: undefined,
  });
}
