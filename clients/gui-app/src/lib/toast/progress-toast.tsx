import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import { ProgressToastIcon } from "@/components/ui/progress-toast-icon";

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
