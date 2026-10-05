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
  profileCopySourceSchema,
} from "../profile-copy-schemas";
import {
  PROFILE_COPY_RPC_METHODS,
  profileCopyMethodSupport,
} from "../profile-copy-contracts";
import * as frozenV1 from "../profile-copy-schemas-v1";
import * as currentSchemas from "../profile-copy-schemas";
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

  it("accepts the Terminal account's literal id as a source and nothing else that is not a uuid", () => {
    const ambient = { ...source, sourceProfileId: "ambient" };
    expect(profileCopySourceSchema.safeParse(ambient).success).toBe(true);
    expect(
      profileCopyPreviewRequestSchema.safeParse({
        ...ambient,
        destinationHostIds: [DESTINATION_HOST],
      }).success,
    ).toBe(true);

    for (const sourceProfileId of [
      "Ambient",
      "AMBIENT",
      "ambient ",
      "",
      "../../.codex",
      "/Users/attacker/.codex",
    ]) {
      expect(
        profileCopySourceSchema.safeParse({ ...source, sourceProfileId })
          .success,
      ).toBe(false);
      expect(
        profileCopyPreviewRequestSchema.safeParse({
          ...source,
          sourceProfileId,
          destinationHostIds: [DESTINATION_HOST],
        }).success,
      ).toBe(false);
    }
  });

  it("keeps every id a copy mints a uuid even when the source is the Terminal account", () => {
    expect(
      hostProfileCopyPreflightRequestSchema.safeParse({
        attempt: { ...attempt, sourceProfileId: "ambient" },
        selection: { providerId: "antigravity", authMethod: "gemini-api-key" },
        sourceIdentity: identityEvidence,
      }).success,
    ).toBe(true);
    expect(
      hostProfileCopyPreflightRequestSchema.safeParse({
        attempt: { ...attempt, attemptId: "ambient" },
        selection: { providerId: "antigravity", authMethod: "gemini-api-key" },
        sourceIdentity: identityEvidence,
      }).success,
    ).toBe(false);
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

  it("accepts copy majors one and two, refuses others, and keeps applySync at major one", () => {
    const method = "providers.profileCopy.preview" as const;
    const at = (major: number): ConnectionManifest => ({
      [method]: { major, minor: 0, supportedMajors: [major] },
    });
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
    // Either peer may be on major two.
    expect(profileCopyMethodSupport(at(2), current, [method], [method])).toBe(
      "supported",
    );
    expect(profileCopyMethodSupport(current, at(2), [method], [method])).toBe(
      "supported",
    );
    // A peer that only speaks an unknown major must update.
    expect(profileCopyMethodSupport(at(3), current, [method], [method])).toBe(
      "update-required",
    );
    expect(profileCopyMethodSupport(current, at(3), [method], [method])).toBe(
      "update-required",
    );
    const apply = "host.profileCopy.applySync" as const;
    expect(
      profileCopyMethodSupport(
        manifestFor(apply),
        manifestFor(apply),
        [apply],
        [apply],
      ),
    ).toBe("supported");
    expect(
      profileCopyMethodSupport(
        { [apply]: { major: 2, minor: 0, supportedMajors: [2] } },
        manifestFor(apply),
        [apply],
        [apply],
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

describe("profile-copy opaque host id versions", () => {
  const OPAQUE_SOURCE = "host:source/1.local";
  const OPAQUE_DESTINATION = "host:dest+2@lan";
  const preview = PROFILE_COPY_RPC_METHODS["providers.profileCopy.preview"];
  const draftStatus =
    PROFILE_COPY_RPC_METHODS["providers.profileCopy.draftStatus"];

  const readiness = {
    preparation: "incomplete" as const,
    verification: "not-checked" as const,
    verificationRevision: null,
    acceptedVerificationRevision: null,
    identity: "not-checked" as const,
    identityRevision: null,
    acceptedIdentityRevision: null,
    writer: "none" as const,
    writerGeneration: 0,
    quarantined: false,
  };

  function attemptFor(sourceHostId: string, destinationHostId: string) {
    return {
      ...source,
      sourceHostId,
      operationId: OPERATION_ID,
      attemptId: ATTEMPT_ID,
      destinationHostId,
    };
  }

  function draftResponse(sourceHostId: string, destinationHostId: string) {
    return {
      result: "current" as const,
      outcome: {
        attempt: attemptFor(sourceHostId, destinationHostId),
        revision: 1,
        state: "preparing" as const,
        reason: null,
        targetProfileId: null,
        targetEnabled: null,
        targetAuthStatus: null,
        replacementAttemptId: null,
        desiredEnabled: true,
        destinationProviderEnabled: true,
        readiness,
      },
    };
  }

  const opaquePreviewRequest = {
    ...source,
    sourceHostId: OPAQUE_SOURCE,
    destinationHostIds: [OPAQUE_DESTINATION],
  };
  const ordinaryPreviewRequest = {
    ...source,
    destinationHostIds: [DESTINATION_HOST],
  };

  it("lets the frozen 1.0 contract refuse opaque ids and 2.0 accept them, in requests and nested receipts", () => {
    expect(
      frozenV1.profileCopyPreviewRequestSchema.safeParse(opaquePreviewRequest)
        .success,
    ).toBe(false);
    expect(
      currentSchemas.profileCopyPreviewRequestSchema.safeParse(
        opaquePreviewRequest,
      ).success,
    ).toBe(true);
    const opaqueReceipt = draftResponse(OPAQUE_SOURCE, OPAQUE_DESTINATION);
    expect(
      frozenV1.profileCopyDraftResponseSchema.safeParse(opaqueReceipt).success,
    ).toBe(false);
    expect(
      currentSchemas.profileCopyDraftResponseSchema.safeParse(opaqueReceipt)
        .success,
    ).toBe(true);
    // Ordinary ids are valid in both.
    const ordinaryReceipt = draftResponse(SOURCE_HOST, DESTINATION_HOST);
    expect(
      frozenV1.profileCopyDraftResponseSchema.safeParse(ordinaryReceipt)
        .success,
    ).toBe(true);
    expect(
      frozenV1.profileCopyPreviewRequestSchema.safeParse(ordinaryPreviewRequest)
        .success,
    ).toBe(true);
  });

  it("downgrades and upgrades ordinary ids unchanged", () => {
    const down = preview[2].downgradePathsFromLatest[1];
    const up = preview[2].versions[0].upgradeFromPreviousVersion;
    expect(down.downgradeRequest(ordinaryPreviewRequest)).toEqual({
      ok: true,
      value: ordinaryPreviewRequest,
    });
    expect(up.upgradeRequest(ordinaryPreviewRequest)).toEqual(
      ordinaryPreviewRequest,
    );
    const draftDown = draftStatus[2].downgradePathsFromLatest[1];
    const draftUp = draftStatus[2].versions[0].upgradeFromPreviousVersion;
    const request = { attempt: attemptFor(SOURCE_HOST, DESTINATION_HOST) };
    const response = draftResponse(SOURCE_HOST, DESTINATION_HOST);
    expect(draftDown.downgradeRequest(request)).toEqual({
      ok: true,
      value: request,
    });
    expect(draftDown.downgradeResponse(response)).toEqual({
      ok: true,
      value: response,
    });
    expect(draftUp.upgradeRequest(request)).toEqual(request);
    expect(draftUp.upgradeResponse(response)).toEqual(response);
  });

  it("refuses to downgrade an opaque request or response with DOWNGRADE_UNSUPPORTED, never rewriting an id", () => {
    const down = preview[2].downgradePathsFromLatest[1];
    expect(down.downgradeRequest(opaquePreviewRequest)).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
    const draftDown = draftStatus[2].downgradePathsFromLatest[1];
    expect(
      draftDown.downgradeRequest({
        attempt: attemptFor(OPAQUE_SOURCE, DESTINATION_HOST),
      }),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
    expect(
      draftDown.downgradeResponse(
        draftResponse(SOURCE_HOST, OPAQUE_DESTINATION),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });

  it("registers all twenty-one copy methods with frozen 1.0, canonical 2.0, an identity upgrade and a downgrade", () => {
    const registry: VersionedRpcRegistry = hostRpcRegistry;
    const entries = Object.entries(PROFILE_COPY_RPC_METHODS);
    expect(entries).toHaveLength(21);
    for (const [method, line] of entries) {
      expect(line[1].versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(line[2].versions[0].contract.schemaVersion).toEqual({
        major: 2,
        minor: 0,
      });
      expect(line[2].versions[0].upgradeFromPreviousVersion).toMatchObject({
        from: { major: 1, minor: 0 },
        to: { major: 2, minor: 0 },
      });
      expect(line[2].downgradePathsFromLatest[1]).toMatchObject({
        from: { major: 2, minor: 0 },
        to: { major: 1, minor: 0 },
      });
      // The registry serves the same lines, with the unsupported degrade.
      expect(registry[method]).toEqual(line);
      expect(line.degrade).toEqual({ kind: "unsupported" });
    }
  });
});
