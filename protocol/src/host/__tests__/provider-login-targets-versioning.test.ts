import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { hostV115MutationV20Fixtures } from "./__fixtures__/host-v1.1.5-mutation-v20";
import {
  providerCliStateSchemaV10,
  providerLoginProfileOutcomeSchema,
  providerLoginTargetRefusalSchema,
  providerMutationCliStateSchemaV20,
  providerMutationCliStateSchemaV21,
  providersAwaitLoginRequestSchema,
  providersAwaitLoginResponseSchema,
  providersAwaitLoginResponseSchemaV24,
  providersStartLoginRequestSchemaV15,
  providersStartLoginResponseSchemaV15,
  type ProvidersAwaitLoginRequest,
  type ProvidersAwaitLoginResponse,
  type ProviderLoginSignInRequest,
  type ProvidersStartLoginRequestV15,
  type ProvidersStartLoginResponseV15,
} from "@traycer/protocol/host/provider-schemas";
import {
  decodeResponsePayload,
  prepareRequestPayload,
} from "@traycer/protocol/host-transport/remote/rpc-codec";

const startRegistry = hostRpcRegistry["providers.startLogin"];
const awaitRegistry = hostRpcRegistry["providers.awaitLogin"];
const startV15 = { major: 1, minor: 5 } as const;
const awaitV24 = { major: 2, minor: 4 } as const;
const awaitV25 = { major: 2, minor: 5 } as const;
const awaitV10 = { major: 1, minor: 0 } as const;

type StartMinor = 0 | 1 | 2 | 3 | 4;
type AwaitMinor = 0 | 1 | 2 | 3 | 4;
type AwaitVersion = { major: 1; minor: 0 } | { major: 2; minor: AwaitMinor };

const codexMutationFixture =
  hostV115MutationV20Fixtures.minimalStatesByProviderId.codex;
const codexSuccessAuth = {
  ...codexMutationFixture.auth,
  status: "authenticated" as const,
};
const codexSuccessMutationV20 = providerMutationCliStateSchemaV20.parse({
  ...codexMutationFixture,
  auth: codexSuccessAuth,
});
const codexSuccessMutationV21 = providerMutationCliStateSchemaV21.parse({
  ...codexMutationFixture,
  auth: codexSuccessAuth,
});
const { availabilityPending: _availabilityPending, ...codexV10Fixture } =
  codexMutationFixture;
const codexSuccessV10 = providerCliStateSchemaV10.parse({
  ...codexV10Fixture,
  auth: codexSuccessAuth,
});

// These populated values exercise old-line key preservation. They are
// projection fixtures, not claims that a host emits these outcomes together.
const startV15Projection = {
  url: "https://login.example.test/start",
  started: false,
  profileId: "legacy-profile",
  userCode: "ABCD-EFGH",
  failure: "device_auth_unavailable",
  pending: "starting",
  pack: { percent: 60, reason: null, retryAtMs: 1200 },
  targetRefusal: "not-available-yet",
} as const;

// Projection fixture only: the old schemas retain or strip fields, and this
// does not claim the host emits these mutually exclusive outcomes together.
const signInRequestFixture: ProviderLoginSignInRequest = {
  operationId: "8c6f4f97-8a2c-4b7e-9875-223456789abc",
  environmentId: "environment-fixture",
  sourceHostId: "source-host-fixture",
  sourceSharingGeneration: 3,
  harnessId: "claude-code",
};

const awaitV24Projection = {
  state: codexSuccessMutationV21,
  existingProfileId: "existing-profile",
  codeRejected: true,
  refusal: {
    reason: "verification-required",
    actionUrl: "https://accounts.example.test/verify",
  },
  installation: {
    kind: "waiting-for-readers",
    admissionId: "reader-wait-fixture",
    count: 2,
  },
  profileOutcome: { kind: "signed-in", profileId: "destination-profile" },
} as const;

const awaitV25Projection = {
  ...awaitV24Projection,
  signInRequest: signInRequestFixture,
};

