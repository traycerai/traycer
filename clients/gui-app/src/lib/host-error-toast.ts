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
import {
  epicShareRefusalFromErrorCode,
  type EpicShareRefusal,
  type EpicSharePromotionPendingReason,
} from "@traycer/protocol/host/epic/share-refusal";

/**
 * Maps a HostRpcError to the appropriate toast copy mandated by the
 * Core Flows spec. Permission errors get distinct copy from network/RPC
 * errors so the user knows whether to retry or ask for access.
 *
 * Call this in every mutation hook's `onError` callback.
 */
/**
 * One stable id for every PRE-SEND transport notice, across every call site.
 *
 * Being unable to reach the host is a SESSION-WIDE condition, not a property
 * of whichever mutation happened to be in flight, so a flap that catches five
 * gestures must read as one line rather than five. `hostErrorDedupeKey` keys
 * by operation, which is right for genuine per-operation failures and wrong
 * here.
 */
const TRANSPORT_NOTICE_TOAST_ID = "host-transport-notice";

/**
 * The ambiguous arm gets its OWN id rather than sharing the one above.
 *
 * One id is right for one statement. "The host never saw it" and "the host may
 * have done it" are two, and the second is the one with consequences - a user
 * who reads it decides whether to check before repeating a delete. Sharing an
 * id would let a later pre-send notice replace it with the more reassuring
 * copy, which is the overclaim this split exists to remove, reintroduced by
 * the deduplication rather than by the wording. At most two lines per flap.
 */
const TRANSPORT_UNKNOWN_OUTCOME_TOAST_ID = "host-transport-notice-unknown";

/**
 * Whether this failure is the transport itself, and therefore says nothing
 * about the operation the user asked for.
 *
 * Deliberately NOT `isTransientHostRpcFailure`, which is a broader predicate
 * that also matches `fatalDetails.retryable === true` - the host-side JWKS
 * outage. That case was REACHED and ANSWERED by the host, has its own
 * deliberate copy, and is not a connection statement; folding it in here would
 * silently swallow that copy.
 *
 * `HostRequestAbortedError` is NOT handled here even though it extends
 * `HostTransportFailureError` - the callers return early on it, above, which
 * is what makes it silent. An exclusion here as well would be unreachable, and
 * a mutation probe proved it: deleting it left every test green, because the
 * early return had already taken the case. An untestable branch that looks
 * like a safety net is worse than no branch, so there is exactly one
 * mechanism and the probe can reach it.
 *
 * The `fatalDetails` clause is load-bearing and the class check alone is NOT
 * enough. `RemoteSession.notReadyRejection` settles every request parked
 * against a session that has gone TERMINAL - plan restriction, protocol
 * incompatibility, revoked access - as a plain `HostTransportFailureError`
 * whose `code` is the generic `RPC_ERROR` and whose real verdict rides in
 * `fatalDetails`. Classifying those as transport is this epic's central
 * distinction violated in the opposite direction: it promises a reconnect that
 * is not scheduled (the session is closed; nothing is redialling) and buries
 * the one thing the user could act on. A verdict means the host was reached
 * and answered, which is never a statement about the connection.
 *
 * `RetryableTransportError` is exempt from that clause, and the exemption is
 * the whole reason this is a function rather than one expression. On the
 * retryable subclass `fatalDetails` carries the OPPOSITE meaning: it is the
 * host's own attestation that it sat in `awaitingRequest` and never dispatched
 * the call (`ws-rpc-client.ts`'s `RPC_REQUEST_TIMEOUT` arm), which is exactly
 * the no-dispatch guarantee that licenses retrying a non-idempotent method.
 * Reading that attestation as a verdict routes a recoverable transport
 * condition to `reportableErrorToast` once retries are exhausted - a durable
 * failure row plus a Report Issue button for ordinary network weather. So the
 * discriminator is "was the host reached AND did it refuse", and only the
 * non-retryable subclass can answer yes.
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
 * The transport-class branch shared by both gesture-path helpers.
 *
 * Three things it deliberately does NOT do, each of which the reportable path
 * does and each of which was actively harmful for a transient network state:
 *
 *  - No Report Issue context. A flaky link is not a defect, and attaching a
 *    report affordance to one converts ordinary network weather into support
 *    tickets. We have already been burned by support issues minted by our own
 *    toasts; at ~158 call sites this was that shape at scale.
 *  - No `emitHostErrorNotification`. A blip must not deposit a host-error
 *    entry that outlives the condition that produced it.
 *  - Not `toast.error`. The condition is transient and self-healing, so it is
 *    stated as a condition rather than framed as a failure.
 *
 * It is also NOT silent, and that is the deliberate part. Silence is correct
 * for background work, and correct for a surface that disables its own
 * affordance (chat's composer gates on `connectionStatus === "open"`, so the
 * disabled composer IS the feedback). A generic mutation has no such
 * affordance: the user clicked, nothing happened, and with no notice at all
 * they either retry blindly or believe it worked.
 *
 * RESIDUAL GAP, stated rather than papered over: this covers every caller that
 * routes through these helpers, which is all ~158 of them, but it cannot
 * constrain a future caller that reaches for `reportableErrorToast` directly
 * with a host error. A lexical guard (grep/lint for the pairing) would look
 * like a fence and would not be one - the property is not lexically decidable.
 * The helper test is the real coverage; this paragraph is the rest.
 */
