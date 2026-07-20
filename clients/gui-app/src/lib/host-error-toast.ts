import {
  HostTransportFailureError,
  isTransientHostRpcFailure,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { emitHostErrorNotification } from "@/stores/notifications/app-local-notifications-store";
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
  emitHostFatalErrorNotification(error, message);
  const dedupeKey = hostErrorDedupeKey(error);
  reportableErrorToast(
    message,
    dedupeKey === null ? undefined : { id: `host-error:${dedupeKey}` },
    createReportIssueContext({
      title: "Host operation failed",
      message: null,
      code: error.code,
      source: "Host",
    }),
  );
}

/**
 * Error policy for background best-effort host mutations - calls fired by
 * presence changes or stream frames rather than a user gesture (e.g. marking
 * the viewed entity's notifications read). These self-heal on reconnect, so a
 * restarting or unreachable host must not stack operation-named toasts for
 * work the user never initiated: transient failures (transport-level, or a
 * fatal frame the host marked retryable) and capability gaps stay silent.
 * Only a host that was reached and genuinely rejected the operation toasts,
 * through the same copy mapping as gesture-driven mutations.
 */
export function toastFromBackgroundHostError(
  error: HostRpcError,
  fallback: string,
): void {
  if (error.code === "E_HOST_UNSUPPORTED") return;
  if (isTransientHostRpcFailure(error)) return;
  toastFromHostError(error, fallback);
}

export function toastFromHostErrorWithDetail(
  error: HostRpcError,
  fallback: string,
): void {
  const message = hostErrorToastMessageWithDetail(error, fallback);
  emitHostFatalErrorNotification(error, message);
  const dedupeKey = hostErrorDedupeKey(error);
  reportableErrorToast(
    message,
    dedupeKey === null ? undefined : { id: `host-error:${dedupeKey}` },
    createReportIssueContext({
      title: "Host operation failed",
      message: null,
      code: error.code,
      source: "Host",
    }),
  );
}

function hostErrorToastMessage(error: HostRpcError, fallback: string) {
  // Connection-level failures name the underlying cause, not whichever
  // operation happened to be in flight when the host went away.
  if (error instanceof HostTransportFailureError) {
    return "Can't reach the Traycer host. It may be restarting — try again in a moment.";
  }
  if (isLastOwnerRevokeError(error.message)) {
    return "Can't revoke the only Owner. Transfer ownership first.";
  }
  if (error.code === "FORBIDDEN") {
    return "You don't have permission to do that.";
  }
  if (error.code === "UNAUTHORIZED") {
    if (error.fatalDetails?.retryable === true) {
      return "The host couldn't verify your session. Try again in a moment.";
    }
    return "Please sign in again.";
  }
  if (error.code === "WORKTREE_BUSY") {
    return "Worktree is in use by an active agent or terminal. Stop those runs and try again.";
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

/**
 * One connection-level cause produces one dedupe key, regardless of which
 * request tripped over it. Keying by `method:requestId` minted a fresh feed
 * entry and toast per failed call, so an auth outage (e.g. a JWKS fetch
 * failing) stacked identical "Please sign in again." rows as fast as
 * background calls hit it. With a cause key, the store's upsert and sonner's
 * id-replacement collapse repeats into one entry that resurfaces (unread,
 * fresh timestamp, latest detail) each time the cause fires again.
 */
function hostErrorDedupeKey(error: HostRpcError): string | null {
  if (error.fatalDetails !== null) {
    return `${error.code}:${error.fatalDetails.code}`;
  }
  if (error instanceof HostTransportFailureError) {
    return "transport";
  }
  return null;
}

function emitHostFatalErrorNotification(
  error: HostRpcError,
  message: string,
): void {
  if (error.fatalDetails === null) return;
  const dedupeKey = hostErrorDedupeKey(error);
  emitHostErrorNotification({
    id: dedupeKey ?? `${error.method}:${error.requestId}`,
    message,
    detail: error.fatalDetails.reason,
    payload: null,
  });
}