const malformedSignInRequestCases = [
  {
    name: "a non-UUID operation id",
    value: { ...signInRequestFixture, operationId: "not-a-uuid" },
  },
  {
    name: "a negative source sharing generation",
    value: { ...signInRequestFixture, sourceSharingGeneration: -1 },
  },
  {
    name: "a fractional source sharing generation",
    value: { ...signInRequestFixture, sourceSharingGeneration: 1.5 },
  },
  {
    name: "an invalid harness id",
    value: { ...signInRequestFixture, harnessId: "Claude Code" },
  },
  { name: "a value of the wrong type", value: "not-a-sign-in-request" },
] satisfies ReadonlyArray<{ name: string; value: unknown }>;

function upgradeStartRequest(
  minor: StartMinor,
  input: unknown,
): ProvidersStartLoginRequestV15 {
  switch (minor) {
    case 0:
      return upgradeRequestToVersion(
        startRegistry,
        { major: 1, minor: 0 },
        startV15,
        startRegistry[1].versions[0].contract.requestSchema.parse(input),
      );
    case 1:
      return upgradeRequestToVersion(
        startRegistry,
        { major: 1, minor: 1 },
        startV15,
        startRegistry[1].versions[1].contract.requestSchema.parse(input),
      );
    case 2:
      return upgradeRequestToVersion(
        startRegistry,
        { major: 1, minor: 2 },
        startV15,
        startRegistry[1].versions[2].contract.requestSchema.parse(input),
      );
    case 3:
      return upgradeRequestToVersion(
        startRegistry,
        { major: 1, minor: 3 },
        startV15,
        startRegistry[1].versions[3].contract.requestSchema.parse(input),
      );
    case 4:
      return upgradeRequestToVersion(
        startRegistry,
        { major: 1, minor: 4 },
        startV15,
        startRegistry[1].versions[4].contract.requestSchema.parse(input),
      );
  }
}

function upgradeAwaitRequest(
  version: AwaitVersion,
  input: unknown,
): ProvidersAwaitLoginRequest {
  if (version.major === 1) {
    return upgradeRequestToVersion(
      awaitRegistry,
      awaitV10,
      awaitV25,
      awaitRegistry[1].versions[0].contract.requestSchema.parse(input),
    );
  }
  switch (version.minor) {
    case 0:
      return upgradeRequestToVersion(
        awaitRegistry,
        { major: 2, minor: 0 },
        awaitV25,
        awaitRegistry[2].versions[0].contract.requestSchema.parse(input),
      );
    case 1:
      return upgradeRequestToVersion(
        awaitRegistry,
        { major: 2, minor: 1 },
        awaitV25,
        awaitRegistry[2].versions[1].contract.requestSchema.parse(input),
      );
    case 2:
      return upgradeRequestToVersion(
        awaitRegistry,
        { major: 2, minor: 2 },
        awaitV25,
        awaitRegistry[2].versions[2].contract.requestSchema.parse(input),
      );
    case 3:
      return upgradeRequestToVersion(
        awaitRegistry,
        { major: 2, minor: 3 },
        awaitV25,
        awaitRegistry[2].versions[3].contract.requestSchema.parse(input),
      );
    case 4:
      return upgradeRequestToVersion(
        awaitRegistry,
        awaitV24,
        awaitV25,
        awaitRegistry[2].versions[4].contract.requestSchema.parse(input),
      );
  }
}

const startRequestDownCases = [
  {
    name: "providers.startLogin@1.4 request new client -> older host",
    minor: 4,
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
      target: null,
    },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
    },
  },
  {
    name: "providers.startLogin@1.3 request new client -> older host",
    minor: 3,
    input: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: true },
      holderId: "holder-fixture",
      target: null,
    },
    expected: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: true },
    },
  },
  {
    name: "providers.startLogin@1.2 request new client -> older host",
    minor: 2,
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
      target: null,
    },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
    },
  },
  {
    name: "providers.startLogin@1.1 request new client -> older host",
    minor: 1,
    input: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: false },
      holderId: "holder-fixture",
      target: null,
    },
    expected: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: false },
    },
  },
  {
    name: "providers.startLogin@1.0 request new client -> older host",
    minor: 0,
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
      target: null,
    },
    expected: { providerId: "codex" },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: StartMinor;
  input: unknown;
  expected: unknown;
}>;

