import type { ProviderAuthStatus } from "@traycer/protocol/host/provider-schemas";
import {
  isRecordedOutcome,
  type ProfileCopyKnownRoute,
  type ProfileCopyManualRoute,
  type ProfileCopyOutcome,
  type ProfileCopyPreviewRecord,
  type ProfileCopyReason,
  type ProfileCopyState,
} from "@/lib/profile-copy/profile-copy-model";

/**
 * The copy for every preview disposition and outcome state the host can send,
 * as data. Components render these verbatim; nothing here reads a provider,
 * platform or auth method to decide a route - the host already did, and the
 * words below only say what it said.
 */

export type ProfileCopyTone =
  | "success"
  | "warning"
  | "info"
  | "destructive"
  | "muted";

/** Display names, resolved by the caller. Never ids, never account data. */
export interface ProfileCopyNames {
  /** The source host's display name. */
  readonly source: string;
  /** The destination host's display name. */
  readonly destination: string;
  /** The provider's display name, e.g. "Claude Code". */
  readonly provider: string;
  /** The profile's label as the user named it. */
  readonly profile: string;
}

export interface ProfileCopyReasonCopy {
  readonly badge: string;
  readonly tone: ProfileCopyTone;
  readonly body: string;
}

/**
 * The shared-resource condition, kept apart from "needs the device itself":
 * freeing the resource never makes a remote loopback sign-in possible, and
 * restarting Traycer alone does not release a resource the device holds.
 */
export function profileCopySharedResourceCopy(names: ProfileCopyNames): string {
  return `Another ${names.provider} sign-in is still holding a shared resource on ${names.destination}. Finish or stop it there. If it's stuck, restart ${names.destination} itself — restarting only Traycer isn't enough. Then try again.`;
}

/** Verify refused the copied configuration: verifying again cannot help. */
function refusedSettingsCopy(names: ProfileCopyNames): string {
  return `${names.destination} refused the copied settings. Cancel this device and copy again — verifying again won't help.`;
}

type ReasonCopyBuilder = (names: ProfileCopyNames) => ProfileCopyReasonCopy;

