import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  profileCopyFeasibilitySchema,
  profileCopyOutcomeSchema,
  profileCopyPreviewDestinationSchema,
  profileCopyProviderSchema,
  profileCopyReasonSchema,
  type ProfileCopyAttempt,
  type ProfileCopyOutcome,
} from "@traycer/protocol/host/profile-copy-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

/**
 * Pure facts the profile-copy flow reads off the wire.
 *
 * Deliberately NOT a capability classifier. Whether a destination can receive
 * a profile, and by which route, is the source host's `preview` answer and the
 * destination's `outcome`; this module only NAMES what those answers already
 * say (which state is settled, which row has a destination record) so every
 * surface asks the same question the same way. The one structural fact derived
 * here is `targetProfileId !== null`: a destination reserves the target id
 * before its first write, so a null one is an outcome no destination recorded.
 */

export type ProfileCopyPreviewResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.preview"
>;
export type ProfileCopyPreviewDestination =
  ProfileCopyPreviewResponse["destinations"][number];
export type ProfileCopyOperationResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.status"
>;
export type ProfileCopyDraftResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.draftStatus"
>;
export type ProfileCopyIncomingResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.incoming"
>;
export type ProfileCopyIncomingDraft =
  ProfileCopyIncomingResponse["drafts"][number];
export type ProfileCopyLoginResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.login.start"
>;
export type ProfileCopyLoginChallenge = NonNullable<
  ProfileCopyLoginResponse["challenge"]
>;
export type ProfileCopyState = ProfileCopyOutcome["state"];
export type ProfileCopyReason = NonNullable<ProfileCopyOutcome["reason"]>;
export type ProfileCopyDisposition =
  ProfileCopyPreviewDestination["disposition"];
/** The manual sign-in routes a destination can admit, read off the wire. */
export type ProfileCopyManualRoute = Extract<
  ProfileCopyPreviewDestination["feasibility"]["manual"],
  { readonly status: "available" }
>["route"];
export type { ProfileCopyAttempt, ProfileCopyOutcome };

/** The wire providers a managed profile can be copied for (v1: four). */
export type ProfileCopyWireProvider = ProfileCopyAttempt["providerId"];
/** The same four, as GUI provider ids. */
export type ProfileCopyGuiProvider = Extract<
  ProviderId,
  "claude-code" | "codex" | "grok" | "antigravity"
>;

/**
 * Every value of the wire `state` enum, read off the schema itself: a state
 * the wire adds is listed here - and so admitted by the analytics allowlist
 * and the persisted-store filter that read this - without anyone editing it.
 */
export const PROFILE_COPY_STATES: readonly ProfileCopyState[] =
  profileCopyOutcomeSchema.shape.state.options;

/** Every value of the wire `reason` enum, read off the schema itself. */
export const PROFILE_COPY_REASONS: readonly ProfileCopyReason[] =
  profileCopyReasonSchema.options;

/**
 * Every wire provider, preview disposition and manual route, read off the
 * schemas - for the persisted-handle parsers, which must admit whatever the
 * wire admits rather than drop a handle for a value added later.
 */
export const PROFILE_COPY_PROVIDERS: readonly ProfileCopyWireProvider[] =
  profileCopyProviderSchema.options;
export const PROFILE_COPY_DISPOSITIONS: readonly ProfileCopyDisposition[] =
  profileCopyPreviewDestinationSchema.shape.disposition.options;
export const PROFILE_COPY_MANUAL_ROUTES: readonly ProfileCopyManualRoute[] =
  profileCopyFeasibilitySchema.shape.manual.options[0].shape.route.options;

/** GUI provider id → wire provider, or `null` for a provider outside v1. */
export function profileCopyWireProvider(
  providerId: ProviderId,
): ProfileCopyWireProvider | null {
  switch (providerId) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "antigravity";
    default:
      return null;
  }
}

/** Wire provider → GUI provider id, for display names and Settings focus. */
export function profileCopyGuiProvider(
  provider: ProfileCopyWireProvider,
): ProfileCopyGuiProvider {
  switch (provider) {
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "antigravity";
  }
}