const startRequestUpCases = [
  {
    name: "providers.startLogin@1.4 request older client -> new host",
    minor: 4,
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
    },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: "holder-fixture",
      target: null,
    },
  },
  {
    name: "providers.startLogin@1.3 request older client -> new host",
    minor: 3,
    input: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: true },
    },
    expected: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: true },
      holderId: null,
      target: null,
    },
  },
  {
    name: "providers.startLogin@1.2 request older client -> new host",
    minor: 2,
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
    },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      createProfile: null,
      holderId: null,
      target: null,
    },
  },
  {
    name: "providers.startLogin@1.1 request older client -> new host",
    minor: 1,
    input: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: false },
    },
    expected: {
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: false },
      holderId: null,
      target: null,
    },
  },
  {
    name: "providers.startLogin@1.0 request older client -> new host",
    minor: 0,
    input: { providerId: "codex" },
    expected: {
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: null,
      target: null,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: StartMinor;
  input: unknown;
  expected: ProvidersStartLoginRequestV15;
}>;

const startResponseUpCases = [
  {
    name: "providers.startLogin@1.4 response older host -> new client",
    minor: 4,
    input: startV15Projection,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
      pending: "starting",
      pack: { percent: 60, reason: null, retryAtMs: 1200 },
      targetRefusal: null,
    },
  },
  {
    name: "providers.startLogin@1.3 response older host -> new client",
    minor: 3,
    input: startV15Projection,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
      pending: "starting",
      pack: { percent: 60, reason: null, retryAtMs: 1200 },
      targetRefusal: null,
    },
  },
  {
    name: "providers.startLogin@1.2 response older host -> new client",
    minor: 2,
    input: startV15Projection,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
      pending: null,
      pack: null,
      targetRefusal: null,
    },
  },
  {
    name: "providers.startLogin@1.1 response older host -> new client",
    minor: 1,
    input: startV15Projection,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: null,
      failure: null,
      pending: null,
      pack: null,
      targetRefusal: null,
    },
  },
  {
    name: "providers.startLogin@1.0 response older host -> new client",
    minor: 0,
    input: startV15Projection,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: null,
      userCode: null,
      failure: null,
      pending: null,
      pack: null,
      targetRefusal: null,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: StartMinor;
  input: unknown;
  expected: ProvidersStartLoginResponseV15;
}>;

