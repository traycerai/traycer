import { LegacyTeamHost } from "./legacy-team-host";
import { buildHostUseCommand } from "../../commands/host-use";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentialsFile,
  writeCredentialsFile,
} from "@traycer/protocol/config/credentials";
import { createCliCredentialsStore } from "../../store/credentials-store";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import type { HostPidMetadata } from "../pid-metadata";
import type { HealthProbeOptions } from "../../service/health-probe";
import {
  HostRpcError,
  RetryableTransportError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import type {
  EnvironmentMoveOutcomeAnswer,
  EnvironmentMoveStageResponse,
} from "@traycer/protocol/host/environment/move-contracts";

// `maybeProvisionCredential`'s own decision logic, which had no direct
// coverage: every command suite that exercises it (`host-install`,
// `host-ensure`, `service-install`) mocks this function wholesale to pin its
// own wiring, so nothing tested what it decides.
//
// The decision it makes is a two-part gate - did this run START anything,
// and can we mint for it - and the second half deliberately does NOT trust
// the pre-flight's verdict. The pre-flight runs before a stage + install
// that can take minutes, and the credentials file moves in BOTH directions
// across that window: a concurrent `traycer login` in another terminal
// invalidates an `unauthenticated` verdict exactly as a concurrent sign-out
// invalidates a `signed-in` one. So the auth is re-read at probe time and
// the pre-flight's verdict survives only as the thing that decides what a
// still-missing credential MEANS.
//
// `resolveHostAuth` and `provisionInstalledHostCredential` are mocked: the
// real ones read the operator's actual `~/.traycer` credentials and open a
// WebSocket to a host. The probe's own internals have their own suite in
// `credential-provisioning.test.ts`.

const mocks = vi.hoisted(() => ({
  resolveHostAuthMock: vi.fn(),
  provisionInstalledHostCredentialMock: vi.fn(),
  callHostRpcMock: vi.fn(),
  callHostRpcAtResolvedEndpointMock: vi.fn(),
  resolveEndpointMock: vi.fn(),
  readHostOwnershipMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  probeHostHealthMock: vi.fn(),
  replacementMetadata: null as HostPidMetadata | null,
  credentialsPath: "",
  enrollmentRecordPath: "",
  mintTeamInstallTokenMock: vi.fn(),
  legacyHost: null as LegacyTeamHost | null,
  trace: [] as string[],
  wrapCredentialStoreMock:
    vi.fn<(store: CredentialsMutationStore) => CredentialsMutationStore>(),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: mocks.resolveHostAuthMock,
}));

vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: (
      ...callArgs: Parameters<typeof actual.readHostPidMetadata>
    ) => mocks.readHostPidMetadataMock(...callArgs),
  };
});

vi.mock("../../service/health-probe", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/health-probe")>();
  return {
    ...actual,
    probeHostHealth: (...callArgs: Parameters<typeof actual.probeHostHealth>) =>
      mocks.probeHostHealthMock(...callArgs),
  };
});

vi.mock("../credential-provisioning", () => ({
  provisionInstalledHostCredential: mocks.provisionInstalledHostCredentialMock,
}));

// Keep the network out while exercising the real team selection and move
// logic in install-auth.ts.
vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    resolveEndpoint: (...callArgs: Parameters<typeof actual.resolveEndpoint>) =>
      mocks.resolveEndpointMock(...callArgs),
    callHostRpcAtResolvedEndpoint: (
      ...callArgs: Parameters<typeof actual.callHostRpcAtResolvedEndpoint>
    ) =>
      mocks.legacyHost === null
        ? mocks.callHostRpcAtResolvedEndpointMock(...callArgs)
        : mocks.legacyHost.request(callArgs[0], callArgs[1], callArgs[4]),
    callHostRpcWithDispatch: (
      ...callArgs: Parameters<typeof actual.callHostRpcWithDispatch>
    ) =>
      mocks.legacyHost === null
        ? mocks.callHostRpcMock(...callArgs)
        : mocks.legacyHost.request(...callArgs),
    callHostRpc: (...callArgs: Parameters<typeof actual.callHostRpc>) =>
      mocks.callHostRpcMock(...callArgs),
  };
});

// Redirect the real credentials mutation store to this suite's private file.
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: () => mocks.credentialsPath,
    hostEnrollmentRecordPath: () => mocks.enrollmentRecordPath,
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () =>
      mocks.wrapCredentialStoreMock(actual.createCliCredentialsStore()),
    runWithCliStore: async <T>(
      fn: (store: CredentialsMutationStore) => Promise<T>,
    ): Promise<T> => {
      const store = mocks.wrapCredentialStoreMock(
        actual.createCliCredentialsStore(),
      );
      try {
        return await fn(store);
      } finally {
        store.dispose();
      }
    },
  };
});

vi.mock(
  "@traycer-clients/shared/host-client/team-computer-install",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/team-computer-install")
      >();
    return {
      ...actual,
      mintTeamComputerInstallTokenBySlugViaHttp: (
        ...callArgs: Parameters<
          typeof actual.mintTeamComputerInstallTokenBySlugViaHttp
        >
      ) => mocks.mintTeamInstallTokenMock(...callArgs),
    };
  },
);

vi.mock(
  "@traycer-clients/shared/host-client/host-ownership",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-ownership")
      >();
    return {
      ...actual,
      readHostOwnershipViaHttp: (
        authnBaseUrl: string,
        bearerToken: string,
        hostId: string,
      ) => {
        mocks.trace.push("ownership");
        return mocks.readHostOwnershipMock(authnBaseUrl, bearerToken, hostId);
      },
    };
  },
);

import {
  beginAttendedTeamInstall,
  completeTeamInstall,
  maybeProvisionCredential,
  warnIfTeamInstallSignInRemains,
} from "../install-auth";
import type {
  HostInstallAuthPreflight,
  TeamInstallAuthSession,
} from "../install-auth";
import type { HostCredentialProvisionOutcome } from "../credential-provisioning";
import type { CommandContext } from "../../runner/runner";
import { TEAM_TRANSFER_DISCLOSURE } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import { CLI_ERROR_CODES } from "../../runner/errors";

const credentialsRoot = mkdtempSync(join(tmpdir(), "team-install-auth-test-"));
let caseCredentialsRoot = "";
const TEST_HOST_ID = "00000000-0000-4000-8000-000000000001";
const TEST_TEAM_ID = "00000000-0000-4000-8000-000000000002";
const TEST_OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000003";
const MOVE_ATTEMPT_ID = "00000000-0000-4000-8000-000000000004";
const MOVE_ACCEPTANCE_ID = "00000000-0000-4000-8000-000000000005";
const MOVE_PLAN_HASH = "a".repeat(64);
const MOVE_DISCLOSURE_HASH = "b".repeat(64);
const TEAM_TRANSFER_FAILURE =
  "The team transfer could not be confirmed. Check this computer in the app before trying again.";