/**
 * Whether the Copy action belongs on a profile of this provider at all: one
 * of the four providers, every profile kind included. The Terminal account
 * copies like a managed profile - nothing from the CLI's own home is
 * exported, so a destination signs in itself. Whether any device can
 * actually receive it is the preview's answer.
 */
export function profileCopyEntryEligible(providerId: ProviderId): boolean {
  return profileCopyWireProvider(providerId) !== null;
}

/** A destination recorded this outcome (it reserved a target profile id). */
export function isRecordedOutcome(outcome: ProfileCopyOutcome): boolean {
  return outcome.targetProfileId !== null;
}

const ALWAYS_SETTLED_STATES: ReadonlySet<ProfileCopyState> = new Set([
  "signed-in",
  "used-without-verification",
  "already-present",
  "cancelled",
  "quarantined",
  "removed",
]);

/**
 * Nothing about this row changes without a user action or a retry:
 *
 * - the six destination-final states;
 * - a source-local `blocked` (the source recorded a local result);
 * - a destination-recorded `failed` (not emitted today, final if it ever is).
 *
 * A source-local `failed` is NOT settled: it is persisted-but-never-dialled and
 * the next `status` re-drives it.
 */
export function isOutcomeSettled(outcome: ProfileCopyOutcome): boolean {
  if (ALWAYS_SETTLED_STATES.has(outcome.state)) return true;
  if (outcome.state === "blocked") return !isRecordedOutcome(outcome);
  if (outcome.state === "failed") return isRecordedOutcome(outcome);
  return false;
}

/** Destination-final states that put a usable (or kept) profile on the device. */
export function isOutcomePromoted(outcome: ProfileCopyOutcome): boolean {
  return (
    outcome.state === "signed-in" ||
    outcome.state === "used-without-verification" ||
    outcome.state === "already-present"
  );
}

/**
 * Source-local block reasons a retry can plausibly clear: the host re-drives
 * the SAME attempt, re-checking the source and the destination route. Reasons
 * about the profile itself (`source-changed`, `credential-*`) need a new copy,
 * and a closed route (`adapter-not-admitted`, `manual-login-unavailable`, …)
 * would only be refused again.
 */
const RETRYABLE_LOCAL_BLOCK_REASONS: ReadonlySet<ProfileCopyReason> = new Set([
  "unreachable",
  "directory-unavailable",
  "update-required",
  "install-required",
  "login-resource-busy",
  "provider-unavailable",
  "internal-error",
]);

const COPY_AGAIN_LOCAL_BLOCK_REASONS: ReadonlySet<ProfileCopyReason> = new Set([
  "source-changed",
  "credential-missing",
  "credential-malformed",
]);

/**
 * Which source-side recovery this row offers. `retry` is the source host's
 * `retry` verb; the host decides and may still answer `unavailable` (a
 * cancelled operation, a full chain, a provider-wide login resource held).
 * `operationCancelled` is what THIS window knows: a cancel it sent that the
 * source confirmed. A cancel whose answer never came is not counted, so it
 * never withholds Retry.
 */
export type ProfileCopySourceRecovery = "retry" | "copy-again" | "none";

export function profileCopySourceRecovery(
  outcome: ProfileCopyOutcome,
  operationCancelled: boolean,
): ProfileCopySourceRecovery {
  if (outcome.replacementAttemptId !== null) return "none";
  if (isRecordedOutcome(outcome)) {
    if (outcome.state === "quarantined") {
      return operationCancelled ? "copy-again" : "retry";
    }
    if (outcome.state === "cancelled") {
      return operationCancelled ? "copy-again" : "retry";
    }
    if (outcome.state === "removed" || outcome.state === "failed") {
      return "copy-again";
    }
    return "none";
  }
  if (outcome.state === "cancelled") return "copy-again";
  if (outcome.state !== "blocked" || outcome.reason === null) return "none";
  if (COPY_AGAIN_LOCAL_BLOCK_REASONS.has(outcome.reason)) return "copy-again";
  if (!RETRYABLE_LOCAL_BLOCK_REASONS.has(outcome.reason)) return "none";
  // A cancelled operation refuses Retry; a transient block does not make a
  // fresh copy pointless, so offer that - as the recorded rows above do.
  return operationCancelled ? "copy-again" : "retry";
}