const startResponseDownCases = [
  {
    name: "providers.startLogin@1.4 response new host -> older client",
    minor: 4,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
      pending: "starting",
      pack: { percent: 60, reason: null, retryAtMs: 1200 },
    },
  },
  {
    name: "providers.startLogin@1.3 response new host -> older client",
    minor: 3,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
      pending: "starting",
      pack: { percent: 60, reason: null, retryAtMs: 1200 },
    },
  },
  {
    name: "providers.startLogin@1.2 response new host -> older client",
    minor: 2,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
      userCode: "ABCD-EFGH",
      failure: "device_auth_unavailable",
    },
  },
  {
    name: "providers.startLogin@1.1 response new host -> older client",
    minor: 1,
    expected: {
      url: "https://login.example.test/start",
      started: false,
      profileId: "legacy-profile",
    },
  },
  {
    name: "providers.startLogin@1.0 response new host -> older client",
    minor: 0,
    expected: {
      url: "https://login.example.test/start",
      started: false,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: StartMinor;
  expected: unknown;
}>;

const awaitRequestInput = {
  providerId: "codex",
  profileId: "selected-profile",
  lastSeenReaderCount: 4,
  recordedOperationId: signInRequestFixture.operationId,
};

const awaitRequestDownCases = [
  {
    name: "providers.awaitLogin@2.4 request new client -> older host",
    version: { major: 2, minor: 4 },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: 4,
    },
  },
  {
    name: "providers.awaitLogin@2.3 request new client -> older host",
    version: { major: 2, minor: 3 },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: 4,
    },
  },
  {
    name: "providers.awaitLogin@2.2 request new client -> older host",
    version: { major: 2, minor: 2 },
    expected: { providerId: "codex", profileId: "selected-profile" },
  },
  {
    name: "providers.awaitLogin@2.1 request new client -> older host",
    version: { major: 2, minor: 1 },
    expected: { providerId: "codex", profileId: "selected-profile" },
  },
  {
    name: "providers.awaitLogin@2.0 request new client -> older host",
    version: { major: 2, minor: 0 },
    expected: { providerId: "codex" },
  },
  {
    name: "providers.awaitLogin@1.0 request new client -> older host",
    version: awaitV10,
    expected: { providerId: "codex" },
  },
] satisfies ReadonlyArray<{
  name: string;
  version: AwaitVersion;
  expected: unknown;
}>;

const awaitRequestUpCases = [
  {
    name: "providers.awaitLogin@2.4 request older client -> new host",
    version: { major: 2, minor: 4 },
    input: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: 4,
    },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: 4,
      recordedOperationId: null,
    },
  },
  {
    name: "providers.awaitLogin@2.3 request older client -> new host",
    version: { major: 2, minor: 3 },
    input: awaitRequestInput,
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: 4,
      recordedOperationId: null,
    },
  },
  {
    name: "providers.awaitLogin@2.2 request older client -> new host",
    version: { major: 2, minor: 2 },
    input: { providerId: "codex", profileId: "selected-profile" },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: null,
      recordedOperationId: null,
    },
  },
  {
    name: "providers.awaitLogin@2.1 request older client -> new host",
    version: { major: 2, minor: 1 },
    input: { providerId: "codex", profileId: "selected-profile" },
    expected: {
      providerId: "codex",
      profileId: "selected-profile",
      lastSeenReaderCount: null,
      recordedOperationId: null,
    },
  },
  {
    name: "providers.awaitLogin@2.0 request older client -> new host",
    version: { major: 2, minor: 0 },
    input: { providerId: "codex" },
    expected: {
      providerId: "codex",
      profileId: null,
      lastSeenReaderCount: null,
      recordedOperationId: null,
    },
  },
  {
    name: "providers.awaitLogin@1.0 request older client -> new host",
    version: awaitV10,
    input: { providerId: "codex" },
    expected: {
      providerId: "codex",
      profileId: null,
      lastSeenReaderCount: null,
      recordedOperationId: null,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  version: AwaitVersion;
  input: unknown;
  expected: ProvidersAwaitLoginRequest;
}>;

const awaitResponseUpCases = [
  {
    name: "providers.awaitLogin@2.4 response older host -> new client",
    version: { major: 2, minor: 4 },
    input: awaitV24Projection,
    expected: { ...awaitV24Projection, signInRequest: null },
  },
  {
    name: "providers.awaitLogin@2.3 response older host -> new client",
    version: { major: 2, minor: 3 },
    input: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
      installation: {
        kind: "waiting-for-readers",
        admissionId: "reader-wait-fixture",
        count: 2,
      },
    },
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
      installation: {
        kind: "waiting-for-readers",
        admissionId: "reader-wait-fixture",
        count: 2,
      },
      profileOutcome: null,
      signInRequest: null,
    },
  },
  {
    name: "providers.awaitLogin@2.2 response older host -> new client",
    version: { major: 2, minor: 2 },
    input: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
    },
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
      installation: null,
      profileOutcome: null,
      signInRequest: null,
    },
  },
  {
    name: "providers.awaitLogin@2.1 response older host -> new client",
    version: { major: 2, minor: 1 },
    input: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
    },
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: false,
      refusal: null,
      installation: null,
      profileOutcome: null,
      signInRequest: null,
    },
  },
  {
    name: "providers.awaitLogin@2.0 response older host -> new client",
    version: { major: 2, minor: 0 },
    input: { state: codexSuccessMutationV20 },
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
      installation: null,
      profileOutcome: null,
      signInRequest: null,
    },
  },
  {
    name: "providers.awaitLogin@1.0 response older host -> new client",
    version: awaitV10,
    input: { state: codexSuccessV10 },
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
      installation: null,
      profileOutcome: null,
      signInRequest: null,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  version: AwaitVersion;
  input: unknown;
  expected: ProvidersAwaitLoginResponse;
}>;

