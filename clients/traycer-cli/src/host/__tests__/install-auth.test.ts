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
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import { environmentStatusResponseSchemaV13 } from "@traycer/protocol/host/environment-schemas";
import {
  environmentMoveOutcomeAnswerSchema,
  environmentMovePlanResponseSchemaV20,
  environmentMoveStageRequestSchema,
  environmentMoveStageResponseSchema,
} from "@traycer/protocol/host/environment/move-contracts";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import type { HostPidMetadata } from "../pid-metadata";
import type { HealthProbeOptions } from "../../service/health-probe";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

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
  validateIdentityMock: vi.fn(),
  createStoreBackedRevalidatorMock: vi.fn(),
  revalidateCurrentContextMock: vi.fn(),
  refreshOutcome: "rotated" as "rotated" | "rejected" | "network-error",
  refreshedToken: "refreshed-bearer",
}));

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return { ...actual, resolveHostAuth: mocks.resolveHostAuthMock };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    validateAuthTokenIdentityAccessOnly: mocks.validateIdentityMock,
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createStoreBackedRevalidator: (
      ...args: Parameters<typeof actual.createStoreBackedRevalidator>
    ) => mocks.createStoreBackedRevalidatorMock(...args),
  };
});

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

vi.mock("../credential-provisioning", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../credential-provisioning")>();
  return {
    ...actual,
    provisionInstalledHostCredential:
      mocks.provisionInstalledHostCredentialMock,
  };
});

// Keep the network out while exercising the real team selection and give
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
        ? mocks.callHostRpcMock(callArgs[0], callArgs[1])
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

// The token's mint is authn's; the command suites run the real mint against a
// stubbed answer, and this suite pins what the attended install decides.
vi.mock(
  "@traycer-clients/shared/host-client/team-computer-install",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/team-computer-install")
      >();
    return {
      ...actual,
      mintTeamComputerInstallTokenViaHttp: (
        ...callArgs: Parameters<
          typeof actual.mintTeamComputerInstallTokenViaHttp
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
      ) => mocks.readHostOwnershipMock(authnBaseUrl, bearerToken, hostId),
    };
  },
);