/** One sentence per wire reason, exhaustive by type. */
const REASON_COPY: { readonly [R in ProfileCopyReason]: ReasonCopyBuilder } = {
  "update-required": (names) => ({
    badge: "Update needed",
    tone: "warning",
    body: `${names.destination} runs an older version of Traycer that can't receive profiles. Update Traycer on ${names.destination}, then check again.`,
  }),
  unreachable: (names) => ({
    badge: "Can't reach",
    tone: "warning",
    body: `${names.source} couldn't reach ${names.destination}. It may be offline or asleep.`,
  }),
  "directory-unavailable": () => ({
    badge: "Couldn't check devices",
    tone: "warning",
    body: "Traycer couldn't confirm your account's devices right now. This is usually temporary.",
  }),
  "install-required": (names) => ({
    badge: "Not installed",
    tone: "warning",
    body: `Install ${names.provider} on ${names.destination} first. Copying a profile never installs anything.`,
  }),
  "unsupported-platform": (names) => ({
    badge: "Not supported",
    tone: "muted",
    body: `Copying ${names.provider} profiles isn't supported on ${names.destination}'s platform.`,
  }),
  "unsupported-auth": (names) => ({
    badge: "Can't be copied",
    tone: "muted",
    body: `This profile's sign-in type can't be copied to ${names.destination}.`,
  }),
  "adapter-not-admitted": (names) => ({
    badge: "Not available yet",
    tone: "muted",
    body: `Copying this ${names.provider} account to ${names.destination} isn't available yet.`,
  }),
  "manual-login-unavailable": (names) => ({
    badge: "Not available yet",
    tone: "muted",
    body: `Signing in to ${names.provider} on ${names.destination} from here isn't available yet.`,
  }),
  "destination-local-login-required": (names) => ({
    badge: `Needs ${names.destination} itself`,
    tone: "muted",
    body: `Signing in to ${names.provider} has to happen in Traycer on ${names.destination} itself. That isn't available from here.`,
  }),
  "device-auth-unavailable": (names) => ({
    badge: "Device code off",
    tone: "warning",
    body: `Device-code sign-in isn't turned on for this ${names.provider} account. Turn it on in the account's security settings, then check again.`,
  }),
  "login-resource-busy": (names) => ({
    badge: "Sign-in blocked",
    tone: "warning",
    body: profileCopySharedResourceCopy(names),
  }),
  "login-start-unavailable": (names) => ({
    badge: "Can't start sign-in",
    tone: "warning",
    body: `Sign-in couldn't start on ${names.destination} right now.`,
  }),
  "writer-unconfirmed": (names) => ({
    badge: "Interrupted — retry required",
    tone: "destructive",
    body: `The copy to ${names.destination} was interrupted before Traycer could confirm it finished safely.`,
  }),
  "credential-invalid": (names) => ({
    badge: "Credential rejected",
    tone: "warning",
    body: `${names.provider} rejected the copied credential.`,
  }),
  "credential-missing": (names) => ({
    badge: "Key missing",
    tone: "warning",
    body: `This profile's API key can't be read on ${names.source}. Add it in Manage profile, then check again.`,
  }),
  "credential-malformed": (names) => ({
    badge: "Key unreadable",
    tone: "warning",
    body: `This profile's API key on ${names.source} isn't in a form ${names.provider} accepts. Replace it in Manage profile, then check again.`,
  }),
  "verification-unavailable": (names) => ({
    badge: "Not checked",
    tone: "warning",
    body: `${names.provider} couldn't check the credential on ${names.destination}.`,
  }),
  "verification-timeout": (names) => ({
    badge: "Check timed out",
    tone: "warning",
    body: `${names.provider} didn't answer the check on ${names.destination} in time.`,
  }),
  "provider-unavailable": (names) => ({
    badge: "Provider unavailable",
    tone: "warning",
    body: `${names.provider} isn't available on ${names.destination} right now.`,
  }),
  "identity-unavailable": (names) => ({
    badge: "Account unknown",
    tone: "warning",
    body: `${names.provider} can't tell which account this credential belongs to.`,
  }),
  "identity-mismatch": (names) => ({
    badge: "Different account",
    tone: "warning",
    body: `${names.destination} is signed in to a different ${names.provider} account than “${names.profile}”.`,
  }),
  "source-changed": (names) => ({
    badge: "Profile changed",
    tone: "warning",
    body: `“${names.profile}” was changed or removed on ${names.source} after the check. Start a new copy.`,
  }),
  "stale-revision": (names) => ({
    badge: "Changed",
    tone: "muted",
    body: `This changed on ${names.destination} since you last looked. Review it again.`,
  }),
  "request-conflict": (names) => ({
    badge: "Changed",
    tone: "muted",
    body: `This changed on ${names.destination} since you last looked. Review it again.`,
  }),
  "target-removed": (names) => ({
    badge: "Removed",
    tone: "muted",
    body: `The copied profile was later removed from ${names.destination}. It won't be recreated.`,
  }),
  cancelled: (names) => ({
    badge: "Cancelled",
    tone: "muted",
    body: `Nothing was added to ${names.destination}.`,
  }),
  "internal-error": (names) => ({
    badge: "Something went wrong",
    tone: "warning",
    body: `${names.destination} gave an unexpected answer.`,
  }),
};

/** One sentence per wire reason. `null` is "the host gave no reason". */
export function profileCopyReasonCopy(
  reason: ProfileCopyReason | null,
  names: ProfileCopyNames,
): ProfileCopyReasonCopy {
  if (reason === null) {
    return {
      badge: "Couldn't check",
      tone: "warning",
      body: `${names.source} couldn't tell whether ${names.destination} can receive this profile.`,
    };
  }
  return REASON_COPY[reason](names);
}

/** What the user can do about a preview row from this dialog. */
export type ProfileCopyPreviewRemedy = "check-again" | "set-up" | null;

/**
 * One remedy per wire reason, exhaustive by type: a reason the wire adds
 * later fails to compile here rather than falling through to "none".
 */
const PREVIEW_REMEDY: {
  readonly [R in ProfileCopyReason]: ProfileCopyPreviewRemedy;
} = {
  "install-required": "set-up",
  "update-required": "check-again",
  unreachable: "check-again",
  "directory-unavailable": "check-again",
  "device-auth-unavailable": "check-again",
  "login-resource-busy": "check-again",
  "login-start-unavailable": "check-again",
  "credential-missing": "check-again",
  "credential-malformed": "check-again",
  "provider-unavailable": "check-again",
  "internal-error": "check-again",
  "unsupported-platform": null,
  "unsupported-auth": null,
  "adapter-not-admitted": null,
  "manual-login-unavailable": null,
  "destination-local-login-required": null,
  "writer-unconfirmed": null,
  "credential-invalid": null,
  "verification-unavailable": null,
  "verification-timeout": null,
  "identity-unavailable": null,
  "identity-mismatch": null,
  "source-changed": null,
  "stale-revision": null,
  "request-conflict": null,
  "target-removed": null,
  cancelled: null,
};