const awaitResponseDownCases = [
  {
    name: "providers.awaitLogin@2.4 response new host -> older client",
    minor: 4,
    expected: awaitV24Projection,
  },
  {
    name: "providers.awaitLogin@2.3 response new host -> older client",
    minor: 3,
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: true,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
      installation: {
        kind: "waiting-for-readers",
        admissionId: "reader-wait-fixture",
        count: 2,
      },
    },
  },
  {
    name: "providers.awaitLogin@2.2 response new host -> older client",
    minor: 2,
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: true,
      refusal: {
        reason: "verification-required",
        actionUrl: "https://accounts.example.test/verify",
      },
    },
  },
  {
    name: "providers.awaitLogin@2.1 response new host -> older client",
    minor: 1,
    expected: {
      state: codexSuccessMutationV21,
      existingProfileId: "existing-profile",
      codeRejected: true,
    },
  },
  {
    name: "providers.awaitLogin@2.0 response new host -> older client",
    minor: 0,
    expected: { state: codexSuccessMutationV20 },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: AwaitMinor;
  expected: unknown;
}>;

const awaitResponseV10DownCases = [
  {
    name: "providers.awaitLogin@1.0 response new host -> older client",
    input: awaitV25Projection,
    expected: { ok: true, value: { state: codexSuccessV10 } },
  },
] satisfies ReadonlyArray<{
  name: string;
  input: unknown;
  expected: unknown;
}>;