import {
  beginAttendedTeamInstall,
  completeTeamInstall,
  maybeProvisionCredential,
  provisionRunningHostCredential,
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
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

const credentialsRoot = mkdtempSync(join(tmpdir(), "team-install-auth-test-"));
let caseCredentialsRoot = "";
const TEST_HOST_ID = "00000000-0000-4000-8000-000000000001";
const TEST_TEAM_ID = "00000000-0000-4000-8000-000000000002";
const TEST_OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000003";
const TEST_EXACT_TEAM_ID = "00000000-0000-4000-8000-000000000006";
const TEST_SLUG_TEAM_ID = "00000000-0000-4000-8000-000000000007";
const TEST_OTHER_OWNER_TEAM_ID = "00000000-0000-4000-8000-000000000008";
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
  ownerId: TEST_OTHER_TEAM_ID,
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
const personalBinding = {
  hostId: TEST_HOST_ID,
  environment: personalEnvironment,
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

const MOVE_ATTEMPT_ID = "00000000-0000-4000-8000-000000000004";
const MOVE_ACCEPTANCE_ID = "00000000-0000-4000-8000-000000000005";
const MOVE_PLAN_HASH = "a".repeat(64);
const MOVE_DISCLOSURE_HASH = "b".repeat(64);
const TRANSFER_LINE =
  "The team transfer could not be confirmed. Check this computer in the app before trying again.";
const RESTARTING_LINE = "Restarting Traycer on this computer to run as acme…";
const REPLACEMENT_ENDPOINT = {
  hostId: TEST_HOST_ID,
  websocketUrl: "ws://127.0.0.1:2/rpc",
};

function movePlan() {
  return environmentMovePlanResponseSchemaV20.parse({
    planHash: MOVE_PLAN_HASH,
    planRevision: 3,
    hostVersion: "1.2.3",
    disclosureVersion: 2,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
    },
    guideDiffers: false,
    personalHoldsSecrets: false,
  });
}

/** The team a give call names, which the staged evidence has to repeat. */
function movedTarget(params: unknown): {
  readonly environmentId: string;
  readonly teamId: string;
} {
  const { target } = environmentMoveStageRequestSchema.parse(params);
  if (target.kind !== "team")
    throw new Error("the host call named no team target");
  return { environmentId: target.environmentId, teamId: target.teamId };
}

function moveStage(params: unknown) {
  const target = movedTarget(params);
  return environmentMoveStageResponseSchema.parse({
    evidence: {
      attemptId: MOVE_ATTEMPT_ID,
      planHash: MOVE_PLAN_HASH,
      planRevision: 3,
      hostVersion: "1.2.3",
      itemCount: 0,
      keyChoices: [],
      sourceHostId: TEST_HOST_ID,
      sharingGeneration: 1,
      targetKind: "team",
      environmentId: target.environmentId,
      teamId: target.teamId,
      disclosureVersion: 2,
    },
    authorization: { disclosureHash: MOVE_DISCLOSURE_HASH },
  });
}

function moveOutcome(state: "running" | "done") {
  return environmentMoveOutcomeAnswerSchema.parse({
    state,
    attemptId: MOVE_ATTEMPT_ID,
    acceptanceId: MOVE_ACCEPTANCE_ID,
  });
}

/** A computer that takes the give: it plans, stages, starts, and is then the team's. */
function defaultMoveHostReply(
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "environment.move.plan":
      return Promise.resolve(movePlan());
    case "environment.move.stage":
      return Promise.resolve(moveStage(params));
    case "environment.move.start":
      return Promise.resolve(moveOutcome("running"));
    case "environment.status":
      return Promise.resolve(
        environmentStatusResponseSchemaV13.parse({
          principal: null,
          reachability: "connected",
          bindingGeneration: 1,
          desiredRevision: null,
          receivedRevision: null,
          appliedRevision: null,
          receiptAgeMs: 0,
          items: [],
          pendingUploads: [],
          setup: null,
          remoteAccess: "off",
          move: moveOutcome("done"),
        }),
      );
    case "environment.host.read":
      return Promise.resolve(teamBinding);
    default:
      return Promise.reject(new Error(`unexpected host RPC ${method}`));
  }
}

function hostCalls(method: string): readonly (readonly unknown[])[] {
  return mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
    ([called]) => called === method,
  );
}

const PLANNED_TEAM = {
  target: {
    kind: "team",
    environmentId: "environment-acme",
    teamId: TEST_TEAM_ID,
  },
  personal: null,
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
  await writeCredentialsFile(
    mocks.credentialsPath,
    {
      token,
      refreshToken: `${token}-refresh`,
      savedAt: "2026-11-10T00:00:00.000Z",
      user: { id: "member-1", email: "member@example.test", name: "Member" },
    },
    0,
  );
}

/** The stored sign-in is the one the command pins: the give acts only on its own. */
async function prepareTeamGive(token: string): Promise<void> {
  await writeStoredCredentials(token);
  mocks.resolveHostAuthMock.mockResolvedValue({
    token,
    authnBaseUrl: "https://authn.test",
    userId: "member-1",
  });
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

function signInUser(input: {
  readonly personalEnvironmentId: string | null;
  readonly teams: readonly {
    readonly teamId: string;
    readonly environmentId: string;
    readonly slug: string | null;
  }[];
}): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return {
    ...base,
    user: { ...base.user, id: "member-1" },
    environments: {
      personal: input.personalEnvironmentId,
      teams: input.teams.map(({ teamId, environmentId }) => ({
        teamId,
        environmentId,
      })),
    },
    teamSubscriptions: input.teams
      .filter((team) => team.slug !== null)
      .map(
        ({ teamId, slug }) =>
          ({
            team: { id: teamId, slug },
          }) as AuthenticatedUser["teamSubscriptions"][number],
      ),
  };
}