const teamEnvironment = {
  environmentId: "environment-acme",
  ownerKind: "organization",
  ownerId: TEST_TEAM_ID,
  roomId: "room-acme",
  label: "Acme",
  effectiveRole: "admin",
  kind: "team",
  hostCount: 0,
  providerHandle: "acme",
} as const;
const collidingLabelEnvironment = {
  ...teamEnvironment,
  environmentId: "environment-label-collision",
  ownerId: "00000000-0000-4000-8000-000000000006",
  roomId: "room-label-collision",
  label: "acme",
  providerHandle: "other-team",
} as const;
const personalEnvironment = {
  environmentId: "environment-personal",
  ownerKind: "user",
  ownerId: "member-1",
  roomId: "room-personal",
  label: "Personal",
} as const;
const teamBinding = {
  hostId: TEST_HOST_ID,
  environment: teamEnvironment,
  explicit: true,
  enrolledByUserId: "member-1",
  canUnbind: true,
};
// Each differs from the team's explicit binding in exactly one field.
const notExplicitTeamBinding = { ...teamBinding, explicit: false };
const otherEnvironmentBinding = {
  ...teamBinding,
  environment: { ...teamEnvironment, environmentId: "environment-other" },
};
const personalBinding = {
  hostId: TEST_HOST_ID,
  environment: personalEnvironment,
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

function hostOwnership(
  owner: HostOwnerPrincipal,
  kind: "personal" | "sandbox",
): HostOwnershipResult {
  return {
    kind: "ok",
    host: {
      hostId: TEST_HOST_ID,
      owner,
      kind,
      remoteAccess: false,
    },
  };
}

afterAll(() => {
  rmSync(credentialsRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (caseCredentialsRoot !== "") {
    rmSync(caseCredentialsRoot, { recursive: true, force: true });
    caseCredentialsRoot = "";
  }
});

async function writeStoredCredentials(token: string): Promise<void> {
  await writeStoredCredentialsFor(token, "member-1", `${token}-refresh`);
}

async function writeStoredCredentialsFor(
  token: string,
  userId: string,
  refreshToken: string,
): Promise<void> {
  await writeCredentialsFile(
    mocks.credentialsPath,
    {
      token,
      refreshToken,
      savedAt: "2026-11-10T00:00:00.000Z",
      user: { id: userId, email: "member@example.test", name: "Member" },
    },
    0,
  );
}

function movePlan(disclosureVersion: number) {
  return {
    planHash: MOVE_PLAN_HASH,
    planRevision: 3,
    hostVersion: "1.2.3",
    disclosureVersion,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
      looksLikeAKey: [],
      sameNameInPersonal: [],
    },
    guideDiffers: false,
    personalHoldsSecrets: false,
  };
}

function moveStage(overrides: {
  readonly planHash?: string;
  readonly sourceHostId?: string;
  readonly environmentId?: string;
  readonly teamId?: string;
  readonly keyChoices?: readonly {
    readonly key: string;
    readonly choice: "stays";
  }[];
}): EnvironmentMoveStageResponse {
  return {
    evidence: {
      attemptId: MOVE_ATTEMPT_ID,
      planHash: overrides.planHash ?? MOVE_PLAN_HASH,
      planRevision: 3,
      hostVersion: "1.2.3",
      itemCount: 0,
      keyChoices: overrides.keyChoices ?? [],
      sourceHostId: overrides.sourceHostId ?? TEST_HOST_ID,
      sharingGeneration: 1,
      targetKind: "team",
      environmentId: overrides.environmentId ?? teamEnvironment.environmentId,
      teamId: overrides.teamId ?? teamEnvironment.ownerId,
      disclosureVersion: 2,
    },
    authorization: { disclosureHash: MOVE_DISCLOSURE_HASH },
  };
}

function moveOutcome(
  state: "running" | "retry" | "done" | "needs_person" | "not_found",
  reason?: "move_acceptance_conflict" | "plan_hash_mismatch",
): EnvironmentMoveOutcomeAnswer {
  if (state === "needs_person")
    return {
      state,
      attemptId: MOVE_ATTEMPT_ID,
      acceptanceId: MOVE_ACCEPTANCE_ID,
      reason: reason ?? "move_acceptance_conflict",
    };
  if (state === "not_found") return { state, attemptId: MOVE_ATTEMPT_ID };
  if (state === "retry")
    return {
      state,
      attemptId: MOVE_ATTEMPT_ID,
      acceptanceId: MOVE_ACCEPTANCE_ID,
      cause: "unavailable",
    };
  return {
    state,
    attemptId: MOVE_ATTEMPT_ID,
    acceptanceId: MOVE_ACCEPTANCE_ID,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubAuthnFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => handler(String(input), init)),
  );
}

