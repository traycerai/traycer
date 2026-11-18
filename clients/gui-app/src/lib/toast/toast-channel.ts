import { toast } from "sonner";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

const TOAST_CHANNEL_REPORT_CONTEXT = createReportIssueContext({
  title: "Traycer operation failed",
  message: null,
  code: null,
  source: "Traycer app",
});

/**
 * A toast "channel" is a single, stable sonner id together with the variant
 * methods that all emit under that id. Because every method forces the same
 * id, firing twice REPLACES the on-screen toast in place instead of stacking a
 * second one - the same behavior the extension relied on, where semantically
 * identical toasts shared one id.
 *
 * Use a channel for any status that supersedes its own prior state:
 *   - connection lost -> reconnected (one toast morphs, never two)
 *   - role upgrade <-> downgrade (latest role wins)
 *   - "epic is gone" notices (repeated signals collapse)
 *
 * Do NOT use a channel for independent, additive events (e.g. "Invited 3
 * people", or an error with its own `description`) - those should keep firing
 * distinct, unkeyed `toast.*` calls so each is its own line. Channels are the
 * opt-in for replacement semantics, and replacement-state toasts are plain
 * one-liners, so the methods take only a message.
 */
export interface ToastChannel {
  readonly id: string;
  message(message: string): string | number;
  success(message: string): string | number;
  info(message: string): string | number;
  warning(message: string): string | number;
  error(message: string): string | number;
  dismiss(): void;
}

function createToastChannel(id: string): ToastChannel {
  return {
    id,
    message: (message) => toast(message, { id, cancel: null }),
    success: (message) => toast.success(message, { id, cancel: null }),
    info: (message) => toast.info(message, { id, cancel: null }),
    warning: (message) => toast.warning(message, { id, cancel: null }),
    error: (message) =>
      reportableErrorToast(message, { id }, TOAST_CHANNEL_REPORT_CONTEXT),
    dismiss: () => {
      toast.dismiss(id);
    },
  };
}

/**
 * Builds a family of entity-scoped channels under a shared prefix. Calling the
 * returned factory with a scope (an epic id, a host id, ...) yields the
 * channel whose id is `${prefix}:${scope}`, so each entity replaces only its
 * own toast while staying distinct from other entities' toasts.
 *
 *   const epicConnectionToast = scopedToastChannel("epic-connection");
 *   epicConnectionToast(epicId).warning("Connection lost.");
 *   epicConnectionToast(epicId).success("Reconnected."); // replaces
 */
export function scopedToastChannel(
  prefix: string,
): (scope: string) => ToastChannel {
  return (scope: string) => createToastChannel(`${prefix}:${scope}`);
}