describe("provider login targets and outcomes", () => {
  it("validates detached target, refusal, outcome, and default cases", () => {
    const ordinaryRequest = {
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: null,
    };
    expect(
      providersStartLoginRequestSchemaV15.parse(ordinaryRequest).target,
    ).toBeNull();
    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...ordinaryRequest,
        target: null,
      }).target,
    ).toBeNull();
    expect(
      providersStartLoginRequestSchemaV15.safeParse({
        ...ordinaryRequest,
        target: { kind: "environment", environmentId: "" },
      }).success,
    ).toBe(false);
    expect(
      providersStartLoginRequestSchemaV15.safeParse({
        ...ordinaryRequest,
        target: { kind: "unrecognized-target" },
      }).success,
    ).toBe(false);

    const omittedRefusal = providersStartLoginResponseSchemaV15.parse({
      url: null,
      started: false,
    });
    expect(omittedRefusal).not.toHaveProperty("targetRefusal");
    expect(
      providersStartLoginResponseSchemaV15.parse({
        url: null,
        started: false,
        targetRefusal: null,
      }).targetRefusal,
    ).toBeNull();
    const malformedRefusal = providersStartLoginResponseSchemaV15.parse({
      url: null,
      started: false,
      targetRefusal: "unknown-refusal",
    });
    expect(malformedRefusal.targetRefusal).toBeNull();
    expect(malformedRefusal.started).toBe(false);

    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...ordinaryRequest,
        target: {
          kind: "environment",
          environmentId: "environment-fixture",
        },
      }).target,
    ).toEqual({
      kind: "environment",
      environmentId: "environment-fixture",
      profileId: null,
    });
    expect(
      providersStartLoginRequestSchemaV15.parse({
        ...ordinaryRequest,
        target: { kind: "leave-to-local", profileId: "folder-alias" },
      }).target,
    ).toEqual({ kind: "leave-to-local", profileId: "folder-alias" });

    const refusals = [
      "unsupported-computer",
      "not-authorized",
      "target-unavailable",
      "target-removed",
      "invalid-leave-profile",
      "not-available-yet",
    ] as const;
    for (const refusal of refusals) {
      expect(providerLoginTargetRefusalSchema.parse(refusal)).toBe(refusal);
    }
    expect(
      providerLoginTargetRefusalSchema.safeParse("other-refusal").success,
    ).toBe(false);

    const outcomes = [
      { kind: "waiting-for-profile" },
      { kind: "account-mismatch" },
      { kind: "account-unproven" },
      { kind: "target-refused", reason: "not-authorized" },
      { kind: "target-refused", reason: "target-unavailable" },
      { kind: "target-refused", reason: "target-removed" },
      { kind: "target-refused", reason: "offer-refused" },
      { kind: "staged-for-leave", profileId: "folder-alias" },
      { kind: "signed-in", profileId: "local-profile" },
      { kind: "already-signed-in", profileId: "destination-profile" },
    ] as const;
    for (const outcome of outcomes) {
      expect(providerLoginProfileOutcomeSchema.parse(outcome)).toEqual(outcome);
    }
    expect(
      providerLoginProfileOutcomeSchema.safeParse({
        kind: "target-refused",
        reason: "provider-error-text",
      }).success,
    ).toBe(false);
    expect(
      providerLoginProfileOutcomeSchema.safeParse({
        kind: "signed-in",
        profileId: "",
      }).success,
    ).toBe(false);

    expect(
      providersAwaitLoginResponseSchema.parse({ state: null }).profileOutcome,
    ).toBeUndefined();
    expect(
      providersAwaitLoginResponseSchema.parse({
        state: null,
        profileOutcome: null,
      }).profileOutcome,
    ).toBeNull();
    const malformedOutcome = providersAwaitLoginResponseSchema.parse({
      state: null,
      profileOutcome: { kind: "unknown-outcome" },
    });
    expect(malformedOutcome.profileOutcome).toBeNull();
    expect(malformedOutcome.state).toBeNull();
  });

  it.each(startRequestDownCases)("$name", (testCase) => {
    const request = providersStartLoginRequestSchemaV15.parse(testCase.input);
    expect(
      prepareRequestPayload(
        startRegistry,
        startV15,
        { major: 1, minor: testCase.minor },
        request,
        "request-fixture",
        "providers.startLogin",
      ),
    ).toEqual({
      onWireVersion: { major: 1, minor: testCase.minor },
      onWirePayload: testCase.expected,
    });
  });

  it.each(startRequestUpCases)("$name", (testCase) => {
    expect(upgradeStartRequest(testCase.minor, testCase.input)).toEqual(
      testCase.expected,
    );
  });

  it.each(startResponseUpCases)("$name", (testCase) => {
    expect(
      decodeResponsePayload<ProvidersStartLoginResponseV15>(
        startRegistry,
        startV15,
        { major: 1, minor: testCase.minor },
        testCase.input,
        "response-fixture",
        "providers.startLogin",
      ),
    ).toEqual(testCase.expected);
  });

  it.each(startResponseDownCases)("$name", (testCase) => {
    expect(
      startRegistry[1].versions[testCase.minor].contract.responseSchema.parse(
        startV15Projection,
      ),
    ).toEqual(testCase.expected);
  });

  it("records target loss in the startLogin codec projection to 1.4", () => {
    const targetedRequest = providersStartLoginRequestSchemaV15.parse({
      providerId: "codex",
      profileId: null,
      createProfile: null,
      holderId: "holder-fixture",
      target: { kind: "leave-to-local", profileId: "folder-alias" },
    });
    expect(
      prepareRequestPayload(
        startRegistry,
        startV15,
        { major: 1, minor: 4 },
        targetedRequest,
        "request-fixture",
        "providers.startLogin",
      ),
    ).toEqual({
      onWireVersion: { major: 1, minor: 4 },
      onWirePayload: {
        providerId: "codex",
        profileId: null,
        createProfile: null,
        holderId: "holder-fixture",
      },
    });
  });

  it.each(awaitRequestDownCases)("$name", (testCase) => {
    expect(
      prepareRequestPayload(
        awaitRegistry,
        awaitV25,
        testCase.version,
        providersAwaitLoginRequestSchema.parse(awaitRequestInput),
        "request-fixture",
        "providers.awaitLogin",
      ),
    ).toEqual({
      onWireVersion: testCase.version,
      onWirePayload: testCase.expected,
    });
  });

  it.each(awaitRequestUpCases)("$name", (testCase) => {
    expect(upgradeAwaitRequest(testCase.version, testCase.input)).toEqual(
      testCase.expected,
    );
  });

  it.each(awaitResponseUpCases)("$name", (testCase) => {
    expect(
      decodeResponsePayload<ProvidersAwaitLoginResponse>(
        awaitRegistry,
        awaitV25,
        testCase.version,
        testCase.input,
        "response-fixture",
        "providers.awaitLogin",
      ),
    ).toEqual(testCase.expected);
  });

  it.each(awaitResponseDownCases)("$name", (testCase) => {
    expect(
      (testCase.minor === 4
        ? providersAwaitLoginResponseSchemaV24
        : awaitRegistry[2].versions[testCase.minor].contract.responseSchema
      ).parse(awaitV25Projection),
    ).toEqual(testCase.expected);
  });

  it.each(awaitResponseV10DownCases)("$name", (testCase) => {
    expect(
      downgradeResponseAcrossMajors(
        awaitRegistry,
        2,
        1,
        providersAwaitLoginResponseSchema.parse(testCase.input),
      ),
    ).toEqual(testCase.expected);
  });

  it("parses a valid providers.awaitLogin@2.5 sign-in request unchanged", () => {
    expect(
      awaitRegistry[2].versions[5].contract.responseSchema.parse({
        state: null,
        signInRequest: signInRequestFixture,
      }).signInRequest,
    ).toEqual(signInRequestFixture);
  });

  it("leaves absent providers.awaitLogin@2.5 recording fields undefined", () => {
    const request = awaitRegistry[2].versions[5].contract.requestSchema.parse({
      providerId: "codex",
      profileId: null,
      lastSeenReaderCount: 4,
    });
    const response = awaitRegistry[2].versions[5].contract.responseSchema.parse(
      {
        state: null,
      },
    );

    expect(request.recordedOperationId).toBeUndefined();
    expect(response.signInRequest).toBeUndefined();
  });

  it.each(malformedSignInRequestCases)(
    "reads $name as null for providers.awaitLogin@2.5 sign-in request",
    (testCase) => {
      expect(
        awaitRegistry[2].versions[5].contract.responseSchema.parse({
          state: null,
          signInRequest: testCase.value,
        }).signInRequest,
      ).toBeNull();
    },
  );

  it("preserves null downgrade and rejects the ineligible provider state", () => {
    expect(
      downgradeResponseAcrossMajors(awaitRegistry, 2, 1, {
        state: null,
        existingProfileId: null,
        codeRejected: false,
        refusal: null,
        installation: null,
        profileOutcome: null,
      }),
    ).toEqual({ ok: true, value: { state: null } });

    const ineligibleProviderState = providerMutationCliStateSchemaV21.parse(
      hostV115MutationV20Fixtures.minimalStatesByProviderId.amp,
    );
    expect(
      downgradeResponseAcrossMajors(awaitRegistry, 2, 1, {
        state: ineligibleProviderState,
        existingProfileId: null,
        codeRejected: false,
        refusal: null,
        installation: null,
        profileOutcome: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });
});