async function prepareTeamGive(token: string): Promise<void> {
  await writeStoredCredentials(token);
  mocks.resolveHostAuthMock.mockResolvedValue({
    token,
    authnBaseUrl: "https://authn.test",
    userId: "member-1",
  });
  mocks.readHostOwnershipMock
    .mockReset()
    .mockResolvedValueOnce(
      hostOwnership({ kind: "user", id: "member-1" }, "personal"),
    )
    .mockResolvedValueOnce(
      hostOwnership(
        { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
        "personal",
      ),
    );
}

function defaultMoveHostReply(
  method: string,
  params: unknown,
): Promise<unknown> {
  mocks.trace.push("host:" + method);
  if (method === "environment.move.plan") return Promise.resolve(movePlan(2));
  if (method === "environment.move.stage")
    return Promise.resolve(moveStage({}));
  if (method === "environment.move.start")
    return Promise.resolve(moveOutcome("running"));
  if (method === "environment.status")
    return Promise.resolve({
      move: {
        state: "done",
        attemptId: MOVE_ATTEMPT_ID,
        acceptanceId: MOVE_ACCEPTANCE_ID,
      },
    });
  if (method === "environment.host.read") return Promise.resolve(teamBinding);
  throw new Error("unexpected host RPC " + method + " " + String(params));
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function signedIn(): HostInstallAuthPreflight {
  return { state: "signed-in", reason: null };
}

function unauthenticated(): HostInstallAuthPreflight {
  return { state: "unauthenticated", reason: "noninteractive-cannot-prompt" };
}

function storedAuth(): {
  readonly token: string;
  readonly authnBaseUrl: string;
  readonly userId: string;
} {
  return {
    token: "stored-bearer",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  };
}

function hostPidMetadata(overrides: Partial<HostPidMetadata>): HostPidMetadata {
  return {
    pid: 4100,
    hostId: TEST_HOST_ID,
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    startedAt: "2026-11-10T00:00:00.000Z",
    processStartIdentity: null,
    processStartIdentityRead: "absent",
    layer0: null,
    layer0Slot: null,
    ...overrides,
  };
}

describe("install auth helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.legacyHost = null;
    mocks.trace.length = 0;
    mocks.wrapCredentialStoreMock.mockImplementation((store) => store);
    mocks.resolveEndpointMock.mockResolvedValue({
      hostId: TEST_HOST_ID,
      websocketUrl: "ws://127.0.0.1:1/rpc",
    });
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4100,
      hostId: TEST_HOST_ID,
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:1/rpc",
      startedAt: "2026-11-10T00:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    });
    mocks.replacementMetadata = {
      pid: 4101,
      hostId: TEST_HOST_ID,
      version: "1.0.0",
      websocketUrl: "ws://127.0.0.1:2/rpc",
      startedAt: "2026-11-10T00:00:01.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    };
    mocks.probeHostHealthMock.mockImplementation(
      async (options: HealthProbeOptions) => {
        if (
          options.checkReadiness === null ||
          mocks.replacementMetadata === null
        )
          return { healthy: false, detail: "replacement host not ready" };
        const ready = await options.checkReadiness(
          mocks.replacementMetadata,
          10_000,
        );
        return {
          healthy: ready,
          detail: ready
            ? "replacement host ready"
            : "replacement host not ready",
        };
      },
    );
    caseCredentialsRoot = mkdtempSync(join(credentialsRoot, "case-"));
    mocks.credentialsPath = join(caseCredentialsRoot, "cli", "credentials");
    mocks.enrollmentRecordPath = join(
      caseCredentialsRoot,
      "identity",
      "enrollment.json",
    );
    mocks.callHostRpcMock.mockImplementation((method: string) => {
      mocks.trace.push(`host:${method}`);
      if (method === "environment.list") {
        return Promise.resolve({ environments: [teamEnvironment] });
      }
      throw new Error(`unexpected host RPC ${method}`);
    });
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      defaultMoveHostReply,
    );
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "stored-bearer",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.mintTeamInstallTokenMock.mockResolvedValue({
      kind: "ok",
      token: "team-install-secret",
      environmentId: "resolved-environment-acme",
      expiresAt: 1_800_000_000,
    });
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValue(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );
    stubAuthnFetch(async (url) => {
      mocks.trace.push(url.endsWith("/move-acceptances") ? "acceptance" : url);
      return jsonResponse(201, { acceptanceId: MOVE_ACCEPTANCE_ID });
    });
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
      kind: "active",
      minted: true,
    });
  });

  it("mints by slug and uses authn's resolved environment id when no enrollment record exists", async () => {
    const result = await beginAttendedTeamInstall(fakeCtx(), "team/acme");

    expect(result).toEqual({
      kind: "enrol",
      session: { preflight: signedIn(), inlineSignInToken: null },
      slug: "acme",
      token: "team-install-secret",
      environmentId: "resolved-environment-acme",
    });
    expect(mocks.mintTeamInstallTokenMock).toHaveBeenCalledWith(
      "https://authn.test",
      "stored-bearer",
      "acme",
    );
  });

  it("takes the give path without minting when the enrollment record is present", async () => {
    mkdirSync(join(caseCredentialsRoot, "identity"), { recursive: true });
    writeFileSync(mocks.enrollmentRecordPath, "registered");

    await expect(beginAttendedTeamInstall(fakeCtx(), "acme")).resolves.toEqual({
      kind: "give",
      session: { preflight: signedIn(), inlineSignInToken: null },
    });
    expect(mocks.mintTeamInstallTokenMock).not.toHaveBeenCalled();
  });

  it("takes the give path without minting when the enrollment record cannot be read", async () => {
    writeFileSync(join(caseCredentialsRoot, "identity"), "blocks-directory");

    await expect(beginAttendedTeamInstall(fakeCtx(), "acme")).resolves.toEqual({
      kind: "give",
      session: { preflight: signedIn(), inlineSignInToken: null },
    });
    expect(mocks.mintTeamInstallTokenMock).not.toHaveBeenCalled();
  });

  it("directs a non-member to use their team's dashboard slug", async () => {
    mocks.mintTeamInstallTokenMock.mockResolvedValue({
      kind: "refused",
      status: 404,
      code: "environment_not_found",
    });

    await expect(
      beginAttendedTeamInstall(fakeCtx(), "acme"),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "Enter the slug of a team you belong to, as shown in its dashboard address.",
    });
    expect(mocks.mintTeamInstallTokenMock).toHaveBeenCalledTimes(1);
  });

  it("asks the person to sign in again when authn refuses the bearer", async () => {
    mocks.mintTeamInstallTokenMock.mockResolvedValue({ kind: "unauthorized" });

    await expect(
      beginAttendedTeamInstall(fakeCtx(), "acme"),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: expect.stringContaining("Sign in with `traycer login`"),
    });
  });

  it.each([
    ["environment_action_forbidden", 403],
    ["seat_without_write", 403],
    ["broker_unavailable", 503],
  ] as const)(
    "keeps the generic no-install message for %s",
    async (code, status) => {
      mocks.mintTeamInstallTokenMock.mockResolvedValue({
        kind: "refused",
        status,
        code,
      });

      await expect(
        beginAttendedTeamInstall(fakeCtx(), "acme"),
      ).rejects.toMatchObject({
        message:
          "The computer was not added to the team. No host files were installed.",
      });
    },
  );

  it("keeps the generic no-install message after a mint network error", async () => {
    mocks.mintTeamInstallTokenMock.mockResolvedValue({
      kind: "network-error",
      detail: "safe detail",
    });

    await expect(
      beginAttendedTeamInstall(fakeCtx(), "acme"),
    ).rejects.toMatchObject({
      message:
        "The computer was not added to the team. No host files were installed.",
    });
  });

  it("stages a null-personal team give, accepts before start, and confirms the binding", async () => {
    await prepareTeamGive("stored-bearer");
    const progress = vi.fn<CommandContext["progress"]>((info) => {
      if (info.message !== null) mocks.trace.push("progress:" + info.message);
    });
    mocks.callHostRpcMock.mockImplementation((method: string) => {
      mocks.trace.push("host:" + method);
      if (method === "environment.list") {
        return Promise.resolve({
          environments: [teamEnvironment, collidingLabelEnvironment],
        });
      }
      throw new Error("unexpected host RPC " + method);
    });

    const result = await buildHostUseCommand("acme")({
      ...fakeCtx(),
      progress,
    });

    expect(result).toMatchObject({
      data: { binding: teamBinding },
      human: "This computer belongs to Acme.",
      exitCode: 0,
    });
    expect(progress.mock.calls.map(([info]) => info.message)).toEqual([
      ...TEAM_TRANSFER_DISCLOSURE,
      "Restarting Traycer on this computer to run as Acme…",
    ]);
    expect(mocks.trace).toEqual([
      "host:environment.list",
      "ownership",
      "host:environment.move.plan",
      ...TEAM_TRANSFER_DISCLOSURE.map((line) => "progress:" + line),
      "progress:Restarting Traycer on this computer to run as Acme…",
      "host:environment.move.stage",
      "acceptance",
      "host:environment.move.start",
      "host:environment.status",
      "host:environment.host.read",
      "ownership",
    ]);

    const listCall = mocks.callHostRpcMock.mock.calls[0];
    expect(listCall?.[0]).toBe("environment.list");
    expect(listCall?.[1]).toEqual({});
    expect(listCall?.[2]).toMatchObject({
      requiredHostMethodVersion: {
        method: "environment.move.plan",
        version: { major: 2, minor: 0 },
      },
    });

    const hostCalls = mocks.callHostRpcAtResolvedEndpointMock.mock.calls;
    expect(hostCalls.map(([method]) => method)).toEqual([
      "environment.move.plan",
      "environment.move.stage",
      "environment.move.start",
      "environment.status",
      "environment.host.read",
    ]);
    const planCall = hostCalls.find(
      ([method]) => method === "environment.move.plan",
    );
    expect(planCall?.[1]).toEqual({
      target: {
        kind: "team",
        environmentId: teamEnvironment.environmentId,
        teamId: TEST_TEAM_ID,
      },
      personal: null,
    });
    expect(planCall?.[4]).toMatchObject({
      requiredHostMethodVersion: {
        method: "environment.move.plan",
        version: { major: 2, minor: 0 },
      },
    });
    const stageCall = hostCalls.find(
      ([method]) => method === "environment.move.stage",
    );
    expect(stageCall?.[1]).toEqual({
      target: {
        kind: "team",
        environmentId: teamEnvironment.environmentId,
        teamId: TEST_TEAM_ID,
      },
      keyChoices: [],
      personal: null,
    });
    const startCall = hostCalls.find(
      ([method]) => method === "environment.move.start",
    );
    expect(startCall?.[1]).toEqual({
      attemptId: MOVE_ATTEMPT_ID,
      planHash: MOVE_PLAN_HASH,
      acceptanceId: MOVE_ACCEPTANCE_ID,
    });
    expect(hostCalls.at(-1)?.[2]).toEqual({
      hostId: TEST_HOST_ID,
      websocketUrl: "ws://127.0.0.1:2/rpc",
    });
    expect(hostCalls.map(([method]) => method)).not.toContain(
      "environment.host.bind",
    );
    expect(hostCalls.map(([method]) => method)).not.toContain("host.status");
    expect(hostCalls.map(([method]) => method)).not.toContain(
      "environment.move.outcome",
    );

    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0]?.[0])).toBe(
      "https://authn.test/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
    );
    const acceptanceInit = fetchCalls[0]?.[1];
    expect(acceptanceInit?.method).toBe("POST");
    expect(acceptanceInit?.redirect).toBe("manual");
    const acceptanceHeaders = new Headers(acceptanceInit?.headers);
    expect(acceptanceHeaders.get("authorization")).toBe("Bearer stored-bearer");
    expect(acceptanceHeaders.get("accept")).toBe("application/json");
    expect(acceptanceHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(acceptanceInit?.body))).toEqual({
      ...moveStage({}).evidence,
      ...moveStage({}).authorization,
    });
  });

  it("re-reads the stored sign-in after its first host call, so a refresh made by that call's mint is the one it pins", async () => {
    const startingToken = "expired-at-command-start-token";
    const refreshedToken = "refreshed-by-first-host-call-token";
    const firstCallThatCanRefreshSignIn = "environment.list";
    await prepareTeamGive(startingToken);
    const resolvedTokens: string[] = [];
    mocks.resolveHostAuthMock.mockImplementation(async () => {
      const credentials = await readCredentialsFile(mocks.credentialsPath);
      if (credentials === null) return null;
      resolvedTokens.push(credentials.token);
      return {
        token: credentials.token,
        authnBaseUrl: "https://authn.test",
        userId: credentials.user.id,
      };
    });
    mocks.callHostRpcMock.mockImplementation(async (method: string) => {
      mocks.trace.push("host:" + method);
      if (method === firstCallThatCanRefreshSignIn) {
        // host-rpc.test.ts covers mint/401/refresh/re-mint; here the actual
        // store commits the refresh effect inside that first host call.
        const store = createCliCredentialsStore();
        try {
          const rotation = await store.rotate({
            expectedUserId: "member-1",
            expectedToken: startingToken,
            refreshTokenOverride: null,
            signal: null,
          });
          expect(rotation.outcome).toBe("applied");
          expect(rotation.credentials?.token).toBe(refreshedToken);
        } finally {
          store.dispose();
        }
        return { environments: [teamEnvironment] };
      }
      throw new Error("unexpected host RPC " + method);
    });
    const authnRequests: Array<{
      readonly path: string;
      readonly authorization: string | null;
    }> = [];
    stubAuthnFetch(async (url, init) => {
      const path = new URL(url).pathname;
      authnRequests.push({
        path,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (path === "/api/v3/auth/refresh")
        return jsonResponse(200, {
          token: refreshedToken,
          refreshToken: "refreshed-by-first-host-call-refresh-token",
        });
      return jsonResponse(201, { acceptanceId: MOVE_ACCEPTANCE_ID });
    });

    const result = await buildHostUseCommand("acme")(fakeCtx());

    expect(result).toMatchObject({
      human: "This computer belongs to Acme.",
      exitCode: 0,
    });
    expect(resolvedTokens).toEqual([refreshedToken]);
    expect(
      mocks.readHostOwnershipMock.mock.calls.map(([, token]) => token),
    ).toEqual([refreshedToken, refreshedToken]);
    expect(authnRequests).toEqual([
      {
        path: "/api/v3/auth/refresh",
        authorization: "Bearer " + startingToken,
      },
      {
        path: "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
        authorization: "Bearer " + refreshedToken,
      },
    ]);
  });

  it("refuses a host without plan@2.0 at its first call without printing or sending a frame", async () => {
    const legacyHost = new LegacyTeamHost();
    const progress = vi.fn<CommandContext["progress"]>();
    mocks.legacyHost = legacyHost;
    const ctx = { ...fakeCtx(), progress };

    await expect(buildHostUseCommand("acme")(ctx)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: expect.stringContaining("environment.move.plan"),
    });

    expect(legacyHost.requests).toEqual([]);
    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
    expect(mocks.readHostOwnershipMock).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(ctx.output.human).not.toHaveBeenCalled();
    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
  });

  it.each([1, 3] as const)(
    "prints the transfer line for disclosure version %i before any other output or acceptance",
    async (disclosureVersion) => {
      await prepareTeamGive("stored-bearer");
      const progress = vi.fn<CommandContext["progress"]>();
      const ctx = { ...fakeCtx(), progress };
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.move.plan") {
            mocks.trace.push("host:" + method);
            return Promise.resolve(movePlan(disclosureVersion));
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(buildHostUseCommand("acme")(ctx)).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });

      expect(progress).not.toHaveBeenCalled();
      expect(mocks.trace).toEqual([
        "host:environment.list",
        "ownership",
        "host:environment.move.plan",
      ]);
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toEqual(["environment.move.plan"]);
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
      expect(ctx.output.human).not.toHaveBeenCalled();
      expect(ctx.output.humanRequired).not.toHaveBeenCalled();
    },
  );

  it("returns the existing binding for an already-given same team without planning a move", async () => {
    await writeStoredCredentials("pre-existing-bearer");
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "pre-existing-bearer",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.readHostOwnershipMock
      .mockReset()
      .mockResolvedValue(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    const calls = mocks.callHostRpcAtResolvedEndpointMock.mock.calls;
    expect(calls.map(([method]) => method)).toEqual(["environment.host.read"]);
    expect(calls[0]?.[4]).toMatchObject({
      requiredHostMethodVersion: {
        method: "environment.move.plan",
        version: { major: 2, minor: 0 },
      },
    });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a binding that is not explicit", binding: notExplicitTeamBinding },
    {
      name: "an explicit binding in another environment",
      binding: otherEnvironmentBinding,
    },
  ])(
    "does not return a team-owned computer's $name as already given",
    async ({ binding }) => {
      await prepareTeamGive("same-team-near-miss-token");
      mocks.readHostOwnershipMock
        .mockReset()
        .mockResolvedValue(
          hostOwnership(
            { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
            "personal",
          ),
        );
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) =>
          method === "environment.host.read"
            ? Promise.resolve(binding)
            : defaultMoveHostReply(method, params),
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM });
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toEqual(["environment.host.read"]);
    },
  );

  it("keeps a failed give from clearing an inline-created sign-in", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.move.stage") {
          mocks.trace.push("host:" + method);
          return Promise.reject(
            new HostRpcError({
              code: "E_MOVE_NOT_AWAITING",
              message: "no move is waiting",
              requestId: "stage-refused",
              method,
              fatalDetails: null,
            }),
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in-inline", reason: null },
          inlineSignInToken: token,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("uses exact slug precedence when a different team's label collides", async () => {
    await prepareTeamGive("slug-selection-token");
    mocks.callHostRpcMock.mockResolvedValue({
      environments: [teamEnvironment, collidingLabelEnvironment],
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    const planCall = mocks.callHostRpcAtResolvedEndpointMock.mock.calls.find(
      ([method]) => method === "environment.move.plan",
    );
    expect(planCall?.[1]).toEqual({
      target: {
        kind: "team",
        environmentId: teamEnvironment.environmentId,
        teamId: TEST_TEAM_ID,
      },
      personal: null,
    });
  });

  it("accepts a team's canonical environment id as the selector", async () => {
    await prepareTeamGive("canonical-selection-token");

    await expect(
      completeTeamInstall(
        teamEnvironment.environmentId,
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.find(
        ([method]) => method === "environment.move.plan",
      )?.[1],
    ).toEqual({
      target: {
        kind: "team",
        environmentId: teamEnvironment.environmentId,
        teamId: TEST_TEAM_ID,
      },
      personal: null,
    });
  });

  it("clears an inline-created sign-in only after the accepted give and ownership confirmation", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);
    const credentialsAtOwnerReads: (string | null)[] = [];
    let ownerRead = 0;
    mocks.readHostOwnershipMock.mockReset().mockImplementation(async () => {
      credentialsAtOwnerReads.push(
        (await readCredentialsFile(mocks.credentialsPath))?.token ?? null,
      );
      ownerRead += 1;
      return ownerRead === 1
        ? hostOwnership({ kind: "user", id: "member-1" }, "personal")
        : hostOwnership(
            { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
            "personal",
          );
    });

    await completeTeamInstall(
      "team/acme",
      {
        preflight: { state: "signed-in-inline", reason: null },
        inlineSignInToken: token,
      },
      vi.fn(),
    );

    expect(mocks.callHostRpcMock.mock.calls.map(([method]) => method)).toEqual([
      "environment.list",
    ]);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toEqual([
      "environment.move.plan",
      "environment.move.stage",
      "environment.move.start",
      "environment.status",
      "environment.host.read",
    ]);
    expect(credentialsAtOwnerReads).toEqual([token, token]);
    expect(await readCredentialsFile(mocks.credentialsPath)).toBeNull();
  });

  it("preserves a newer same-person sign-in instead of clearing it after the give", async () => {
    const inlineToken = "inline-team-token";
    const replacementToken = "concurrent-login-token";
    await prepareTeamGive(inlineToken);
    // The replacement lands after the give is confirmed, just before the clear.
    mocks.wrapCredentialStoreMock.mockImplementation((store) => ({
      ...store,
      signOutIfToken: async (token, scope) => {
        await writeStoredCredentialsFor(
          replacementToken,
          "member-1",
          "replacement-refresh",
        );
        return store.signOutIfToken(token, scope);
      },
    }));

    await completeTeamInstall(
      "acme",
      {
        preflight: { state: "signed-in-inline", reason: null },
        inlineSignInToken: inlineToken,
      },
      vi.fn(),
    );

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      replacementToken,
    );
    const ctx = fakeCtx();
    await warnIfTeamInstallSignInRemains(ctx, {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: inlineToken,
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledExactlyOnceWith(
      "Your sign-in could still be on this computer. Run `traycer logout` to remove it.",
    );
  });

  it("does not warn when the command-created sign-in is no longer stored", async () => {
    const ctx = fakeCtx();
    const session: TeamInstallAuthSession = {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: "inline-team-token",
    };

    await warnIfTeamInstallSignInRemains(ctx, session);

    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
  });

  it("keeps the inline-created sign-in when the final ownership read does not confirm its team", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);
    mocks.readHostOwnershipMock
      .mockReset()
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValue(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      );

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in-inline", reason: null },
          inlineSignInToken: token,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("refuses a sandbox host before planning a team give", async () => {
    await writeStoredCredentials("sandbox-token");
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "sandbox-token",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.readHostOwnershipMock
      .mockReset()
      .mockResolvedValue(
        hostOwnership({ kind: "user", id: "member-1" }, "sandbox"),
      );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_IS_SANDBOX });
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("refuses a computer already owned by another team before planning a give", async () => {
    await writeStoredCredentials("other-team-token");
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "other-team-token",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.readHostOwnershipMock
      .mockReset()
      .mockResolvedValue(
        hostOwnership(
          { kind: "team", id: TEST_OTHER_TEAM_ID, name: "Other" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM,
      message:
        "Claim this computer from its current team before adding it to another.",
    });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("retains a pre-existing sign-in after a successful give", async () => {
    await prepareTeamGive("pre-existing-token");

    await completeTeamInstall(
      "acme",
      { preflight: signedIn(), inlineSignInToken: null },
      vi.fn(),
    );

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      "pre-existing-token",
    );
  });

  it.each([
    {
      name: "a different plan hash",
      overrides: { planHash: "c".repeat(64) },
    },
    {
      name: "a different source host",
      overrides: { sourceHostId: "00000000-0000-4000-8000-000000000009" },
    },
    {
      name: "a different environment",
      overrides: { environmentId: "environment-other" },
    },
    {
      name: "a different team",
      overrides: { teamId: TEST_OTHER_TEAM_ID },
    },
    {
      name: "different key choices",
      overrides: { keyChoices: [{ key: "API_KEY", choice: "stays" as const }] },
    },
  ])(
    "does not record or start a staged give with $name",
    async ({ overrides }) => {
      await prepareTeamGive("stage-evidence-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.move.stage") {
            mocks.trace.push("host:" + method);
            return Promise.resolve(moveStage(overrides));
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });

      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toEqual(["environment.move.plan", "environment.move.stage"]);
    },
  );

  it.each(["stage", "start"] as const)(
    "maps E_MOVE_NOT_AWAITING from %s to the transfer line",
    async (method) => {
      await prepareTeamGive("not-awaiting-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (calledMethod: string, params: unknown) => {
          if (calledMethod === "environment.move." + method) {
            mocks.trace.push("host:" + calledMethod);
            return Promise.reject(
              new HostRpcError({
                code: "E_MOVE_NOT_AWAITING",
                message: "no move is waiting",
                requestId: "not-awaiting",
                method: calledMethod,
                fatalDetails: null,
              }),
            );
          }
          return defaultMoveHostReply(calledMethod, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([calledMethod]) => calledMethod,
        ),
      ).toContain("environment.move." + method);
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(
        method === "stage" ? 0 : 1,
      );
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([calledMethod]) => calledMethod,
        ),
      ).not.toContain("environment.status");
    },
  );

  it.each([
    ["operation_acceptance_invalid", 409],
    ["move_acceptance_conflict", 409],
  ] as const)(
    "refuses acceptance code %s without starting the move",
    async (code, status) => {
      await prepareTeamGive("refused-acceptance-token");
      stubAuthnFetch(async (url) => {
        mocks.trace.push("acceptance");
        expect(url).toContain("/move-acceptances");
        return jsonResponse(status, { code });
      });

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });

      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toEqual(["environment.move.plan", "environment.move.stage"]);
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "redirect", response: jsonResponse(302, {}) },
    { label: "forbidden", response: jsonResponse(403, {}) },
    { label: "unavailable", response: jsonResponse(503, {}) },
    { label: "status zero", response: Response.error() },
  ])(
    "treats an acceptance $label as one failed request without following or retrying",
    async ({ response }) => {
      await prepareTeamGive("single-send-token");
      const requests: Array<{
        readonly url: string;
        readonly method: string | null;
        readonly authorization: string | null;
        readonly redirect: RequestRedirect | undefined;
      }> = [];
      stubAuthnFetch(async (url, init) => {
        requests.push({
          url,
          method: init?.method ?? null,
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        mocks.trace.push("acceptance");
        return response;
      });

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });

      expect(requests).toEqual([
        {
          url:
            "https://authn.test/api/v3/hosts/" +
            TEST_HOST_ID +
            "/move-acceptances",
          method: "POST",
          authorization: "Bearer single-send-token",
          redirect: "manual",
        },
      ]);
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).not.toContain("environment.move.start");
    },
  );

  it("prints the rejected-credential line after a refresh is rejected", async () => {
    await prepareTeamGive("rejected-refresh-token");
    const paths: string[] = [];
    stubAuthnFetch(async (url) => {
      paths.push(new URL(url).pathname);
      return url.endsWith("/move-acceptances")
        ? jsonResponse(401, { error: "Unauthorized" })
        : jsonResponse(401, { error: "Unauthorized" });
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    });

    expect(paths).toEqual([
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
      "/api/v3/auth/refresh",
    ]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it("prints the rejected-credential line when the one resend still answers 401", async () => {
    await prepareTeamGive("second-401-token");
    const paths: string[] = [];
    stubAuthnFetch(async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/api/v3/auth/refresh"))
        return jsonResponse(200, {
          token: "second-401-rotated",
          refreshToken: "second-401-refresh",
        });
      return jsonResponse(401, { error: "Unauthorized" });
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    });

    expect(paths).toEqual([
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
      "/api/v3/auth/refresh",
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
    ]);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
        ([method]) => method === "environment.move.start",
      ),
    ).toHaveLength(0);
  });

  it("treats an unreachable refresh as a failed give without rejecting the sign-in", async () => {
    await prepareTeamGive("refresh-unreachable-token");
    const paths: string[] = [];
    stubAuthnFetch(async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/move-acceptances"))
        return jsonResponse(401, { error: "Unauthorized" });
      throw new TypeError("authn is unreachable");
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });

    expect(paths).toEqual([
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
      "/api/v3/auth/refresh",
    ]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it("uses its rotated token for both the acceptance retry and final ownership read", async () => {
    const startingToken = "starting-token";
    const rotatedToken = "rotated-token";
    await prepareTeamGive(startingToken);
    const requests: Array<{
      readonly path: string;
      readonly method: string | null;
      readonly authorization: string | null;
      readonly redirect: RequestRedirect | undefined;
    }> = [];
    stubAuthnFetch(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({
        path,
        method: init?.method ?? null,
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      if (path === "/api/v3/auth/refresh")
        return jsonResponse(200, {
          token: rotatedToken,
          refreshToken: "rotated-refresh",
        });
      if (
        requests.filter((request) => request.path.endsWith("/move-acceptances"))
          .length === 1
      )
        return jsonResponse(401, { error: "Unauthorized" });
      return jsonResponse(201, { acceptanceId: MOVE_ACCEPTANCE_ID });
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(
      requests.map(({ path, authorization }) => [path, authorization]),
    ).toEqual([
      [
        "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
        "Bearer " + startingToken,
      ],
      ["/api/v3/auth/refresh", "Bearer " + startingToken],
      [
        "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
        "Bearer " + rotatedToken,
      ],
    ]);
    expect(mocks.readHostOwnershipMock).toHaveBeenNthCalledWith(
      2,
      "https://authn.test",
      rotatedToken,
      TEST_HOST_ID,
    );
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toContain("environment.move.start");
  });

  it("does not resend after another same-user sign-in wins inside the refresh lock", async () => {
    const startingToken = "refresh-race-start-token";
    await prepareTeamGive(startingToken);
    let signalRotationStarted: () => void = () => {};
    const rotationStarted = new Promise<void>((resolve) => {
      signalRotationStarted = resolve;
    });
    let releaseRotation: () => void = () => {};
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    mocks.wrapCredentialStoreMock.mockImplementation((store) => ({
      ...store,
      rotate: async (args) => {
        signalRotationStarted();
        await rotationGate;
        return store.rotate(args);
      },
    }));
    const paths: string[] = [];
    stubAuthnFetch(async (url) => {
      paths.push(new URL(url).pathname);
      return jsonResponse(401, { error: "Unauthorized" });
    });

    const give = completeTeamInstall(
      "acme",
      { preflight: signedIn(), inlineSignInToken: null },
      vi.fn(),
    );
    await rotationStarted;
    await writeStoredCredentialsFor(
      "same-user-won-refresh-race",
      "member-1",
      "same-user-won-refresh-race-refresh",
    );
    releaseRotation();

    await expect(give).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });
    expect(paths).toEqual([
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
    ]);
    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      "same-user-won-refresh-race",
    );
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it("does not report a completed give when the sign-in changes during final ownership confirmation", async () => {
    const startingToken = "final-read-race-token";
    await prepareTeamGive(startingToken);
    let signalFinalReadStarted: () => void = () => {};
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalReadStarted = resolve;
    });
    let releaseFinalRead: () => void = () => {};
    const finalReadGate = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    let ownershipRead = 0;
    mocks.readHostOwnershipMock.mockReset().mockImplementation(async () => {
      ownershipRead += 1;
      if (ownershipRead === 1)
        return hostOwnership({ kind: "user", id: "member-1" }, "personal");
      signalFinalReadStarted();
      await finalReadGate;
      return hostOwnership(
        { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
        "personal",
      );
    });
    const ctx = fakeCtx();
    const give = buildHostUseCommand("acme")(ctx);

    await finalReadStarted;
    await writeStoredCredentialsFor(
      "final-read-race-new-token",
      "member-1",
      "final-read-race-new-refresh",
    );
    releaseFinalRead();

    await expect(give).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });
    expect(ctx.output.human).not.toHaveBeenCalled();
    expect(ownershipRead).toBe(2);
  });

  it("does not refresh or resend a 401 after the same person's stored token changes", async () => {
    await prepareTeamGive("session-start-token");
    const paths: string[] = [];
    stubAuthnFetch(async (url) => {
      paths.push(new URL(url).pathname);
      await writeStoredCredentialsFor(
        "same-person-new-session",
        "member-1",
        "same-person-new-refresh",
      );
      return jsonResponse(401, { error: "Unauthorized" });
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });

    expect(paths).toEqual([
      "/api/v3/hosts/" + TEST_HOST_ID + "/move-acceptances",
    ]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it.each([
    "sign-out",
    "another user",
    "same person in a new session",
    "same user refreshed by another process",
  ] as const)(
    "stops after its sign-in is replaced by %s during stage, after adapter initialization",
    async (change) => {
      await prepareTeamGive("stage-session-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        async (method: string, params: unknown) => {
          if (method === "environment.move.stage") {
            mocks.trace.push("host:" + method);
            if (change === "sign-out")
              rmSync(mocks.credentialsPath, { force: true });
            else if (change === "another user")
              await writeStoredCredentialsFor(
                "other-user-token",
                "member-2",
                "other-user-refresh",
              );
            else
              await writeStoredCredentialsFor(
                change === "same user refreshed by another process"
                  ? "same-person-refreshed-elsewhere"
                  : "same-person-new-session",
                "member-1",
                change === "same user refreshed by another process"
                  ? "same-person-refreshed-elsewhere-refresh"
                  : "same-person-new-refresh",
              );
            return moveStage({});
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });

      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toEqual(["environment.move.plan", "environment.move.stage"]);
    },
  );

  it("does not start after the acceptance response arrives on a changed sign-in", async () => {
    await prepareTeamGive("acceptance-session-token");
    stubAuthnFetch(async (url) => {
      mocks.trace.push("acceptance");
      await writeStoredCredentialsFor(
        "acceptance-new-user-token",
        "member-2",
        "acceptance-new-user-refresh",
      );
      return jsonResponse(201, { acceptanceId: MOVE_ACCEPTANCE_ID });
    });

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it("maps a pre-dispatch stage transport failure to host unreachable", async () => {
    await prepareTeamGive("stage-unreachable-token");
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.move.stage") {
          mocks.trace.push("host:" + method);
          return Promise.reject(
            new RetryableTransportError({
              code: "RPC_ERROR",
              message: "The host connection failed before stage was sent.",
              requestId: "stage-unreachable",
              method,
              fatalDetails: null,
              replaySafetyFromKey: false,
            }),
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      message: "The host connection failed before stage was sent.",
    });
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.start");
  });

  it("keeps an unmarked host start error on the host RPC mapping", async () => {
    await prepareTeamGive("start-rpc-error-token");
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.move.start") {
          mocks.trace.push("host:" + method);
          return Promise.reject(
            new HostRpcError({
              code: "RPC_ERROR",
              message: "The host refused the start request.",
              requestId: "start-rpc-error",
              method,
              fatalDetails: null,
            }),
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "The host refused the start request.",
    });
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([calledMethod]) => calledMethod,
      ),
    ).not.toContain("environment.status");
  });

  it.each(["lost reply", "marked plain HostRpcError"] as const)(
    "polls the staged attempt after a start %s",
    async (kind) => {
      await prepareTeamGive("start-recovery-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.move.start") {
            mocks.trace.push("host:" + method);
            if (kind === "lost reply") {
              return Promise.reject(
                new HostTransportFailureError({
                  code: "RPC_ERROR",
                  message: "The host restarted before answering start.",
                  requestId: "start-reply-lost",
                  method,
                  fatalDetails: null,
                }),
              );
            }
            const error = new HostRpcError({
              code: "RPC_ERROR",
              message: "The host connection ended after dispatch.",
              requestId: "marked-start-error",
              method,
              fatalDetails: null,
            });
            markMayHaveReachedHost(error);
            return Promise.reject(error);
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).resolves.toEqual(teamBinding);

      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
          ([calledMethod]) => calledMethod === "environment.move.start",
        ),
      ).toHaveLength(1);
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([calledMethod]) => calledMethod,
        ),
      ).toContain("environment.status");
    },
  );

  it("keeps polling when status move is null until the explicit team binding appears", async () => {
    await prepareTeamGive("null-move-binding-token");
    let statusRead = 0;
    let bindingRead = 0;
    mocks.probeHostHealthMock.mockImplementation(
      async (options: HealthProbeOptions) => {
        if (options.checkReadiness === null)
          return { healthy: false, detail: "readiness unavailable" };
        for (const remainingMs of [45_000, 30_000]) {
          const ready = await options.checkReadiness(
            mocks.replacementMetadata ?? hostPidMetadata({}),
            remainingMs,
          );
          if (ready) return { healthy: true, detail: "team binding confirmed" };
        }
        return { healthy: false, detail: "team binding not ready" };
      },
    );
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.status") {
          mocks.trace.push("host:" + method);
          statusRead += 1;
          return Promise.resolve({ move: null });
        }
        if (method === "environment.host.read") {
          mocks.trace.push("host:" + method);
          bindingRead += 1;
          return Promise.resolve(
            bindingRead === 1 ? personalBinding : teamBinding,
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(statusRead).toBe(2);
    expect(bindingRead).toBe(2);
  });

  it.each([
    { name: "a binding that is not explicit", binding: notExplicitTeamBinding },
    {
      name: "an explicit binding in another environment",
      binding: otherEnvironmentBinding,
    },
  ])(
    "returns the transfer line when the fake probe budget expires on $name",
    async ({ binding }) => {
      await prepareTeamGive("no-binding-token");
      let statusRead = 0;
      let bindingRead = 0;
      mocks.probeHostHealthMock.mockImplementation(
        async (options: HealthProbeOptions) => {
          if (options.checkReadiness === null)
            return { healthy: false, detail: "readiness unavailable" };
          for (const remainingMs of [45_000, 20_000, 1]) {
            const ready = await options.checkReadiness(
              mocks.replacementMetadata ?? hostPidMetadata({}),
              remainingMs,
            );
            if (ready) return { healthy: true, detail: "ready" };
          }
          return { healthy: false, detail: "fake probe budget exhausted" };
        },
      );
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.status") {
            mocks.trace.push("host:" + method);
            statusRead += 1;
            return Promise.resolve({ move: null });
          }
          if (method === "environment.host.read") {
            mocks.trace.push("host:" + method);
            bindingRead += 1;
            return Promise.resolve(binding);
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });
      expect(statusRead).toBe(3);
      expect(bindingRead).toBe(3);
      expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
    },
  );

  it("stops immediately for our own needs_person status without reading the binding", async () => {
    await prepareTeamGive("needs-person-token");
    let bindingRead = 0;
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.status") {
          mocks.trace.push("host:" + method);
          return Promise.resolve({
            move: {
              state: "needs_person",
              attemptId: MOVE_ATTEMPT_ID,
              acceptanceId: MOVE_ACCEPTANCE_ID,
              reason: "move_acceptance_conflict",
            },
          });
        }
        if (method === "environment.host.read") {
          bindingRead += 1;
          return Promise.resolve(teamBinding);
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });
    expect(bindingRead).toBe(0);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it("treats another attempt's needs_person as advisory until the binding arrives", async () => {
    await prepareTeamGive("other-attempt-token");
    let statusRead = 0;
    let bindingRead = 0;
    mocks.probeHostHealthMock.mockImplementation(
      async (options: HealthProbeOptions) => {
        if (options.checkReadiness === null)
          return { healthy: false, detail: "readiness unavailable" };
        for (const remainingMs of [45_000, 30_000]) {
          const ready = await options.checkReadiness(
            mocks.replacementMetadata ?? hostPidMetadata({}),
            remainingMs,
          );
          if (ready) return { healthy: true, detail: "team binding confirmed" };
        }
        return { healthy: false, detail: "team binding not ready" };
      },
    );
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.status") {
          mocks.trace.push("host:" + method);
          statusRead += 1;
          return Promise.resolve({
            move: {
              state: "needs_person",
              attemptId: "00000000-0000-4000-8000-000000000099",
              acceptanceId: MOVE_ACCEPTANCE_ID,
              reason: "move_acceptance_conflict",
            },
          });
        }
        if (method === "environment.host.read") {
          mocks.trace.push("host:" + method);
          bindingRead += 1;
          return Promise.resolve(
            bindingRead === 1 ? personalBinding : teamBinding,
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);
    expect(statusRead).toBe(2);
    expect(bindingRead).toBe(2);
  });

  it("continues after a poll socket closes and reaches the host's new pid and port", async () => {
    await prepareTeamGive("poll-restart-token");
    const replacement = mocks.replacementMetadata;
    if (replacement === null) throw new Error("replacement metadata missing");
    const probeMetadata = [
      hostPidMetadata({ websocketUrl: "ws://127.0.0.1:1/rpc" }),
      replacement,
    ];
    let probeRead = 0;
    mocks.probeHostHealthMock.mockImplementation(
      async (options: HealthProbeOptions) => {
        if (options.checkReadiness === null)
          return { healthy: false, detail: "readiness unavailable" };
        for (const metadata of probeMetadata) {
          probeRead += 1;
          const ready = await options.checkReadiness(metadata, 10_000);
          if (ready) return { healthy: true, detail: "team binding confirmed" };
        }
        return { healthy: false, detail: "host did not return" };
      },
    );
    let statusRead = 0;
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.status") {
          mocks.trace.push("host:" + method);
          statusRead += 1;
          if (statusRead === 1)
            return Promise.reject(
              new RetryableTransportError({
                code: "RPC_ERROR",
                message: "The host closed the status connection.",
                requestId: "poll-connection-closed",
                method,
                fatalDetails: null,
                replaySafetyFromKey: false,
              }),
            );
          return Promise.resolve({ move: null });
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(probeRead).toBe(2);
    expect(statusRead).toBe(2);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls
        .filter(([method]) => method === "environment.status")
        .map(([, , endpoint]) => endpoint),
    ).toEqual([
      { hostId: TEST_HOST_ID, websocketUrl: "ws://127.0.0.1:1/rpc" },
      { hostId: TEST_HOST_ID, websocketUrl: "ws://127.0.0.1:2/rpc" },
    ]);
  });

  it.each(["running", "retry", "done"] as const)(
    "reads the binding after start answers %s",
    async (startState) => {
      await prepareTeamGive("start-" + startState + "-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.move.start") {
            mocks.trace.push("host:" + method);
            return Promise.resolve(moveOutcome(startState));
          }
          if (method === "environment.status") {
            mocks.trace.push("host:" + method);
            return Promise.resolve({ move: null });
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).resolves.toEqual(teamBinding);

      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toContain("environment.status");
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toContain("environment.host.read");
    },
  );

  it.each([
    {
      label: "acceptance conflict",
      state: "needs_person" as const,
      reason: "move_acceptance_conflict" as const,
    },
    {
      label: "plan hash mismatch",
      state: "needs_person" as const,
      reason: "plan_hash_mismatch" as const,
    },
    { label: "unknown attempt", state: "not_found" as const },
  ])(
    "ends the give when start answers $label without polling",
    async ({ state, reason, label }) => {
      await prepareTeamGive("start-" + label + "-token");
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) => {
          if (method === "environment.move.start") {
            mocks.trace.push("host:" + method);
            return Promise.resolve(moveOutcome(state, reason));
          }
          return defaultMoveHostReply(method, params);
        },
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TEAM_TRANSFER_FAILURE,
      });
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).toContain("environment.move.start");
      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
          ([method]) => method,
        ),
      ).not.toContain("environment.status");
      expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
    },
  );

  it("maps a non-awaiting start error without polling", async () => {
    await prepareTeamGive("start-not-awaiting-token");
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.move.start") {
          mocks.trace.push("host:" + method);
          return Promise.reject(
            new HostRpcError({
              code: "E_MOVE_NOT_AWAITING",
              message: "no move is waiting",
              requestId: "start-not-awaiting",
              method,
              fatalDetails: null,
            }),
          );
        }
        return defaultMoveHostReply(method, params);
      },
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TEAM_TRANSFER_FAILURE,
    });
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.status");
  });

  it("keeps existing team selection and guard failures ahead of planning", async () => {
    await writeStoredCredentials("guard-token");
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "guard-token",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.readHostOwnershipMock
      .mockReset()
      .mockResolvedValue(
        hostOwnership(
          { kind: "team", id: TEST_OTHER_TEAM_ID, name: "Other" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM,
    });
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain("environment.move.plan");
  });

  it("returns null without reading credentials when nothing was started", async () => {
    // `"none"` is the one gate independent of auth state - it covers the
    // no-op ensure and the bytes-only install alike. Reading credentials
    // here would be pointless work, and probing would dial a host this run
    // never touched.
    const result = await maybeProvisionCredential(
      fakeCtx(),
      "none",
      signedIn(),
    );

    expect(result).toBeNull();
    expect(mocks.resolveHostAuthMock).not.toHaveBeenCalled();
    expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
  });

  it("probes when credentials appeared after an unauthenticated pre-flight", async () => {
    // The regression: a signed-out pre-flight used to short-circuit before
    // the re-read, so a `traycer login` that completed in another terminal
    // while this install was downloading left the just-started host
    // unprovisioned - despite perfectly good credentials being on disk by
    // the time it came up.
    mocks.resolveHostAuthMock.mockResolvedValue(storedAuth());
    const outcome: HostCredentialProvisionOutcome = {
      kind: "active",
      minted: true,
    };
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue(outcome);

    const result = await maybeProvisionCredential(
      fakeCtx(),
      "install",
      unauthenticated(),
    );

    expect(result).toEqual(outcome);
    expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the pre-flight was unauthenticated and credentials are still absent", async () => {
    // Nothing changed across the install, so there is nothing new to say -
    // the pre-flight already warned. In particular this must NOT claim
    // `unauthorized`, which tells the operator their sign-in went bad.
    mocks.resolveHostAuthMock.mockResolvedValue(null);

    const result = await maybeProvisionCredential(
      fakeCtx(),
      "install",
      unauthenticated(),
    );

    expect(result).toBeNull();
    expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
  });

  it("reports unauthorized when a signed-in pre-flight's credentials disappeared", async () => {
    // A concurrent sign-out (or a corrupted file) between the pre-flight and
    // the probe. Returning null would print a summary claiming a signed-in
    // user with no provisioning attempt at all, while the just-started host
    // cannot serve work.
    mocks.resolveHostAuthMock.mockResolvedValue(null);

    const result = await maybeProvisionCredential(
      fakeCtx(),
      "install",
      signedIn(),
    );

    expect(result).toEqual<HostCredentialProvisionOutcome>({
      kind: "unauthorized",
    });
    expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
  });

  it("maps a throw from the probe to an error outcome instead of propagating it", async () => {
    // The probe runs AFTER the bytes are swapped and the service started, so
    // an escape would report a completed command as a failed one.
    mocks.resolveHostAuthMock.mockResolvedValue(storedAuth());
    mocks.provisionInstalledHostCredentialMock.mockRejectedValue(
      new Error("simulated probe explosion"),
    );

    const result = await maybeProvisionCredential(
      fakeCtx(),
      "start",
      signedIn(),
    );

    expect(result).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: "simulated probe explosion",
    });
  });
});
