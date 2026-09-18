import { describe, expect, it } from "vitest";
import { RELEASED_FLOOR_METHOD_NAMES } from "../released-floor";
import {
  PROFILE_COPY_MAX_DESTINATIONS,
  PROFILE_COPY_MAX_PAYLOAD_BYTES,
  hostProfileCopyImportRequestSchema,
  hostProfileCopyPreflightRequestSchema,
  profileCopyFeasibilitySchema,
  profileCopyIdentityEvidenceSchema,
  profileCopyOutcomeSchema,
  profileCopyPayloadSchema,
  profileCopyPreviewDestinationSchema,
  profileCopyPreviewRequestSchema,
  profileCopyReasonSchema,
  profileCopyRevisionRequestSchema,
  profileCopyRevisionSchema,
} from "../profile-copy-schemas";
import {
  PROFILE_COPY_RPC_METHODS,
  profileCopyMethodSupport,
} from "../profile-copy-contracts";
import { hostRpcRegistry } from "../index";
import type { ConnectionManifest } from "../../framework/ws-protocol";
import type { VersionedRpcRegistry } from "../../framework/index";

const SOURCE_HOST = "source-host";
const DESTINATION_HOST = "destination-host";
const SOURCE_PROFILE = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_FINGERPRINT = "a".repeat(64);
const DEFAULT_API_KEY = "test-api-key";

const source = {
  sourceHostId: SOURCE_HOST,
  sourceProfileId: SOURCE_PROFILE,
  providerId: "antigravity" as const,
};

const attempt = {
  ...source,
  operationId: OPERATION_ID,
  attemptId: ATTEMPT_ID,
  destinationHostId: DESTINATION_HOST,
};

const metadata = {
  name: "Copied profile",
  color: "#123456",
  desiredEnabled: true,
  skillsPluginsShared: false,
};

const identityEvidence = {
  revision: 1,
  observedAt: 100,
  provenance: "local-metadata" as const,
  issuer: "google" as const,
  accountId: null,
  principalId: null,
};

function payload(apiKey: string) {
  return {
    schemaVersion: 1 as const,
    metadata,
    selectedAuth: {
      kind: "antigravity-api-key" as const,
      providerId: "antigravity" as const,
      authMethod: "gemini-api-key" as const,
      apiKey,
    },
  };
}

function manifestFor(...methods: readonly string[]): ConnectionManifest {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      { major: 1, minor: 0, supportedMajors: [1] },
    ]),
  );
}