function previewRemedy(
  reason: ProfileCopyReason | null,
): ProfileCopyPreviewRemedy {
  return reason === null ? "check-again" : PREVIEW_REMEDY[reason];
}

export interface ProfileCopyPreviewPresentation {
  readonly badge: string;
  readonly tone: ProfileCopyTone;
  readonly body: string;
  readonly remedy: ProfileCopyPreviewRemedy;
  /** A second line that never blocks the copy (destination policy kept). */
  readonly note: string | null;
}

function providerDisabledNote(
  record: ProfileCopyPreviewRecord,
  names: ProfileCopyNames,
): string | null {
  return record.destinationProviderEnabled === false
    ? `${names.provider} is turned off on ${names.destination}. The copy is added but stays unused until you turn ${names.provider} on there.`
    : null;
}

/** How a manual sign-in will go, per wire route, exhaustive by type. */
const MANUAL_ROUTE_PREVIEW_BODY: {
  readonly [R in ProfileCopyManualRoute]: (names: ProfileCopyNames) => string;
} = {
  "code-paste": (names) =>
    `You'll open ${names.provider}'s sign-in page and paste the code it shows.`,
  "device-code": (names) =>
    `You'll enter a short code on ${names.provider}'s sign-in page.`,
  "destination-local-browser": (names) =>
    `Sign-in finishes in Traycer on ${names.destination} itself.`,
};

export function presentProfileCopyPreview(
  record: ProfileCopyPreviewRecord,
  names: ProfileCopyNames,
): ProfileCopyPreviewPresentation {
  const note = providerDisabledNote(record, names);
  switch (record.disposition) {
    case "automatic":
      return {
        badge: "Signs in automatically",
        tone: "success",
        body: `Traycer can sign ${names.destination} in without you.`,
        remedy: null,
        note,
      };
    case "manual": {
      const body =
        record.manualRoute === null
          ? `You'll finish signing in to ${names.provider} for ${names.destination} from here.`
          : MANUAL_ROUTE_PREVIEW_BODY[record.manualRoute](names);
      return {
        badge: `Sign in on ${names.destination}`,
        tone: "info",
        body,
        remedy: null,
        note,
      };
    }
    case "already-present":
      return {
        badge: "Already there",
        tone: "muted",
        body: `${names.destination} already has this ${names.provider} account. Nothing will change.`,
        remedy: null,
        note,
      };
    case "unavailable": {
      const copy = profileCopyReasonCopy(record.reason, names);
      return {
        badge: copy.badge,
        tone: copy.tone,
        body: copy.body,
        remedy: previewRemedy(record.reason),
        note,
      };
    }
  }
}

export interface ProfileCopyOutcomePresentation {
  readonly badge: string;
  readonly tone: ProfileCopyTone;
  readonly body: string;
  /** A second line: provider policy on the destination, an unverified mark. */
  readonly note: string | null;
}

export interface ProfileCopyOutcomeContext {
  readonly names: ProfileCopyNames;
  /** How the destination was previewed, or `null` when this window never saw it. */
  readonly route: ProfileCopyKnownRoute;
  /** The source confirmed a cancel this window sent for the whole operation. */
  readonly cancelRequested: boolean;
}

function outcomeNote(
  outcome: ProfileCopyOutcome,
  names: ProfileCopyNames,
): string | null {
  return outcome.destinationProviderEnabled
    ? null
    : `${names.provider} is turned off on ${names.destination}.`;
}

function signInRequiredPresentation(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  const { names } = context;
  if (context.route === "automatic") {
    return {
      badge: "Sign-in required — credential rejected",
      tone: "warning",
      body: `${names.provider} rejected the copied key on ${names.destination}. Cancel this device, then copy again with a working key.`,
      note: outcomeNote(outcome, names),
    };
  }
  return {
    badge:
      outcome.reason === "credential-invalid"
        ? "Sign-in required — credential rejected"
        : "Sign-in required",
    tone: "info",
    body: `Sign in on ${names.destination} to finish. The name and color are already set.`,
    note: outcomeNote(outcome, names),
  };
}