function defaultSignInUser(): AuthenticatedUser {
  return signInUser({
    personalEnvironmentId: "environment-personal",
    teams: [
      {
        teamId: TEST_TEAM_ID,
        environmentId: teamEnvironment.environmentId,
        slug: "acme",
      },
      {
        teamId: TEST_OTHER_TEAM_ID,
        environmentId: collidingLabelEnvironment.environmentId,
        slug: "other-team",
      },
    ],
  });
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
  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.legacyHost = null;
    mocks.refreshOutcome = "rotated";
    mocks.refreshedToken = "refreshed-bearer";
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
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      defaultMoveHostReply,
    );
    // The acceptance the give records at authn.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ acceptanceId: MOVE_ACCEPTANCE_ID }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await prepareTeamGive("stored-bearer");
    mocks.mintTeamInstallTokenMock.mockResolvedValue({
      kind: "ok",
      token: "team-install-secret",
      environmentId: "environment-acme",
      expiresAt: 1_800_000_000,
    });
    mocks.validateIdentityMock.mockResolvedValue({
      kind: "valid",
      user: defaultSignInUser(),
    });
    mocks.createStoreBackedRevalidatorMock.mockImplementation(
      (args: { readonly lease: { rotate(token: string): void } }) => {
        mocks.revalidateCurrentContextMock.mockImplementation(async () => {
          if (mocks.refreshOutcome === "rotated") {
            args.lease.rotate(mocks.refreshedToken);
          }
          return mocks.refreshOutcome;
        });
        return {
          revalidateCurrentContext: mocks.revalidateCurrentContextMock,
        };
      },
    );
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership({ kind: "user", id: "member-1" }, "personal"),
    );
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
      kind: "active",
      minted: true,
    });
  });

  it.each(["team/acme", "acme", "environment-acme"])(
    "mints by the resolved team's environment id when no enrollment record exists (typed as %s)",
    async (typed) => {
      const result = await beginAttendedTeamInstall(fakeCtx(), typed);

      expect(result).toEqual({
        kind: "enrol",
        session: { preflight: signedIn(), inlineSignInToken: null },
        slug: "acme",
        token: "team-install-secret",
        environmentId: "environment-acme",
      });
      expect(mocks.mintTeamInstallTokenMock).toHaveBeenCalledWith(
        "https://authn.test",
        "stored-bearer",
        "environment-acme",
      );
    },
  );

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

  it("prints the disclosure once, after the plan and before the give stages, then one restart line", async () => {
    const order: string[] = [];
    const progress = vi.fn(
      (info: { readonly stage: string; readonly message: string | null }) => {
        order.push(`progress:${info.message ?? ""}`);
        expect(info.stage).toBe("host-team");
      },
    );
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        order.push(method);
        return defaultMoveHostReply(method, params);
      },
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        progress,
      ),
    ).resolves.toEqual(teamBinding);

    expect(order).toEqual([
      "environment.move.plan",
      ...TEAM_TRANSFER_DISCLOSURE.map((line) => `progress:${line}`),
      `progress:${RESTARTING_LINE}`,
      "environment.move.stage",
      "environment.move.start",
      "environment.status",
      "environment.host.read",
    ]);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
  });

  it("the CLI does not send a team target to a host that cannot transfer", async () => {
    const legacyHost = new LegacyTeamHost();
    mocks.legacyHost = legacyHost;
    const ctx = fakeCtx();

    await expect(buildHostUseCommand("acme")(ctx)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: expect.stringContaining("traycer host update"),
    });
    // The plan is read before anything is printed, so a host that cannot
    // transfer is refused with no disclosure and no restart line.
    expect(ctx.progress).not.toHaveBeenCalled();
    expect(legacyHost.requests).toEqual([]);
    expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it("reports the team transfer through host use progress", async () => {
    const progress = vi.fn<CommandContext["progress"]>();
    const ctx: CommandContext = { ...fakeCtx(), progress };
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    await expect(buildHostUseCommand("acme")(ctx)).resolves.toMatchObject({
      data: { binding: teamBinding },
      human: "This computer belongs to Acme.",
    });

    expect(progress).toHaveBeenCalledWith({
      stage: "host-team",
      message: "Restarting Traycer on this computer to run as acme…",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    expect(progress).toHaveBeenCalledTimes(TEAM_TRANSFER_DISCLOSURE.length + 1);
    const disclosureMessages = progress.mock.calls
      .map(([info]) => info.message)
      .filter((message) =>
        TEAM_TRANSFER_DISCLOSURE.some((disclosure) => disclosure === message),
      );
    expect(disclosureMessages).toEqual([...TEAM_TRANSFER_DISCLOSURE]);
  });

  it("plans the transfer to the team the sign-in lists under the typed slug", async () => {
    const token = "pre-existing-token";
    await prepareTeamGive(token);
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
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

    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);
    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(hostCalls("environment.move.plan")).toHaveLength(1);
    expect(hostCalls("environment.move.plan")[0][1]).toEqual(PLANNED_TEAM);
    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("plans the transfer to the team a typed environment id names", async () => {
    await prepareTeamGive("pre-existing-token");
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        teamEnvironment.environmentId,
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);
    expect(hostCalls("environment.move.plan")[0][1]).toEqual(PLANNED_TEAM);
  });

  it("prefers an exact environment id over another team's colliding slug", async () => {
    await prepareTeamGive("pre-existing-token");
    const user = signInUser({
      personalEnvironmentId: null,
      teams: [
        {
          teamId: TEST_EXACT_TEAM_ID,
          environmentId: "shared-selector",
          slug: "exact-id-team",
        },
        {
          teamId: TEST_SLUG_TEAM_ID,
          environmentId: "environment-slug-match",
          slug: "shared-selector",
        },
      ],
    });
    mocks.validateIdentityMock.mockResolvedValue({ kind: "valid", user });
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) =>
        method === "environment.host.read"
          ? Promise.resolve({
              ...teamBinding,
              environment: {
                ...teamEnvironment,
                environmentId: "shared-selector",
                ownerId: TEST_EXACT_TEAM_ID,
                label: "exact-id-team",
              },
            })
          : defaultMoveHostReply(method, params),
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_EXACT_TEAM_ID, name: "Exact ID" },
          "personal",
        ),
      );

    await completeTeamInstall(
      "shared-selector",
      { preflight: signedIn(), inlineSignInToken: null },
      vi.fn(),
    );

    expect(hostCalls("environment.move.plan")[0][1]).toEqual({
      target: {
        kind: "team",
        environmentId: "shared-selector",
        teamId: TEST_EXACT_TEAM_ID,
      },
      personal: null,
    });
    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
  });

  it("asks for a team slug while the sign-in has no environments yet", async () => {
    mocks.validateIdentityMock.mockResolvedValue({
      kind: "valid",
      user: signInUser({ personalEnvironmentId: null, teams: [] }),
    });

    await expect(buildHostUseCommand("acme")(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "Enter the slug of a team you belong to, as shown in its dashboard address.",
      exitCode: 1,
    });
    expect(mocks.resolveEndpointMock).not.toHaveBeenCalled();
    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
  });

  it("gives the selected team before clearing an inline-created sign-in", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);
    const credentialsAtOwnerChecks: (string | null)[] = [];
    mocks.readHostOwnershipMock
      .mockImplementationOnce(async () => {
        credentialsAtOwnerChecks.push(
          (await readCredentialsFile(mocks.credentialsPath))?.token ?? null,
        );
        return hostOwnership({ kind: "user", id: "member-1" }, "personal");
      })
      .mockImplementationOnce(async () => {
        credentialsAtOwnerChecks.push(
          (await readCredentialsFile(mocks.credentialsPath))?.token ?? null,
        );
        return hostOwnership(
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

    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);
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
    expect(hostCalls("environment.move.plan")[0][1]).toEqual(PLANNED_TEAM);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
    expect(mocks.readHostOwnershipMock).toHaveBeenNthCalledWith(
      1,
      "https://authn.test",
      token,
      TEST_HOST_ID,
    );
    expect(mocks.readHostOwnershipMock).toHaveBeenNthCalledWith(
      2,
      "https://authn.test",
      token,
      TEST_HOST_ID,
    );
    const ownershipReads = mocks.readHostOwnershipMock.mock.invocationCallOrder;
    const identityReads = mocks.validateIdentityMock.mock.invocationCallOrder;
    const hostCallOrder =
      mocks.callHostRpcAtResolvedEndpointMock.mock.invocationCallOrder;
    expect(identityReads[0]).toBeLessThan(ownershipReads[0] ?? Infinity);
    expect(ownershipReads[0]).toBeLessThan(hostCallOrder[0] ?? Infinity);
    expect(ownershipReads[1]).toBeGreaterThan(hostCallOrder.at(-1) ?? Infinity);
    // The sign-in is still stored at both owner checks, and cleared after.
    expect(credentialsAtOwnerChecks).toEqual([token, token]);
    expect(await readCredentialsFile(mocks.credentialsPath)).toBeNull();
  });

  it("keeps the inline-created sign-in when the team transfer fails", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new Error("transfer failed"),
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
    ).rejects.toThrow();

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("follows a start whose reply was lost on the poll and confirms it once the restarted host answers", async () => {
    let notifyReadStarted: () => void = () => undefined;
    let resolveRead: (binding: typeof teamBinding) => void = () => {
      throw new Error("replacement read was not held");
    };
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const hostRead = new Promise<typeof teamBinding>((resolve) => {
      resolveRead = resolve;
    });
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "environment.move.start")
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "WebSocket closed before the response arrived",
            requestId: "team-start-lost-response",
            method: "environment.move.start",
            fatalDetails: null,
          });
        if (method === "environment.host.read") {
          notifyReadStarted();
          return await hostRead;
        }
        return await defaultMoveHostReply(method, params);
      },
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    const operation = completeTeamInstall(
      "acme",
      { preflight: signedIn(), inlineSignInToken: null },
      vi.fn(),
    );
    await readStarted;
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(settled).toBe(false);
    resolveRead(teamBinding);
    await expect(operation).resolves.toEqual(teamBinding);

    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();
    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);
    // The give is never sent twice: the lost start is followed on the poll.
    expect(hostCalls("environment.move.start")).toHaveLength(1);
    expect(
      [
        ...hostCalls("environment.status"),
        ...hostCalls("environment.host.read"),
      ].map(([, , endpoint]) => endpoint),
    ).toEqual([REPLACEMENT_ENDPOINT, REPLACEMENT_ENDPOINT]);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a known team-transfer refusal instead of confirming around it", async () => {
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) =>
        method === "environment.move.stage"
          ? Promise.reject(
              new HostRpcError({
                code: "E_ENVIRONMENT_NOT_A_MEMBER",
                message: "internal refusal details are discarded by the CLI",
                requestId: "team-stage-refused",
                method: "environment.move.stage",
                fatalDetails: null,
              }),
            )
          : defaultMoveHostReply(method, params),
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: "E_ENVIRONMENT_NOT_A_MEMBER",
      message: "Join the team before adding this computer.",
      exitCode: 1,
    });

    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toEqual(["environment.move.plan", "environment.move.stage"]);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      state: "needs_person",
      outcome: {
        state: "needs_person",
        attemptId: MOVE_ATTEMPT_ID,
        acceptanceId: MOVE_ACCEPTANCE_ID,
        reason: "move_acceptance_conflict",
      },
    },
    {
      state: "not_found",
      outcome: environmentMoveOutcomeAnswerSchema.parse({
        state: "not_found",
        attemptId: MOVE_ATTEMPT_ID,
      }),
    },
  ])(
    "ends with the transfer line, and does not wait, when the computer answers the start $state",
    async ({ outcome }) => {
      mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
        (method: string, params: unknown) =>
          method === "environment.move.start"
            ? Promise.resolve(outcome)
            : defaultMoveHostReply(method, params),
      );

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TRANSFER_LINE,
        exitCode: 1,
      });

      expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
      expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      outcome: "the owner now belongs to another team",
      confirmation: hostOwnership(
        { kind: "team", id: TEST_OTHER_OWNER_TEAM_ID, name: "Other" },
        "personal",
      ),
    },
    {
      outcome: "the authoritative owner read does not return",
      confirmation: { kind: "network-error" } satisfies HostOwnershipResult,
    },
  ])(
    "ends with the transfer line when $outcome after the restarted host answers as the team's",
    async ({ confirmation }) => {
      mocks.readHostOwnershipMock
        .mockResolvedValueOnce(
          hostOwnership({ kind: "user", id: "member-1" }, "personal"),
        )
        .mockResolvedValueOnce(confirmation);

      await expect(
        completeTeamInstall(
          "acme",
          { preflight: signedIn(), inlineSignInToken: null },
          vi.fn(),
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message: TRANSFER_LINE,
        exitCode: 1,
      });

      expect(hostCalls("environment.move.start")).toHaveLength(1);
      expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
    },
  );

  it("ends with the transfer line when the restarted host never answers as the team's", async () => {
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) =>
        method === "environment.host.read"
          ? Promise.resolve(personalBinding)
          : defaultMoveHostReply(method, params),
    );

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TRANSFER_LINE,
      exitCode: 1,
    });

    expect(hostCalls("environment.move.start")).toHaveLength(1);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    // The ownership read after the wait is never made for a wait that ran out.
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { metadata: null, reason: "the restarted host publishes no metadata" },
    {
      metadata: hostPidMetadata({
        hostId: "00000000-0000-4000-8000-000000000009",
      }),
      reason: "the published metadata names a different host",
    },
  ])("ends with the transfer line when $reason", async ({ metadata }) => {
    mocks.replacementMetadata = metadata;

    await expect(
      completeTeamInstall(
        "acme",
        { preflight: signedIn(), inlineSignInToken: null },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TRANSFER_LINE,
      exitCode: 1,
    });

    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toEqual([
      "environment.move.plan",
      "environment.move.stage",
      "environment.move.start",
    ]);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it("ends with the transfer line, and keeps a newer sign-in, when one replaces the inline token during owner confirmation", async () => {
    const token = "inline-team-token";
    const replacement = "concurrent-login-token";
    const session: TeamInstallAuthSession = {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: token,
    };
    await prepareTeamGive(token);
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockImplementationOnce(async () => {
        await writeStoredCredentials(replacement);
        return hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        );
      });

    // The sign-in moved after the command pinned it, so the give is not
    // confirmed as this command's: it fails closed.
    await expect(
      completeTeamInstall("acme", session, vi.fn()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message: TRANSFER_LINE,
      exitCode: 1,
    });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      replacement,
    );

    const ctx = fakeCtx();
    await warnIfTeamInstallSignInRemains(ctx, session);
    expect(ctx.output.humanRequired).toHaveBeenCalledExactlyOnceWith(
      "Your sign-in could still be on this computer. Run `traycer logout` to remove it.",
    );
  });

  it("does not warn when the command-created sign-in is no longer stored", async () => {
    rmSync(mocks.credentialsPath, { force: true });
    const ctx = fakeCtx();
    const session: TeamInstallAuthSession = {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: "inline-team-token",
    };

    await warnIfTeamInstallSignInRemains(ctx, session);

    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
  });

  it("keeps the inline-created sign-in when the registry does not confirm the team owner after the transfer", async () => {
    const token = "inline-team-token";
    await prepareTeamGive(token);

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
      code: "E_HOST_REQUEST_OUTCOME_UNKNOWN",
      message: TRANSFER_LINE,
    });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("accepts an existing same-team owner plus explicit binding without changing the stored sign-in", async () => {
    const token = "pre-existing-token";
    await prepareTeamGive(token);
    mocks.callHostRpcAtResolvedEndpointMock.mockResolvedValue(teamBinding);
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership(
        { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
        "personal",
      ),
    );

    const binding = await completeTeamInstall(
      "acme",
      {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      },
      vi.fn(),
    );

    expect(binding).toEqual(teamBinding);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method]) => method,
      ),
    ).toEqual(["environment.host.read"]);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("refuses a sandbox host before attempting a team transfer", async () => {
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership({ kind: "user", id: "member-1" }, "sandbox"),
    );

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in", reason: null },
          inlineSignInToken: null,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_IS_SANDBOX });
  });

  it("refuses a computer already owned by another team", async () => {
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership(
        { kind: "team", id: TEST_OTHER_OWNER_TEAM_ID, name: "Other" },
        "personal",
      ),
    );

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in", reason: null },
          inlineSignInToken: null,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM,
      message:
        "Claim this computer from its current team before adding it to another.",
    });
  });

  it("retains a pre-existing sign-in after the team transfer", async () => {
    const token = "pre-existing-token";
    await prepareTeamGive(token);
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: TEST_TEAM_ID, name: "Acme" },
          "personal",
        ),
      );

    await completeTeamInstall(
      "acme",
      {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      },
      vi.fn(),
    );

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
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

  it("routes login's running-host follow-up through the provisioning probe", async () => {
    const context = fakeCtx();
    const auth = storedAuth();
    const outcome: HostCredentialProvisionOutcome = {
      kind: "active",
      minted: true,
    };
    mocks.readHostPidMetadataMock.mockResolvedValue(
      hostPidMetadata({ pid: process.pid }),
    );
    mocks.resolveHostAuthMock.mockResolvedValue(auth);
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue(outcome);

    const result = await provisionRunningHostCredential(context);

    expect(result).toEqual(outcome);
    expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledTimes(1);
    expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: context.runtime.environment,
        auth,
        deadlineMs: 30_000,
      }),
    );
    expect(context.progress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "host-credential",
        message: "authorizing the running host...",
      }),
    );
  });

  describe("a sign-in environment read that cannot reach authn", () => {
    const commands = [
      {
        name: "host use",
        run: () => buildHostUseCommand("acme")(fakeCtx()),
      },
      {
        name: "host install --team and host ensure --team",
        run: () =>
          completeTeamInstall(
            "acme",
            {
              preflight: { state: "signed-in", reason: null },
              inlineSignInToken: null,
            },
            vi.fn<CommandContext["progress"]>(),
          ),
      },
    ];
    const reads = [
      {
        name: "the first read",
        stage: (): void => {
          mocks.validateIdentityMock.mockResolvedValue({
            kind: "network-error",
          });
        },
      },
      {
        name: "the refresh",
        stage: (): void => {
          mocks.validateIdentityMock.mockResolvedValueOnce({
            kind: "rejected",
          });
          mocks.refreshOutcome = "network-error";
        },
      },
      {
        name: "the read after a refresh",
        stage: (): void => {
          mocks.validateIdentityMock
            .mockResolvedValueOnce({ kind: "rejected" })
            .mockResolvedValueOnce({ kind: "network-error" });
        },
      },
    ];

    it.each(
      commands.flatMap((command) =>
        reads.map((read) => ({
          command,
          read,
          name: `${command.name}, ${read.name}`,
        })),
      ),
    )(
      "prints whoami's authn line, keeping its code and exit, for $name",
      async ({ command, read }) => {
        read.stage();

        await expect(command.run()).rejects.toMatchObject({
          code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
          message: "Could not reach the authn service; check your network.",
          exitCode: 1,
        });
        expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
      },
    );
  });
});