/**
 * Poll pacing, shared by the policy table's condition classifiers.
 *
 * - `active`: the host is doing something on its own and will finish soon
 *   (preflight/dispatch, verification, the last promotion step, a persisted
 *   row the next status re-drives).
 * - `waiting`: nothing moves without a person or another device - but the
 *   person may be acting on the other device, and an unanswered destination
 *   may come back.
 * - `idle`: nothing left to watch.
 *
 * Every `status` tick costs the source a directory read and a receipt dial per
 * open row (neither is cached per RPC), so the waiting lane is deliberately
 * slow and nothing polls once every row is settled.
 */
export type ProfileCopyPollActivity = "active" | "waiting" | "idle";

/**
 * How an UNSETTLED head paces the operation's `status` poll, per wire state,
 * exhaustive by type. Settled heads are `idle` before this is consulted; the
 * always-settled states are listed only so a new wire state fails to compile.
 */
const OUTCOME_POLL_ACTIVITY: {
  readonly [S in ProfileCopyState]: ProfileCopyPollActivity;
} = {
  preparing: "active",
  verifying: "active",
  ready: "active",
  failed: "active",
  "outcome-unknown": "waiting",
  "sign-in-required": "waiting",
  "signing-in": "waiting",
  "verification-pending": "waiting",
  "account-confirmation-required": "waiting",
  blocked: "waiting",
  "signed-in": "idle",
  "used-without-verification": "idle",
  "already-present": "idle",
  cancelled: "idle",
  quarantined: "idle",
  removed: "idle",
};

function outcomePollActivity(
  outcome: ProfileCopyOutcome,
): ProfileCopyPollActivity {
  if (isOutcomeSettled(outcome)) return "idle";
  return OUTCOME_POLL_ACTIVITY[outcome.state];
}

export function profileCopyOutcomesPollActivity(
  outcomes: readonly ProfileCopyOutcome[],
): ProfileCopyPollActivity {
  let activity: ProfileCopyPollActivity = "idle";
  for (const outcome of outcomes) {
    const next = outcomePollActivity(outcome);
    if (next === "active") return "active";
    if (next === "waiting") activity = "waiting";
  }
  return activity;
}

/** Per wire state, exhaustive by type - see `profileCopyDraftPollActivity`. */
const DRAFT_POLL_ACTIVITY: {
  readonly [S in ProfileCopyState]: ProfileCopyPollActivity;
} = {
  preparing: "active",
  verifying: "active",
  ready: "active",
  "signing-in": "waiting",
  failed: "idle",
  "outcome-unknown": "idle",
  "sign-in-required": "idle",
  "verification-pending": "idle",
  "account-confirmation-required": "idle",
  "signed-in": "idle",
  "used-without-verification": "idle",
  "already-present": "idle",
  blocked: "idle",
  cancelled: "idle",
  quarantined: "idle",
  removed: "idle",
};

/**
 * A destination draft moves on its own only while the host is working on it
 * (`preparing` / `verifying` / `ready`) or a sign-in is live (`signing-in`).
 * Every other state waits for a user action, whose answer updates the cache.
 */
export function profileCopyDraftPollActivity(
  outcome: ProfileCopyOutcome,
): ProfileCopyPollActivity {
  return DRAFT_POLL_ACTIVITY[outcome.state];
}

/** The preview facts kept with an operation handle, per destination. */
export interface ProfileCopyPreviewRecord {
  readonly destinationHostId: string;
  readonly disposition: ProfileCopyDisposition;
  readonly reason: ProfileCopyReason | null;
  readonly manualRoute: ProfileCopyManualRoute | null;
  readonly destinationProviderEnabled: boolean | null;
}

export function profileCopyPreviewRecord(
  destination: ProfileCopyPreviewDestination,
): ProfileCopyPreviewRecord {
  const manual = destination.feasibility.manual;
  return {
    destinationHostId: destination.destinationHostId,
    disposition: destination.disposition,
    reason: destination.reason,
    manualRoute: manual.status === "available" ? manual.route : null,
    destinationProviderEnabled: destination.destinationProviderEnabled,
  };
}

