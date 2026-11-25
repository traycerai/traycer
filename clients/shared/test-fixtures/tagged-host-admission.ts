import {
  clientHandshakeIdentitySchema,
  isValidCompatibilityEpoch,
  LEGACY_CLIENT_COMPATIBILITY_EPOCH,
  type ClientCompatibilityRequirement,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";

/**
 * Source-backed physical-host policies. The released endpoint tags and the
 * intervening tags are listed in closure-d3-app.md A2: host-v1.4.0 through
 * host-v1.5.4 use epoch 2 and a person bearer on physical computers; only
 * host-v1.5.2 through host-v1.5.4 also reserve authz v2 for sandbox sessions.
 * The current packaged policy is the checked-in HEAD floor and own-host-token
 * path. These are source fixtures, not executions of packaged binaries.
 *
 * Source locations in the internal repository:
 * - scripts/native-packaging/host-client-floor.json at host-v1.4.0,
 *   host-v1.5.1, host-v1.5.2, host-v1.5.4 and HEAD;
 * - traycer-host/src/transport/remote/remote-client-session.ts at
 *   host-v1.4.0:1010-1039, host-v1.5.2:1177-1228, and HEAD:1225-1243;
 * - traycer-host/src/transport/rpc/bootstrap.ts at host-v1.5.4:4614-4664
 *   and traycer-host/src/config.ts:332 for the released loopback audience.
 */
export interface TaggedHostAdmissionFixture {
  readonly line: string;
  readonly minimumEpoch: number;
  readonly remotePersonCredential: "user-bearer" | "own-host-token";
  readonly loopbackAudience: "traycer" | "host";
}

export const CURRENT_PACKAGED_HOST_ADMISSION_FIXTURE: TaggedHostAdmissionFixture =
  {
    line: "current packaged HEAD",
    minimumEpoch: 3,
    remotePersonCredential: "own-host-token",
    loopbackAudience: "host",
  };

export const TAGGED_HOST_ADMISSION_FIXTURES: readonly TaggedHostAdmissionFixture[] =
  [
    {
      line: "host-v1.4.0–host-v1.5.1",
      minimumEpoch: 2,
      remotePersonCredential: "user-bearer",
      loopbackAudience: "traycer",
    },
    {
      line: "host-v1.5.2–host-v1.5.4",
      minimumEpoch: 2,
      remotePersonCredential: "user-bearer",
      loopbackAudience: "traycer",
    },
    CURRENT_PACKAGED_HOST_ADMISSION_FIXTURE,
  ];

export interface RemoteOpenObservation {
  readonly bearer: string;
  readonly authz: unknown;
  readonly clientIdentity: unknown;
}

export type TaggedHostAdmissionDecision =
  | { readonly kind: "ack" }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails };

export function admitTaggedRemoteOpen(
  fixture: TaggedHostAdmissionFixture,
  open: RemoteOpenObservation,
): TaggedHostAdmissionDecision {
  const epochFatal = epochRejection(fixture, open.clientIdentity);
  if (epochFatal !== null) return { kind: "fatal", details: epochFatal };

  const authz = objectRecord(open.authz);
  const authzVersion = authz === null ? null : Reflect.get(authz, "v");
  const grant = authz === null ? null : Reflect.get(authz, "grant");
  const presentsHostTokenV2 =
    open.bearer === "" &&
    authzVersion === 2 &&
    typeof grant === "string" &&
    grant.length > 0;
  if (
    presentsHostTokenV2 &&
    fixture.remotePersonCredential === "own-host-token"
  ) {
    return { kind: "ack" };
  }
  if (
    (open.authz === null || open.authz === undefined) &&
    typeof open.bearer === "string" &&
    open.bearer.length > 0 &&
    fixture.remotePersonCredential === "user-bearer"
  ) {
    return { kind: "ack" };
  }
  return { kind: "fatal", details: unauthorizedDetails };
}

export function admitTaggedLoopbackOpen(
  fixture: TaggedHostAdmissionFixture,
  identityValue: unknown,
  token: string,
  tokenAudience: "traycer" | "host",
): TaggedHostAdmissionDecision {
  const epochFatal = epochRejection(fixture, identityValue);
  if (epochFatal !== null) return { kind: "fatal", details: epochFatal };
  return token.length > 0 && tokenAudience === fixture.loopbackAudience
    ? { kind: "ack" }
    : { kind: "fatal", details: unauthorizedDetails };
}

function epochRejection(
  fixture: TaggedHostAdmissionFixture,
  identityValue: unknown,
): FatalErrorDetails | null {
  const parsed = clientHandshakeIdentitySchema.safeParse(identityValue);
  const identity = parsed.success ? parsed.data : undefined;
  const epoch = identity?.compatibilityEpoch ?? null;
  const observedEpoch = epoch ?? LEGACY_CLIENT_COMPATIBILITY_EPOCH;
  const valid = isValidCompatibilityEpoch(observedEpoch);
  if (valid && observedEpoch >= fixture.minimumEpoch) return null;

  const requirement: ClientCompatibilityRequirement = {
    minimumCompatibilityEpoch: fixture.minimumEpoch,
    observedCompatibilityEpoch: epoch,
    failure: epochFailure(epoch, valid),
    observedClientKind: identity?.kind ?? null,
    observedClientAppVersion: identity?.appVersion ?? null,
    observedClientAppVersionStatus:
      identity?.appVersion === undefined ? "missing" : "valid",
    minimumKnownClientAppVersion: null,
    upgradeChannel: null,
    hostReleaseChannel: "stable",
  };
  return {
    code: "INCOMPATIBLE",
    reason:
      "This Traycer client is too old for this host. Update the Traycer app or CLI to the latest version. Updating the host again will not help. Do not reset Traycer; your agents and history remain stored.",
    incompatibleMethods: null,
    upgradeGuidance: { clientShouldUpgrade: true, hostShouldUpgrade: false },
    retryable: false,
    clientCompatibilityRequirement: requirement,
  };
}

function epochFailure(
  epoch: number | null,
  valid: boolean,
): ClientCompatibilityRequirement["failure"] {
  if (epoch === null) return "missing-epoch";
  return valid ? "below-minimum" : "invalid-epoch";
}

function objectRecord(value: unknown): object | null {
  if (typeof value !== "object" || value === null) return null;
  return value;
}

const unauthorizedDetails: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "The physical host does not accept this credential on OPEN",
  incompatibleMethods: null,
  upgradeGuidance: null,
  retryable: false,
};