function verificationPendingPresentation(
  outcome: ProfileCopyOutcome,
  names: ProfileCopyNames,
): ProfileCopyOutcomePresentation {
  if (outcome.readiness.verification === "indeterminate") {
    const why =
      outcome.reason === "verification-timeout"
        ? "timed out"
        : "wasn't available";
    return {
      badge: "Verification pending",
      tone: "warning",
      body: `${names.provider}'s check on ${names.destination} ${why}. Check again, or add the profile without verification — it stays marked as not verified.`,
      note: outcomeNote(outcome, names),
    };
  }
  return {
    badge: "Verification pending",
    tone: "warning",
    body: `The credential is on ${names.destination} but hasn't been checked yet.`,
    note: outcomeNote(outcome, names),
  };
}

function accountConfirmationPresentation(
  outcome: ProfileCopyOutcome,
  names: ProfileCopyNames,
): ProfileCopyOutcomePresentation {
  const unverified =
    outcome.readiness.acceptedVerificationRevision !== null
      ? "The credential was never successfully checked."
      : null;
  if (outcome.readiness.identity === "mismatch") {
    return {
      badge: "Different account",
      tone: "warning",
      body: `${names.destination} is signed in to a different ${names.provider} account than “${names.profile}” on ${names.source}. Keep it as its own profile, or sign in again with the original account.`,
      note: unverified,
    };
  }
  return {
    badge: "Confirm the account",
    tone: "warning",
    body: `${names.provider} can't tell which account this credential belongs to. Add it only if you trust the copied credential.`,
    note: unverified,
  };
}

function blockedPresentation(
  outcome: ProfileCopyOutcome,
  names: ProfileCopyNames,
): ProfileCopyOutcomePresentation {
  const copy = profileCopyReasonCopy(outcome.reason, names);
  if (!isRecordedOutcome(outcome)) {
    return {
      badge: "Not sent",
      tone: "warning",
      body: `Nothing was sent. ${copy.body}`,
      note: null,
    };
  }
  if (outcome.reason === "unsupported-auth") {
    return {
      badge: "Refused",
      tone: "warning",
      body: refusedSettingsCopy(names),
      note: null,
    };
  }
  if (outcome.reason === "verification-unavailable") {
    return {
      badge: "Not checked",
      tone: "warning",
      body: `Sign-in finished on ${names.destination}, but ${names.provider} couldn't check it.`,
      note: null,
    };
  }
  return { badge: copy.badge, tone: copy.tone, body: copy.body, note: null };
}

/** The destination verbs a direct `blocked` answer can refuse. */
export type ProfileCopyDirectVerb = "sign-in" | "verify";

/**
 * A direct answer that refused one verb at one draft revision. The host never
 * persists these, so the next read shows only the draft's state; this is what
 * remembers which click was refused, and why.
 */
export interface ProfileCopyDirectBlock {
  readonly verb: ProfileCopyDirectVerb;
  readonly revision: number;
  readonly reason: ProfileCopyReason | null;
  /** Consecutive identical answers (same verb, same reason) for this attempt. */
  readonly repeats: number;
}

/**
 * The shared-resource rule: `login-resource-busy`, and
 * `login-start-unavailable` once the same verb has been refused with it twice
 * in a row - a second identical refusal is not a blip.
 */
export function isSharedResourceBlock(block: ProfileCopyDirectBlock): boolean {
  return (
    block.reason === "login-resource-busy" ||
    (block.reason === "login-start-unavailable" && block.repeats >= 2)
  );
}

function verifyBlockCopy(
  block: ProfileCopyDirectBlock,
  names: ProfileCopyNames,
): string {
  if (block.reason === "unsupported-auth") return refusedSettingsCopy(names);
  if (block.reason === "login-start-unavailable") {
    return `Verify couldn't start on ${names.destination} right now. Try again.`;
  }
  return `Verify can't run on ${names.destination} right now. ${profileCopyReasonCopy(block.reason, names).body}`;
}

/**
 * Why a sign-in that DID reserve a login job (a `loginAttemptId` came back)
 * ended before any challenge. `login-start-unavailable` there is the login
 * path's name for a configuration refusal (T5 contract 8), so its recovery is
 * the refusal's: cancel and copy again. It never counts toward the
 * shared-resource rule, whose repeats are about a start the host refused
 * outright.
 */
