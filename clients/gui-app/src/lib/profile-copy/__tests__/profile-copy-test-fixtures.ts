import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  ProfileCopyAttempt,
  ProfileCopyIncomingDraft,
  ProfileCopyOutcome,
  ProfileCopyPreviewRecord,
} from "@/lib/profile-copy/profile-copy-model";
import type { ProfileCopyNames } from "@/lib/profile-copy/profile-copy-presentation";

/** Synthetic ids — never account identifiers. */
export const SOURCE_HOST_ID = "source-host";
export const DEST_HOST_ID = "dest-host";
export const DEST_HOST_TWO_ID = "dest-host-two";
export const SCOPED_HOST_ID = "settings-scoped-host";
export const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
export const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
export const ATTEMPT_TWO_ID = "55555555-5555-4555-8555-555555555555";
export const SOURCE_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
export const TARGET_PROFILE_ID = "44444444-4444-4444-8444-444444444444";
export const LOGIN_ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
export const RETRY_REQUEST_ID = "77777777-7777-4777-8777-777777777777";
export const RETRY_REQUEST_ID_TWO = "88888888-8888-4888-8888-888888888888";
export const PREVIEW_REVISION = "a".repeat(64);

export const COPY_NAMES: ProfileCopyNames = {
  source: "Studio Mac",
  destination: "Linux box",
  provider: "Claude Code",
  profile: "Work",
};

export function profileCopyAttempt(
  overrides: Partial<ProfileCopyAttempt>,
): ProfileCopyAttempt {
  return {
    sourceHostId: SOURCE_HOST_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    providerId: "claude",
    operationId: OPERATION_ID,
    attemptId: ATTEMPT_ID,
    destinationHostId: DEST_HOST_ID,
    ...overrides,
  };
}

function defaultReadiness(): ProfileCopyOutcome["readiness"] {
  return {
    preparation: "incomplete",
    verification: "not-checked",
    verificationRevision: null,
    acceptedVerificationRevision: null,
    identity: "not-checked",
    identityRevision: null,
    acceptedIdentityRevision: null,
    writer: "none",
    writerGeneration: 0,
    quarantined: false,
  };
}

export function profileCopyOutcome(
  overrides: Partial<ProfileCopyOutcome>,
): ProfileCopyOutcome {
  return {
    attempt: profileCopyAttempt({}),
    revision: 1,
    state: "preparing",
    reason: null,
    targetProfileId: null,
    targetEnabled: null,
    targetAuthStatus: null,
    replacementAttemptId: null,
    desiredEnabled: true,
    destinationProviderEnabled: true,
    readiness: defaultReadiness(),
    ...overrides,
  };
}

export function recordedOutcome(
  overrides: Partial<ProfileCopyOutcome>,
): ProfileCopyOutcome {
  return profileCopyOutcome({
    targetProfileId: TARGET_PROFILE_ID,
    ...overrides,
  });
}

export function incomingDraft(
  overrides: Partial<ProfileCopyIncomingDraft>,
): ProfileCopyIncomingDraft {
  return {
    metadata: {
      name: "Work",
      color: "#3b82f6",
      desiredEnabled: true,
      skillsPluginsShared: false,
    },
    outcome: recordedOutcome({ state: "sign-in-required" }),
    ...overrides,
  };
}

export function previewRecord(
  overrides: Partial<ProfileCopyPreviewRecord>,
): ProfileCopyPreviewRecord {
  return {
    destinationHostId: DEST_HOST_ID,
    disposition: "automatic",
    reason: null,
    manualRoute: null,
    destinationProviderEnabled: true,
    ...overrides,
  };
}

export function hostDirectoryEntry(
  hostId: string,
  label: string,
): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "remote",
    websocketUrl: `ws://${hostId}.invalid/rpc`,
    version: "test",
    transportDialability: "dialable",
  };
}
