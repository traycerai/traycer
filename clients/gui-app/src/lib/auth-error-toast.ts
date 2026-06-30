import { toast } from "sonner";
import { readErrorMessage } from "@/lib/read-error-message";

export function toastFromAuthError(error: unknown, fallback: string): void {
  const message = readErrorMessage(error);
  if (message !== null) {
    toast.error(fallback, { description: message });
    return;
  }
  toast.error(fallback);
}