export function profileCopyStartRefusalCopy(
  reason: ProfileCopyReason,
  names: ProfileCopyNames,
): string {
  if (reason === "login-start-unavailable") {
    return `Sign-in couldn't start on ${names.destination}: it may not accept the copied ${names.provider} settings. Cancel this device and copy again.`;
  }
  return profileCopyReasonCopy(reason, names).body;
}

/** Why the user's own click was refused, worded for the verb they clicked. */
export function profileCopyDirectBlockCopy(
  block: ProfileCopyDirectBlock,
  names: ProfileCopyNames,
): string {
  if (isSharedResourceBlock(block)) return profileCopySharedResourceCopy(names);
  if (block.verb === "verify") return verifyBlockCopy(block, names);
  return profileCopyReasonCopy(block.reason, names).body;
}

function directBlockBadge(
  block: ProfileCopyDirectBlock,
  names: ProfileCopyNames,
): string {
  if (block.verb === "sign-in") {
    return isSharedResourceBlock(block)
      ? "Sign-in blocked"
      : profileCopyReasonCopy(block.reason, names).badge;
  }
  return block.reason === "unsupported-auth" ? "Refused" : "Can't verify now";
}

/**
 * A recorded `blocked` row that is the answer to the user's own click: the
 * same facts as `presentProfileCopyOutcome`, worded for the verb that was
 * refused rather than for the reason alone.
 */
export function presentProfileCopyDirectBlock(
  outcome: ProfileCopyOutcome,
  block: ProfileCopyDirectBlock,
  names: ProfileCopyNames,
): ProfileCopyOutcomePresentation {
  return {
    badge: directBlockBadge(block, names),
    tone: "warning",
    body: profileCopyDirectBlockCopy(block, names),
    note: outcomeNote(outcome, names),
  };
}

type OutcomePresenter = (
  outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
) => ProfileCopyOutcomePresentation;

function preparingPresentation(
  _outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  const d = context.names.destination;
  if (context.cancelRequested) {
    return {
      badge: "Cancelling…",
      tone: "muted",
      body: `Cancelling — waiting for ${d} to answer.`,
      note: null,
    };
  }
  return {
    badge: "Copying…",
    tone: "muted",
    body: `Sending “${context.names.profile}” to ${d}.`,
    note: null,
  };
}

function failedPresentation(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  const d = context.names.destination;
  if (isRecordedOutcome(outcome)) {
    return {
      badge: "Failed",
      tone: "destructive",
      body: `The copy to ${d} failed. Nothing was added.`,
      note: null,
    };
  }
  return {
    badge: "Not sent yet",
    tone: "muted",
    body: `Nothing has reached ${d} yet. ${context.names.source} sends it on its next check.`,
    note: null,
  };
}

function outcomeUnknownPresentation(
  _outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  const d = context.names.destination;
  if (context.cancelRequested) {
    return {
      badge: "Cancelling…",
      tone: "muted",
      body: `${d} hasn't confirmed the cancel yet. It may be offline. Traycer keeps checking while this window is open.`,
      note: null,
    };
  }
  return {
    badge: `Waiting for ${d}`,
    tone: "muted",
    body: `Sent to ${d}, but it hasn't confirmed. It may already be there. Traycer keeps checking and won't send it again unless ${d} confirms nothing arrived.`,
    note: null,
  };
}

function signedInPresentation(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  const { names } = context;
  const d = names.destination;
  return {
    badge: "Signed in",
    tone: "success",
    body:
      outcome.targetEnabled === false
        ? `Added to ${d} as “${names.profile}”. It's turned off — turn it on in Settings on ${d}.`
        : `Added to ${d} as “${names.profile}”. Agents can use it.`,
    note: outcomeNote(outcome, names),
  };
}

