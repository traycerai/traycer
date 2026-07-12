import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/**
 * Maps a HostRpcError to the appropriate toast copy mandated by the
 * Core Flows spec. Permission errors get distinct copy from network/RPC
 * errors so the user knows whether to retry or ask for access.
 *
 * Call this in every mutation hook's `onError` callback.
 */
export function toastFromHostError(
  error: HostRpcError,
  fallback: string,
): void {
  const message = hostErrorToastMessage(error, fallback);
  reportableErrorToast(
    message,
    undefined,
    createReportIssueContext({
      title: "Host operation failed",
      message: null,
      code: error.code,
      source: "Host",
    }),
  );
}

export function toastFromHostErrorWithDetail(
  error: HostRpcError,
  fallback: string,
): void {
  const message = hostErrorToastMessageWithDetail(error, fallback);
  reportableErrorToast(
    message,
    undefined,
    createReportIssueContext({
      title: "Host operation failed",
      message: null,
      code: error.code,
      source: "Host",
    }),
  );
}

function hostErrorToastMessage(error: HostRpcError, fallback: string) {
  if (isLastOwnerRevokeError(error.message)) {
    return "Can't revoke the only Owner. Transfer ownership first.";
  }
  if (error.code === "FORBIDDEN") {
    return "You don't have permission to do that.";
  }
  if (error.code === "UNAUTHORIZED") {
    return "Please sign in again.";
  }
  if (error.code === "WORKTREE_BUSY") {
    return "Worktree is in use by an active chat or terminal. Stop those runs and try again.";
  }
  if (error.code === "WORKTREE_REBIND_BLOCKED") {
    return "Stop the active run before rebinding the worktree.";
  }
  if (error.code === "WORKTREE_MISSING") {
    return "A bound folder is missing on disk. Restore it, re-bind, or remove it to continue.";
  }
  if (error.code === "WORKTREE_REMOVE_LAST_ENTRY") {
    return "Keep at least one workspace folder linked — add another before removing this one.";
  }
  if (error.code === "PROVIDER_DISABLED") {
    return "This provider is disabled. Enable it in Settings → Providers.";
  }
  return fallback;
}

/**
 * Typed branch helper for callers that need to handle `WORKTREE_BUSY`
 * differently from a generic toast.
 */
export function isWorktreeBusyError(error: HostRpcError): boolean {
  return error.code === "WORKTREE_BUSY";
}

function hostErrorToastMessageWithDetail(
  error: HostRpcError,
  fallback: string,
) {
  const message = hostErrorToastMessage(error, fallback);
  if (message !== fallback) return message;
  const detail = error.message.trim();
  if (detail.length === 0 || detail === fallback) return fallback;
  return `${fallback} ${detail}`;
}

function isLastOwnerRevokeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot revoke the last owner") ||
    normalized.includes("can't revoke the last owner") ||
    normalized.includes("cannot revoke the only owner") ||
    normalized.includes("can't revoke the only owner")
  );
}