function transportNoticeToast(error: HostRpcError): void {
  // The two arms are NOT stylistic variants of one message - they differ on
  // whether the operation may already have happened.
  //
  // `RetryableTransportError` is the pre-send subclass, and its whole reason
  // for existing is the guarantee that the host never dispatched the request:
  // either the frame never made it onto the wire, or the host attested it was
  // still waiting for one. That guarantee is what makes `createRetryingMessenger`
  // safe to retry a non-idempotent method, and it is equally what makes
  // "didn't go through" a true statement.
  //
  // A plain `HostTransportFailureError` has no such guarantee. It is the
  // ambiguous post-send drop: the request may have been dispatched, executed,
  // and had only its RESPONSE lost. Telling that user it did not go through
  // invites them to do it again - and at ~158 gesture call sites the set of
  // things being repeated includes deletes, revokes and archives.
  //
  // Neither arm narrates RECOVERY, and that is a correction rather than an
  // omission. "Reconnecting" was false for two of the errors that reach here:
  // a request-only unary timeout (`RemoteSession.unaryTimeoutError`) tombstones
  // one stream and leaves the session `ready` with nothing redialling, and the
  // host-attested no-dispatch timeout was ANSWERED by a healthy host. Worse,
  // the two are not separable at this boundary - a genuine post-send socket
  // drop, where a redial really is running, arrives as the same class with the
  // same null `fatalDetails` as the unary timeout. With no fact available to
  // tell them apart, the only honest copy is the one that claims neither, and
  // telling a user to wait for a recovery that is not coming is the worse
  // error of the two. Narrating the connection is the session-level
  // affordance's job; this toast's job is the gesture's outcome.
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
  // Silent, and deliberately BEFORE the transport branch: an aborted request
  // is not a network condition at all - a caller-owned authority was replaced
  // or disposed (tab closed, host rebound). Saying "reconnecting" for what was
  // effectively a user navigation would be a NEW false statement, and saying
  // "couldn't do X" for something they themselves cancelled is no better.
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
 * A host `UNAUTHORIZED` while the app-level session is still signed in is the
 * recoverable stale-bearer race (the wake-after-suspension case: an in-flight
 * call raced the token refresh). The shared single-flight revalidator owns
 * recovery: on "rotated" the retry succeeds silently, and on "rejected" the
 * revalidator signs out - flipping auth status to `signed-out`, which emits
 * the one authoritative "Session expired - sign in again." toast via
 * `AuthSessionExpiredToastBridge`. Toasting here too produced a "sign in"
 * toast on every overnight wake even though recovery succeeded seconds later.
 * The `retryable` (host-side JWKS outage) variant keeps its distinct copy:
 * it is not a credential statement and never leads to a sign-out.
 */
function shouldSuppressRecoverableUnauthorized(error: HostRpcError): boolean {
  if (error.code !== "UNAUTHORIZED") return false;
  if (error.fatalDetails?.retryable === true) return false;
  return useAuthStore.getState().status !== "signed-out";
}

/**
 * Copy for a terminal verdict riding on a transport-class failure - the one
 * case whose real cause is NOT the `code` on the error. Returns `null` when it
 * does not apply and the ordinary code mapping should run.
 *
 * PRECONDITION: the error is not transport-class. Both exported callers return
 * on `isTransportClassFailure` before reaching the code mapping, which is what
 * makes the single check below sufficient - a retryable attestation matches
 * this branch's shape exactly (`RPC_ERROR` + a non-empty `reason`), so without
 * that guard the host's raw timeout text would render as a verdict and the
 * classifier fix would simply move the bug one layer down.
 *
 * That guard is not restated here. Re-testing the caller's precondition would
 * add a branch no test can reach, and an unreachable branch that looks like a
 * safety net is worse than none - the same call already made for
 * `HostRequestAbortedError` above, and for the same reason. The composition is
 * covered where it is observable instead: at the exported helpers, driven with
 * the real retryable-attestation shape.
 *
 * Split out from {@link hostErrorToastMessage} to keep that function under the
 * complexity ceiling, and because it reads the CLASS and `fatalDetails`, never
 * `code`.
 */
function hostTerminalVerdictMessage(error: HostRpcError): string | null {
  // A terminal verdict carried on a transport-class failure. Its wire `code`
  // is the generic `RPC_ERROR` - the real one lives in `fatalDetails` - so
  // every code-keyed branch would miss and the user would get the caller's
  // fallback, which names an operation that was never attempted ("Couldn't
  // load epics.") for a session that is closed for good.
  //
  // The verdict's own `reason` is used rather than new invented copy: it is
  // host-authored, states the CONDITION ("Remote host connectivity requires a
  // paid plan", "Host access was revoked"), and is already what
  // `emitHostErrorNotification` puts in the durable row's detail. Bounded,
  // because host detail is unbounded by construction.
  const verdict = error.fatalDetails;
  if (verdict !== null && error.code === "RPC_ERROR" && verdict.reason !== "") {
    return truncateWithEllipsis(verdict.reason, HOST_ERROR_DETAIL_MAX_CHARS);
  }
  return null;
}

/**
 * The host's role-gate refusal phrases, verbatim.
 *
 * An untyped wire contract: `traycer-host`'s `auth-helpers.ts` writes these
 * into `EpicAccessForbiddenError` messages ("User 'x' does not have editor
 * access to epic 'y'"), and the FORBIDDEN branch below matches on them to
 * explain the refusal. The wire carries no structured denial reason, so the
 * phrase is the whole contract - the host repo pins both sides in
 * `role-gate-phrase-contract.test.ts` (it reads this file), and drift there
 * degrades gracefully here to the generic permission sentence.
 */
export const EDITOR_ACCESS_DENIED_PHRASE = "does not have editor access";
export const OWNER_ACCESS_DENIED_PHRASE = "does not have owner access";

/**
 * The host's epic role gates (`defineEditorResolver` / `defineOwnerResolver`)
 * state the missing role in a fixed phrase, so - like the AGENT_BUSY branches
 * below - the phrase is what we branch on. The copy is rewritten rather than
 * passed through: the raw host text names user and epic ids, which mean
 * nothing in a toast. Without this, a viewer clicking anything editor-gated
 * (cloning a shared agent, for one) got the bare generic, indistinguishable
 * from a bug.
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
  // Archive refusals. The host sends these as `RPC_ERROR` with a machine
  // prefix rather than a dedicated wire code, so - like the last-owner case
  // above - the prefix is what we branch on. Without a branch these fall to
  // the bare fallback ("Couldn't archive agent."), which tells the user
  // nothing and is indistinguishable from a permissions or missing-record
  // failure. The copy is rewritten here rather than passed through: the raw
  // host text is written for an agent reading a tool result.
  if (error.message.startsWith("AGENT_BUSY:")) {
    // The host emits two arms and marks the one stop cannot clear with this
    // exact phrase (`archiveBlockedMessage` in `agent-archive.ts`, which pins
    // the disjointness in its own test). The other arm stays hedged for the
    // same reason the host's does: "stop it" is only sometimes the remedy.
    return error.message.includes("still running in the background")
      ? "This agent has background items still running. Archiving won't stop them — wait for them to finish, or stop them from its chat."
      : "This agent is still working. Stopping it ends a turn, but not a running subagent or a scheduled wake. Wait for it to go idle, or stop it, then archive.";
  }
  if (error.message.startsWith("TARGET_NOT_LOCAL:")) {
    return "This agent runs on another host. Archive it from that host instead.";
  }
  // An optional method the active host predates (declared `degrade:
  // unsupported`). This is a version gap, not a failed operation, so the copy
  // points at the fix rather than restating the operation name.
  if (error.code === "E_HOST_UNSUPPORTED") {
    return "This needs a newer Traycer host. Update the host to continue.";
  }
  // BEFORE the `FORBIDDEN` arm, and that ordering is the fix -
  // `s5-status-truthfulness` instance 5. A free-tier owner's share used to
  // arrive as a plain 403/`FORBIDDEN` and land on that arm, so the app told a
  // user they lacked permission on their OWN epic. It is a plan limit, not an
  // authorization failure, and the two need different words and different
  // next steps.
  const shareRefusal = epicShareRefusalFromErrorCode(error.code);
  if (shareRefusal !== null) return shareRefusalMessage(shareRefusal);
  return codeKeyedMessage(error, fallback);
}

/** The plain `code` switchboard, split out to keep either half readable. */
function codeKeyedMessage(error: HostRpcError, fallback: string): string {
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

/**
 * Honest copy for each way the share gate refuses -
 * `s5-status-truthfulness` instance 5, rendering half.
 *
 * Every one of these used to collapse into one of two useless sentences:
 * "You don't have permission to do that." (false about the user's own
 * account) or the bare "Couldn't invite collaborators." fallback, which lost
 * the reason and any retry guidance. The host now sends a distinct code per
 * outcome, so each one can say what happened and what to do next.
 *
 * The `promotion-pending` reasons are split rather than sharing one string
 * BECAUSE their advice differs: three of them mean "wait", and `failed` is
 * the one where waiting is not the answer. Collapsing them would re-lose
 * exactly what the taxonomy recovered.
 */
function shareRefusalMessage(refusal: EpicShareRefusal): string {
  switch (refusal.kind) {
    case "needs-cloud-sync":
      return "Sharing needs cloud sync, which isn't on your plan. Upgrade from your account menu → Manage subscription. The epic keeps working locally either way.";
    case "not-owned":
      return "This epic was created on this machine by a different account, so it can't be shared from yours. Sign in with the account that created it.";
    case "promotion-pending":
      return sharePendingMessage(refusal.reason);
    case "refused":
      return "Couldn't share this epic right now.";
  }
}

function sharePendingMessage(reason: EpicSharePromotionPendingReason): string {
  switch (reason) {
    case "recent-attempt":
      return "This epic is still being copied to the cloud. Nothing is lost — try inviting again in a moment.";
    case "busy":
      return "This epic is busy right now, so it hasn't finished reaching the cloud. Let the current work settle, then invite again.";
    case "offline":
      return "Couldn't reach the cloud to finish copying this epic. Check your connection and invite again.";
    case "failed":
      return "This epic couldn't be copied to the cloud, so there's nothing for a collaborator to open yet. Retrying won't help on its own — reopen the epic, or contact support if it persists.";
  }
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
  const detail = summarizeHostErrorDetail(error.message);
  if (detail.length === 0 || detail === fallback) return fallback;
  return `${fallback} ${detail}`;
}

/**
 * How much of one host detail line a toast will show before cutting it.
 *
 * Sized from the failure this exists for: a `git worktree add` refusal names
 * one branch, one absolute path and the git reason - around 190 characters
 * for a realistic worktree under a nested repo - and cutting THAT is what a
 * cap must not do, since the last clause ("a branch named 'x' already exists")
 * is the whole point. Anything materially longer is a diagnostic dump, not a
 * sentence, and the ellipsis is the honest thing to show for it.
 */
const HOST_ERROR_DETAIL_MAX_CHARS = 240;

/**
 * Bound a free-form host message down to something a toast can be.
 *
 * Host detail is UNBOUNDED by construction, and the producer this helper's
 * `epic.createChat` caller targets is the clearest case: `worktreeCreateFailed`
 * joins ONE line per failed workspace, each carrying an absolute path plus raw
 * git stderr. Appended verbatim that is an arbitrarily tall toast full of local
 * paths and command diagnostics.
 *
 * So: the first non-empty line, character-capped, and an explicit count of what
 * was dropped. The count is not decoration - taking the first line silently
 * would hide that two other folders also failed, which is exactly the kind of
 * quiet omission this whole change set exists to remove. Blank lines are
 * dropped before counting so a trailing newline never claims a phantom entry.
 *
 * No details/expand affordance deliberately: the first line names the first
 * failing folder AND its reason, which is what someone acts on, and a
 * disclosure widget is a surface to design rather than a bound to enforce.
 */
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
  // A capability gap (older host lacking an optional method) is not a genuine
  // operation failure - it carries fatal details but must not spawn a
  // persistent app-local failure row. The one-shot toast already delivers the
  // upgrade guidance; a lingering feed entry would just be noise. This mirrors
  // `toastFromBackgroundHostError`, which suppresses `E_HOST_UNSUPPORTED`
  // outright.
  if (error.code === "E_HOST_UNSUPPORTED") return;
  const dedupeKey = hostErrorDedupeKey(error);
  emitHostErrorNotification({
    id: dedupeKey ?? `${error.method}:${error.requestId}`,
    message,
    detail: error.fatalDetails.reason,
    payload: null,
  });
}