/** One presenter per wire state, exhaustive by type. */
const OUTCOME_PRESENTERS: {
  readonly [S in ProfileCopyOutcome["state"]]: OutcomePresenter;
} = {
  preparing: preparingPresentation,
  failed: failedPresentation,
  "outcome-unknown": outcomeUnknownPresentation,
  "sign-in-required": signInRequiredPresentation,
  "signing-in": (outcome, context) => ({
    badge: `Signing in on ${context.names.destination}`,
    tone: "info",
    body: `A sign-in is in progress on ${context.names.destination}.`,
    note: outcomeNote(outcome, context.names),
  }),
  verifying: (_outcome, context) => ({
    badge: "Checking",
    tone: "muted",
    body: `Checking the credential on ${context.names.destination}. This takes up to a minute.`,
    note: null,
  }),
  "verification-pending": (outcome, context) =>
    verificationPendingPresentation(outcome, context.names),
  "account-confirmation-required": (outcome, context) =>
    accountConfirmationPresentation(outcome, context.names),
  ready: (_outcome, context) => ({
    badge: "Finishing",
    tone: "muted",
    body: `Adding “${context.names.profile}” on ${context.names.destination}…`,
    note: null,
  }),
  "signed-in": signedInPresentation,
  "used-without-verification": (outcome, context) => ({
    badge: "Added — not verified",
    tone: "warning",
    body: `Added to ${context.names.destination} without a successful check. Agents may fail to start with it until the credential works.`,
    note: outcomeNote(outcome, context.names),
  }),
  "already-present": (_outcome, context) => ({
    badge: `Already on ${context.names.destination}`,
    tone: "muted",
    body: `${context.names.destination} already has this ${context.names.provider} account. Nothing was changed.`,
    note: null,
  }),
  blocked: (outcome, context) => blockedPresentation(outcome, context.names),
  cancelled: (_outcome, context) => ({
    badge: "Cancelled",
    tone: "muted",
    body: `Nothing was added to ${context.names.destination}.`,
    note: null,
  }),
  quarantined: (_outcome, context) => ({
    badge: "Interrupted — retry required",
    tone: "destructive",
    body: `The copy to ${context.names.destination} was interrupted before Traycer could confirm it finished safely. The partial copy stays set aside on ${context.names.destination} and is never reused. Retry makes a fresh copy.`,
    note: null,
  }),
  removed: (_outcome, context) => ({
    badge: "Removed",
    tone: "muted",
    body: `The copied profile was later removed from ${context.names.destination}. It won't be recreated.`,
    note: null,
  }),
};

/**
 * Title, tone and body for one outcome, as the matrix in the T6 design lists
 * them. Actions are separate: source-side recovery is
 * `profileCopySourceRecovery`, destination actions `profileCopyDraftActions`.
 */
export function presentProfileCopyOutcome(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  return OUTCOME_PRESENTERS[outcome.state](outcome, context);
}

export type ProfileCopyDraftActionKind =
  | "sign-in"
  | "continue-sign-in"
  | "cancel-sign-in"
  | "verify"
  | "use-without-verification"
  | "keep-account"
  | "add-without-confirming"
  | "cancel-draft"
  | "open-profile";

export interface ProfileCopyDraftAction {
  readonly kind: ProfileCopyDraftActionKind;
  readonly label: string;
}

export interface ProfileCopyDraftActions {
  readonly primary: ProfileCopyDraftAction | null;
  readonly secondary: readonly ProfileCopyDraftAction[];
}

export interface ProfileCopyDraftActionContext {
  readonly destinationName: string;
  readonly route: ProfileCopyKnownRoute;
  /**
   * The direct refusal recorded for this draft AT ITS CURRENT REVISION, or
   * `null` (Q4 ruling: a refusal is a fact about one revision, never
   * persisted). Which verb it refused decides what is offered next.
   */
  readonly directBlock: ProfileCopyDirectBlock | null;
  /**
   * The reason a sign-in that reserved a login job ended before any
   * challenge, held by the login flow until its next start, or `null`. Not
   * bound to a revision: the host moved it to reserve and complete the
   * login writer, so the re-read is always newer.
   */
  readonly startRefusal: ProfileCopyReason | null;
}

/** Route reasons: a sign-in answered with one of these cannot succeed now. */
const ROUTE_CLOSED_REASONS: ReadonlySet<ProfileCopyReason> = new Set([
  "adapter-not-admitted",
  "manual-login-unavailable",
  "destination-local-login-required",
  "device-auth-unavailable",
  "unsupported-platform",
  "unsupported-auth",
]);

export function isRouteClosedReason(reason: ProfileCopyReason | null): boolean {
  return reason !== null && ROUTE_CLOSED_REASONS.has(reason);
}

/**
 * Whether a started-then-refused sign-in takes Sign in away until the next
 * start: a route reason, or contract 8's configuration refusal, whose
 * recovery is cancel and copy again.
 */
