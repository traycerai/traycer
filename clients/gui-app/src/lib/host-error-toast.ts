import {
  HostRequestAbortedError,
  HostTransportFailureError,
  isTransientHostRpcFailure,
  RetryableTransportError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import { emitHostErrorNotification } from "@/stores/notifications/app-local-notifications-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/**
 * One stable id for every pre-send transport notice, across every call site.
 * Host-unreachable is session-wide; `hostErrorDedupeKey` is per-operation and would fan out one flap into five toasts.
 */
const TRANSPORT_NOTICE_TOAST_ID = "host-transport-notice";

/**
 * Ambiguous post-send drop gets its own id so a later pre-send notice cannot replace it with "never received".
 */
const TRANSPORT_UNKNOWN_OUTCOME_TOAST_ID = "host-transport-notice-unknown";

/**
 * Transport-class: says nothing about the operation.
 * Not `isTransientHostRpcFailure` (that includes host-answered JWKS).
 */
function isTransportClassFailure(error: HostRpcError): boolean {
  if (error instanceof RetryableTransportError) {
    return true;
  }
  return (
    error instanceof HostTransportFailureError && error.fatalDetails === null
  );
}

/**
 * Gesture-path transport notice: no Report Issue, no host-error notification, not `toast.error`.
 * Not silent - a generic mutation has no disabled-affordance feedback of its own.
 */
function transportNoticeToast(error: HostRpcError): void {
  // Pre-send (`RetryableTransportError`) vs ambiguous post-send drop. Neither arm narrates recovery.
  if (error instanceof RetryableTransportError) {
    toast("That didn't go through — the Traycer host never received it.", {
      id: TRANSPORT_NOTICE_TOAST_ID,
    });
    return;
  }
  toast(
    "No reply came back from the Traycer host, so this may or may not have gone through.",
    { id: TRANSPORT_UNKNOWN_OUTCOME_TOAST_ID },
  );
}

export function toastFromHostError(
  error: HostRpcError,
  fallback: string,
): void {
  if (shouldSuppressRecoverableUnauthorized(error)) return;
  // Silent, and deliberately BEFORE the transport branch: an aborted request is not a network condition at all - a caller-owned authority was replaced or disposed (tab closed, host rebound).
  if (error instanceof HostRequestAbortedError) return;
  if (isTransportClassFailure(error)) {
    transportNoticeToast(error);
    return;
  }
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
 * Error policy for background best-effort host mutations - calls fired by presence changes or stream frames rather than a user gesture (e.g. marking the viewed entity's notifications read).
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
  if (shouldSuppressRecoverableUnauthorized(error)) return;
  if (error instanceof HostRequestAbortedError) return;
  if (isTransportClassFailure(error)) {
    transportNoticeToast(error);
    return;
  }
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

/**
 * A host `UNAUTHORIZED` while the app-level session is still signed in is the recoverable stale-bearer race (the wake-after-suspension case: an in-flight call raced the token refresh).
 */
function shouldSuppressRecoverableUnauthorized(error: HostRpcError): boolean {
  if (error.code !== "UNAUTHORIZED") return false;
  if (error.fatalDetails?.retryable === true) return false;
  return useAuthStore.getState().status !== "signed-out";
}

/**
 * Copy for a terminal verdict riding on a transport-class failure - the one case whose real cause is NOT the `code` on the error.
 * Returns `null` when it does not apply and the ordinary code mapping should run.
 */
function hostTerminalVerdictMessage(error: HostRpcError): string | null {
  // A terminal verdict carried on a transport-class failure.
  // Its wire `code` is the generic `RPC_ERROR` - the real one lives in `fatalDetails` - so every code-keyed branch would miss and the user would get the caller's fallback, which names an operation that was never attempted ("Couldn't load epics.") for a session.
  const verdict = error.fatalDetails;
  if (verdict !== null && error.code === "RPC_ERROR" && verdict.reason !== "") {
    return truncateWithEllipsis(verdict.reason, HOST_ERROR_DETAIL_MAX_CHARS);
  }
  return null;
}

/** The host's role-gate refusal phrases, verbatim. */
export const EDITOR_ACCESS_DENIED_PHRASE = "does not have editor access";
export const OWNER_ACCESS_DENIED_PHRASE = "does not have owner access";

/**
 * The host's epic role gates (`defineEditorResolver` / `defineOwnerResolver`) state the missing role in a fixed phrase, so - like the AGENT_BUSY branches below - the phrase is what we branch on.
 */
function forbiddenToastMessage(message: string): string {
  if (message.includes(EDITOR_ACCESS_DENIED_PHRASE)) {
    return "You have view-only access to this task, so you can't make changes to it.";
  }
  if (message.includes(OWNER_ACCESS_DENIED_PHRASE)) {
    return "Only this task's owner can do that.";
  }
  return "You don't have permission to do that.";
}

function hostErrorToastMessage(error: HostRpcError, fallback: string) {
  const verdict = hostTerminalVerdictMessage(error);
  if (verdict !== null) {
    return verdict;
  }
  if (isLastOwnerRevokeError(error.message)) {
    return "Can't revoke the only Owner. Transfer ownership first.";
  }
  // Archive refusals.
  // The host sends these as `RPC_ERROR` with a machine prefix rather than a dedicated wire code, so - like the last-owner case above - the prefix is what we branch on.
  if (error.message.startsWith("AGENT_BUSY:")) {
    // The host emits two arms and marks the one stop cannot clear with this exact phrase (`archiveBlockedMessage` in `agent-archive.ts`, which pins the disjointness in its own test).
    // The other arm stays hedged for the same reason the host's does: "stop it" is only sometimes the remedy.
    return error.message.includes("still running in the background")
      ? "This agent has background items still running. Archiving won't stop them — wait for them to finish, or stop them from its chat."
      : "This agent is still working. Stopping it ends a turn, but not a running subagent or a scheduled wake. Wait for it to go idle, or stop it, then archive.";
  }
  if (error.message.startsWith("TARGET_NOT_LOCAL:")) {
    return "This agent runs on another host. Archive it from that host instead.";
  }
  // An optional method the active host predates (declared `degrade: unsupported`).
  // This is a version gap, not a failed operation, so the copy points at the fix rather than restating the operation name.
  if (error.code === "E_HOST_UNSUPPORTED") {
    return "This needs a newer Traycer host. Update the host to continue.";
  }
  if (error.code === "FORBIDDEN") {
    return forbiddenToastMessage(error.message);
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
  return hostErrorToastForSimpleCode(error.code) ?? fallback;
}

function hostErrorToastForSimpleCode(
  code: HostRpcError["code"],
): string | null {
  if (code === "PROVIDER_DISABLED") {
    return "This provider is disabled. Enable it in Settings → Providers.";
  }
  if (code === "TERMINAL_DELETING") {
    return "This terminal is being deleted. Try again in a moment.";
  }
  return null;
}

/** Typed branch helper for callers that need to handle `WORKTREE_BUSY` differently from a generic toast. */
export function isWorktreeBusyError(error: HostRpcError): boolean {
  return error.code === "WORKTREE_BUSY";
}

function hostErrorToastMessageWithDetail(
  error: HostRpcError,
  fallback: string,
) {
  const message = hostErrorToastMessage(error, fallback);
  if (message !== fallback) return message;
  const detail = summarizeHostErrorDetail(error.message);
  if (detail.length === 0 || detail === fallback) return fallback;
  return `${fallback} ${detail}`;
}

/** How much of one host detail line a toast will show before cutting it. */
const HOST_ERROR_DETAIL_MAX_CHARS = 240;

/** Bound a free-form host message down to something a toast can be. */
function summarizeHostErrorDetail(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const head = truncateWithEllipsis(lines[0], HOST_ERROR_DETAIL_MAX_CHARS);
  return lines.length === 1 ? head : `${head} (+${lines.length - 1} more)`;
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
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
 * One connection-level cause produces one dedupe key, regardless of which request tripped over it.
 * Keying by `method:requestId` minted a fresh feed entry and toast per failed call, so an auth outage (e.g. a JWKS fetch failing) stacked identical "Please sign in again." rows as fast as background calls hit it.
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
  // A capability gap (older host lacking an optional method) is not a genuine operation failure - it carries fatal details but must not spawn a persistent app-local failure row.
  // The one-shot toast already delivers the upgrade guidance; a lingering feed entry would just be noise.
  if (error.code === "E_HOST_UNSUPPORTED") return;
  const dedupeKey = hostErrorDedupeKey(error);
  emitHostErrorNotification({
    id: dedupeKey ?? `${error.method}:${error.requestId}`,
    message,
    detail: error.fatalDetails.reason,
    payload: null,
  });
}