describe("profile-copy protocol contracts", () => {
  it("keeps the entire optional family off the released floor", () => {
    const registry: VersionedRpcRegistry = hostRpcRegistry;
    const methods = Object.keys(PROFILE_COPY_RPC_METHODS) as Array<
      keyof typeof PROFILE_COPY_RPC_METHODS
    >;
    for (const method of methods) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      const entry = registry[method];
      expect(entry).toBeDefined();
      expect(entry?.degrade).toEqual({ kind: "unsupported" });
    }
  });

  it("rejects arbitrary fields and caller-supplied filesystem paths", () => {
    expect(
      profileCopyPreviewRequestSchema.safeParse({
        ...source,
        destinationHostIds: [DESTINATION_HOST],
        accountId: "attacker-account",
        sourcePath: "/Users/attacker/.config/provider",
      }).success,
    ).toBe(false);

    expect(
      profileCopyPayloadSchema.safeParse({
        ...payload(DEFAULT_API_KEY),
        sourcePath: "/tmp/credential-copy",
        credentialDirectory: "/tmp/secrets",
      }).success,
    ).toBe(false);

    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        attempt,
        requestFingerprint: REQUEST_FINGERPRINT,
        sourceIdentity: identityEvidence,
        payload: {
          ...payload(DEFAULT_API_KEY),
          destinationPath: "/tmp/destination",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects provider/auth mismatches and unreviewed OAuth credential shapes", () => {
    expect(
      hostProfileCopyPreflightRequestSchema.safeParse({
        attempt,
        selection: { providerId: "grok", authMethod: "grok-oauth" },
        sourceIdentity: identityEvidence,
      }).success,
    ).toBe(false);
    expect(
      hostProfileCopyPreflightRequestSchema.safeParse({
        attempt,
        selection: { providerId: "antigravity", authMethod: "gemini-api-key" },
        sourceIdentity: identityEvidence,
      }).success,
    ).toBe(true);

    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        attempt,
        requestFingerprint: REQUEST_FINGERPRINT,
        sourceIdentity: identityEvidence,
        payload: {
          ...payload(DEFAULT_API_KEY),
          selectedAuth: {
            kind: "antigravity-api-key",
            providerId: "antigravity",
            authMethod: "grok-oauth",
            apiKey: "secret",
          },
        },
      }).success,
    ).toBe(false);

    expect(
      profileCopyPayloadSchema.safeParse({
        schemaVersion: 1,
        metadata,
        selectedAuth: {
          kind: "oauth",
          providerId: "grok",
          authMethod: "grok-oauth",
          accessToken: "secret-token",
        },
      }).success,
    ).toBe(false);
  });

  it("enforces a byte limit, including multibyte credential material", () => {
    const oversized = "🙂".repeat(
      Math.floor(PROFILE_COPY_MAX_PAYLOAD_BYTES / 4),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(payload(oversized))).byteLength,
    ).toBeGreaterThan(PROFILE_COPY_MAX_PAYLOAD_BYTES);
    expect(profileCopyPayloadSchema.safeParse(payload(oversized)).success).toBe(
      false,
    );
    expect(
      profileCopyPayloadSchema.safeParse(payload(DEFAULT_API_KEY)).success,
    ).toBe(true);
  });

  it("bounds destinations and rejects duplicates or the source as a destination", () => {
    const tooMany = Array.from(
      { length: PROFILE_COPY_MAX_DESTINATIONS + 1 },
      (_, index) => `destination-${index}`,
    );
    expect(
      profileCopyPreviewRequestSchema.safeParse({
        ...source,
        destinationHostIds: tooMany,
      }).success,
    ).toBe(false);
    expect(
      profileCopyPreviewRequestSchema.safeParse({
        ...source,
        destinationHostIds: [DESTINATION_HOST, DESTINATION_HOST],
      }).success,
    ).toBe(false);
    expect(
      profileCopyPreviewRequestSchema.safeParse({
        ...source,
        destinationHostIds: [SOURCE_HOST],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and unsafe revisions", () => {
    for (const revision of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
    ]) {
      expect(profileCopyRevisionSchema.safeParse(revision).success).toBe(false);
    }
    expect(
      profileCopyRevisionRequestSchema.safeParse({
        attempt,
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      profileCopyIdentityEvidenceSchema.safeParse({
        ...identityEvidence,
        revision: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps automatic and manual feasibility independent", () => {
    expect(
      profileCopyFeasibilitySchema.parse({
        automatic: { status: "unavailable", reason: "adapter-not-admitted" },
        manual: {
          status: "available",
          route: "destination-local-browser",
          admissionRevision: REQUEST_FINGERPRINT,
        },
      }),
    ).toEqual({
      automatic: { status: "unavailable", reason: "adapter-not-admitted" },
      manual: {
        status: "available",
        route: "destination-local-browser",
        admissionRevision: REQUEST_FINGERPRINT,
      },
    });
  });

  it("represents unknown, quarantined, indeterminate, mismatch and busy outcomes", () => {
    const readiness = {
      preparation: "complete" as const,
      verification: "indeterminate" as const,
      verificationRevision: 2,
      acceptedVerificationRevision: null,
      identity: "mismatch" as const,
      identityRevision: 3,
      acceptedIdentityRevision: null,
      writer: "unconfirmed" as const,
      writerGeneration: 4,
      quarantined: true,
    };
    for (const [state, reason] of [
      ["outcome-unknown", "internal-error"],
      ["quarantined", "writer-unconfirmed"],
      ["blocked", "login-resource-busy"],
      ["account-confirmation-required", "identity-mismatch"],
    ] as const) {
      expect(
        profileCopyOutcomeSchema.safeParse({
          attempt,
          revision: 4,
          state,
          reason,
          targetProfileId: null,
          targetEnabled: null,
          targetAuthStatus: null,
          replacementAttemptId: null,
          desiredEnabled: true,
          destinationProviderEnabled: false,
          readiness,
        }).success,
      ).toBe(true);
    }
    expect(
      profileCopyOutcomeSchema.safeParse({
        attempt,
        revision: 5,
        state: "already-present",
        reason: null,
        targetProfileId: SOURCE_PROFILE,
        targetEnabled: false,
        targetAuthStatus: "authenticated",
        replacementAttemptId: null,
        desiredEnabled: true,
        destinationProviderEnabled: true,
        readiness,
      }).success,
    ).toBe(true);
  });

  it("requires both peers to advertise major one without changing the floor", () => {
    const method = "providers.profileCopy.preview" as const;
    const current = manifestFor(method);
    expect(profileCopyMethodSupport(current, current, [method], [method])).toBe(
      "supported",
    );
    expect(profileCopyMethodSupport(null, current, [method], [method])).toBe(
      "update-required",
    );
    expect(profileCopyMethodSupport(current, {}, [method], [method])).toBe(
      "update-required",
    );
    expect(
      profileCopyMethodSupport(
        { [method]: { major: 2, minor: 0, supportedMajors: [2] } },
        current,
        [method],
        [method],
      ),
    ).toBe("update-required");
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("host.status");
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
  });

  it("caps the complete host import request, not only its nested payload", () => {
    const nearLimitKey = "x".repeat(PROFILE_COPY_MAX_PAYLOAD_BYTES - 600);
    const nearLimitPayload = payload(nearLimitKey);
    expect(
      new TextEncoder().encode(JSON.stringify(nearLimitPayload)).byteLength,
    ).toBeLessThanOrEqual(PROFILE_COPY_MAX_PAYLOAD_BYTES);
    expect(profileCopyPayloadSchema.safeParse(nearLimitPayload).success).toBe(
      true,
    );
    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        attempt,
        requestFingerprint: REQUEST_FINGERPRINT,
        sourceIdentity: identityEvidence,
        retryOfAttemptId: null,
        payload: nearLimitPayload,
      }).success,
    ).toBe(false);
  });

  it("parses directory-unavailable on the reason, a preview destination and a feasibility", () => {
    expect(
      profileCopyReasonSchema.safeParse("directory-unavailable").success,
    ).toBe(true);
    expect(
      profileCopyFeasibilitySchema.safeParse({
        automatic: { status: "unavailable", reason: "directory-unavailable" },
        manual: { status: "unavailable", reason: "directory-unavailable" },
      }).success,
    ).toBe(true);
    expect(
      profileCopyPreviewDestinationSchema.safeParse({
        destinationHostId: DESTINATION_HOST,
        feasibility: {
          automatic: { status: "unavailable", reason: "directory-unavailable" },
          manual: { status: "unavailable", reason: "directory-unavailable" },
        },
        disposition: "unavailable",
        reason: "directory-unavailable",
        existingProfileId: null,
        destinationProviderEnabled: null,
      }).success,
    ).toBe(true);
  });

  it("requires retryOfAttemptId as uuid or null and rejects a self-replacement", () => {
    const predecessor = "00000000-0000-4000-8000-000000000099";
    const missing = {
      attempt,
      requestFingerprint: REQUEST_FINGERPRINT,
      sourceIdentity: identityEvidence,
      payload: payload(DEFAULT_API_KEY),
    };
    expect(hostProfileCopyImportRequestSchema.safeParse(missing).success).toBe(
      false,
    );
    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        ...missing,
        retryOfAttemptId: ATTEMPT_ID,
      }).success,
    ).toBe(false);
    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        ...missing,
        retryOfAttemptId: predecessor,
      }).success,
    ).toBe(true);
    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        ...missing,
        retryOfAttemptId: predecessor,
        payload: {
          schemaVersion: 1,
          metadata,
          selectedAuth: {
            kind: "manual",
            selection: {
              providerId: "antigravity",
              authMethod: "gemini-api-key",
            },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      hostProfileCopyImportRequestSchema.safeParse({
        ...missing,
        retryOfAttemptId: null,
      }).success,
    ).toBe(true);
  });
});