export function startRefusalWithdrawsSignIn(
  reason: ProfileCopyReason | null,
): boolean {
  return reason === "login-start-unavailable" || isRouteClosedReason(reason);
}

const NO_DRAFT_ACTIONS: ProfileCopyDraftActions = {
  primary: null,
  secondary: [],
};

const CANCEL_DRAFT: ProfileCopyDraftAction = {
  kind: "cancel-draft",
  label: "Cancel this device",
};

const CANCEL_ONLY: ProfileCopyDraftActions = {
  primary: CANCEL_DRAFT,
  secondary: [],
};

/**
 * Sign-in was refused with a route reason (withdrawn for this revision), or a
 * started sign-in ended in a refusal a new start cannot get past (withdrawn
 * until the next start).
 */
function signInWithdrawn(context: ProfileCopyDraftActionContext): boolean {
  const block = context.directBlock;
  const blockWithdraws =
    block !== null &&
    block.verb === "sign-in" &&
    isRouteClosedReason(block.reason);
  return blockWithdraws || startRefusalWithdrawsSignIn(context.startRefusal);
}

/** Verify refused the configuration: withdrawn for this revision. */
function verifyRefused(context: ProfileCopyDraftActionContext): boolean {
  const block = context.directBlock;
  return (
    block !== null &&
    block.verb === "verify" &&
    block.reason === "unsupported-auth"
  );
}

/** Sign in is offered unless the route is automatic or it was withdrawn. */
function signInOffered(context: ProfileCopyDraftActionContext): boolean {
  return context.route !== "automatic" && !signInWithdrawn(context);
}

function signInRequiredActions(
  _outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
): ProfileCopyDraftActions {
  if (!signInOffered(context)) return CANCEL_ONLY;
  return {
    primary: {
      kind: "sign-in",
      label: `Sign in on ${context.destinationName}`,
    },
    secondary: [CANCEL_DRAFT],
  };
}

function verificationPendingActions(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
): ProfileCopyDraftActions {
  if (verifyRefused(context)) return CANCEL_ONLY;
  const verifiedBefore =
    outcome.readiness.verification !== "not-checked" ||
    context.directBlock?.verb === "verify";
  const indeterminate =
    outcome.readiness.verification === "indeterminate" &&
    outcome.readiness.verificationRevision !== null;
  const secondary: ProfileCopyDraftAction[] = indeterminate
    ? [
        {
          kind: "use-without-verification",
          label: "Use without verification",
        },
      ]
    : [];
  secondary.push(CANCEL_DRAFT);
  return {
    primary: {
      kind: "verify",
      label: verifiedBefore ? "Verify again" : "Verify",
    },
    secondary,
  };
}

function accountConfirmationActions(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
): ProfileCopyDraftActions {
  if (outcome.readiness.identityRevision === null) return CANCEL_ONLY;
  if (outcome.readiness.identity === "mismatch") {
    const secondary: ProfileCopyDraftAction[] = signInOffered(context)
      ? [{ kind: "sign-in", label: "Sign in again" }]
      : [];
    secondary.push(CANCEL_DRAFT);
    return {
      primary: { kind: "keep-account", label: "Keep this account" },
      secondary,
    };
  }
  if (outcome.readiness.identity === "unavailable") {
    return {
      primary: {
        kind: "add-without-confirming",
        label: "Add without confirming account",
      },
      secondary: [CANCEL_DRAFT],
    };
  }
  return CANCEL_ONLY;
}

/** Recorded-block reasons a fresh sign-in can get past. */
const SIGN_IN_RETRYABLE_BLOCK_REASONS: ReadonlySet<ProfileCopyReason> = new Set(
  [
    "verification-unavailable",
    "login-resource-busy",
    "login-start-unavailable",
  ],
);

/**
 * A Verify the user clicked was refused before any check ran (T5 contracts 5
 * and 7). Verify is offered again - never Sign in, which is not what they
 * asked for - unless the configuration itself was refused.
 */
function verifyBlockedActions(
  block: ProfileCopyDirectBlock,
): ProfileCopyDraftActions {
  if (block.reason === "unsupported-auth") return CANCEL_ONLY;
  return {
    primary: { kind: "verify", label: "Verify again" },
    secondary: [CANCEL_DRAFT],
  };
}