/** Preview rows that a start creates an attempt for. */
export function isRoutableDisposition(
  disposition: ProfileCopyDisposition,
): boolean {
  return disposition === "automatic" || disposition === "manual";
}

/**
 * The route a destination was previewed with, as the draft surfaces need it:
 * `automatic`, a manual route, or `null` when this window never saw the
 * preview (a draft opened from Incoming - the route is not on the wire).
 */
export type ProfileCopyKnownRoute = "automatic" | ProfileCopyManualRoute | null;

export function knownRouteFromRecord(
  record: ProfileCopyPreviewRecord | undefined,
): ProfileCopyKnownRoute {
  if (record === undefined) return null;
  if (record.disposition === "automatic") return "automatic";
  if (record.disposition === "manual") return record.manualRoute;
  return null;
}

/**
 * One row of the operation view: the chain head the source reported for a
 * destination, or - for a destination that got no attempt - the preview the
 * operation was started from. Ordered as the operation's destination list,
 * then any destination the source reports that the list does not name (a
 * handle rebuilt from an incoming draft knows only its own destination).
 */
export type ProfileCopyOperationRow =
  | {
      readonly kind: "attempt";
      readonly destinationHostId: string;
      readonly outcome: ProfileCopyOutcome;
      readonly preview: ProfileCopyPreviewRecord | undefined;
    }
  | {
      readonly kind: "preview-only";
      readonly destinationHostId: string;
      readonly preview: ProfileCopyPreviewRecord;
    }
  | {
      readonly kind: "unreported";
      readonly destinationHostId: string;
    };

export function profileCopyOperationRows(
  destinationHostIds: readonly string[],
  previewRecords: readonly ProfileCopyPreviewRecord[],
  outcomes: readonly ProfileCopyOutcome[] | null,
): readonly ProfileCopyOperationRow[] {
  const listed = new Set(destinationHostIds);
  const unlisted = (outcomes ?? [])
    .map((outcome) => outcome.attempt.destinationHostId)
    .filter((destinationHostId) => !listed.has(destinationHostId));
  return [...destinationHostIds, ...unlisted].map(
    (destinationHostId): ProfileCopyOperationRow => {
      const preview = previewRecords.find(
        (record) => record.destinationHostId === destinationHostId,
      );
      const outcome = outcomes?.find(
        (candidate) =>
          candidate.attempt.destinationHostId === destinationHostId,
      );
      if (outcome !== undefined) {
        return { kind: "attempt", destinationHostId, outcome, preview };
      }
      if (
        preview !== undefined &&
        !isRoutableDisposition(preview.disposition)
      ) {
        return { kind: "preview-only", destinationHostId, preview };
      }
      return { kind: "unreported", destinationHostId };
    },
  );
}

/** Stable identity of one attempt, for window-local memory. */
export function profileCopyAttemptKey(attempt: ProfileCopyAttempt): string {
  return `${attempt.operationId}:${attempt.attemptId}`;
}

/** A transfer keeps this identity when Retry replaces its attempt. */
export function profileCopyTransferKey(attempt: ProfileCopyAttempt): string {
  return JSON.stringify([
    attempt.sourceHostId,
    attempt.operationId,
    attempt.destinationHostId,
    attempt.providerId,
    attempt.sourceProfileId,
  ]);
}

/** Merge an authoritative Retry answer without replacing a later receipt. */
export function reconcileProfileCopyRetryOutcome(
  current: ProfileCopyOutcome,
  requested: ProfileCopyAttempt,
  outcome: ProfileCopyOutcome,
): ProfileCopyOutcome {
  const transfer = profileCopyTransferKey(requested);
  if (
    profileCopyTransferKey(current.attempt) !== transfer ||
    profileCopyTransferKey(outcome.attempt) !== transfer ||
    (current.attempt.attemptId !== requested.attemptId &&
      current.attempt.attemptId !== outcome.attempt.attemptId) ||
    (current.attempt.attemptId === outcome.attempt.attemptId &&
      current.revision > outcome.revision)
  )
    return current;
  return outcome;
}