function blockedActions(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
): ProfileCopyDraftActions {
  if (!isRecordedOutcome(outcome)) return NO_DRAFT_ACTIONS;
  const block = context.directBlock;
  if (block !== null && block.verb === "verify") {
    return verifyBlockedActions(block);
  }
  const reason = outcome.reason;
  if (
    reason === null ||
    !SIGN_IN_RETRYABLE_BLOCK_REASONS.has(reason) ||
    !signInOffered(context)
  ) {
    return CANCEL_ONLY;
  }
  return {
    primary: {
      kind: "sign-in",
      label:
        reason === "verification-unavailable"
          ? "Sign in again"
          : "Try sign-in again",
    },
    secondary: [CANCEL_DRAFT],
  };
}

const OPEN_PROFILE: ProfileCopyDraftActions = {
  primary: { kind: "open-profile", label: "Open profile" },
  secondary: [],
};

type DraftActionsBuilder = (
  outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
) => ProfileCopyDraftActions;

/** One builder per wire state, exhaustive by type. */
const DRAFT_ACTIONS: {
  readonly [S in ProfileCopyOutcome["state"]]: DraftActionsBuilder;
} = {
  preparing: () => ({ primary: null, secondary: [CANCEL_DRAFT] }),
  verifying: () => ({ primary: null, secondary: [CANCEL_DRAFT] }),
  "sign-in-required": signInRequiredActions,
  "signing-in": (_outcome, context) => ({
    primary: { kind: "continue-sign-in", label: "Continue sign-in" },
    secondary: [
      {
        kind: "cancel-sign-in",
        label: `Cancel copy to ${context.destinationName}`,
      },
    ],
  }),
  "verification-pending": verificationPendingActions,
  "account-confirmation-required": accountConfirmationActions,
  blocked: blockedActions,
  "signed-in": () => OPEN_PROFILE,
  "used-without-verification": () => OPEN_PROFILE,
  "already-present": () => OPEN_PROFILE,
  ready: () => NO_DRAFT_ACTIONS,
  failed: () => NO_DRAFT_ACTIONS,
  "outcome-unknown": () => NO_DRAFT_ACTIONS,
  cancelled: () => NO_DRAFT_ACTIONS,
  quarantined: () => NO_DRAFT_ACTIONS,
  removed: () => NO_DRAFT_ACTIONS,
};

/**
 * The destination actions one outcome offers. Every action here dials the
 * DESTINATION host; source-side recovery (retry, copy again) is not a draft
 * action. Nothing here ever repeats itself: each is one user click.
 */
export function profileCopyDraftActions(
  outcome: ProfileCopyOutcome,
  context: ProfileCopyDraftActionContext,
): ProfileCopyDraftActions {
  return DRAFT_ACTIONS[outcome.state](outcome, context);
}

/** States in which the draft is still open, per wire state, exhaustive by type. */
const PREFERENCE_EDITABLE: { readonly [S in ProfileCopyState]: boolean } = {
  preparing: true,
  "sign-in-required": true,
  "signing-in": true,
  verifying: true,
  "verification-pending": true,
  "account-confirmation-required": true,
  failed: false,
  "outcome-unknown": false,
  ready: false,
  "signed-in": false,
  "used-without-verification": false,
  "already-present": false,
  blocked: false,
  cancelled: false,
  quarantined: false,
  removed: false,
};

/** Whether the "use it once ready" preference still means anything. */
export function profileCopyPreferenceEditable(
  outcome: ProfileCopyOutcome,
): boolean {
  return isRecordedOutcome(outcome) && PREFERENCE_EDITABLE[outcome.state];
}

/** What `providers.list` on the destination says about the account it had. */
export interface ProfileCopyExistingProfileState {
  readonly enabled: boolean;
  readonly authStatus: ProviderAuthStatus;
}

const EXISTING_AUTH_WORDS: {
  readonly [S in ProviderAuthStatus]: string | null;
} = {
  authenticated: "Signed in",
  unauthenticated: "Signed out",
  configured: "Configured, not verified",
  unavailable: "Status check failed",
  unknown: null,
};

/**
 * The already-present account's real state on the destination, e.g.
 * "Enabled · Signed in". Display of facts the destination's own list states;
 * nothing here decides anything.
 */
export function profileCopyExistingProfileFacts(
  state: ProfileCopyExistingProfileState,
): string {
  const enabled = state.enabled ? "Enabled" : "Turned off";
  const auth = EXISTING_AUTH_WORDS[state.authStatus];
  return auth === null ? enabled : `${enabled} · ${auth}`;
}
