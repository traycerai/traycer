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

// Keep the network out while exercising the real team selection and bind
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
const teamEnvironment = {
  environmentId: "environment-acme",
  ownerKind: "organization",
  ownerId: "organization-acme",
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
  ownerId: "organization-label-collision",
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
  hostId: "host-local",
  environment: teamEnvironment,
  explicit: true,
  enrolledByUserId: "member-1",
  canUnbind: true,
};
const personalBinding = {
  hostId: "host-local",
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
      hostId: "host-local",
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
        teamId: "organization-acme",
        environmentId: teamEnvironment.environmentId,
        slug: "acme",
      },
      {
        teamId: "organization-label-collision",
        environmentId: collidingLabelEnvironment.environmentId,
        slug: "other-team",
      },
    ],
  });
}

function hostPidMetadata(overrides: Partial<HostPidMetadata>): HostPidMetadata {
  return {
    pid: 4100,
    hostId: "host-local",
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
    mocks.refreshOutcome = "rotated";
    mocks.refreshedToken = "refreshed-bearer";
    mocks.resolveEndpointMock.mockResolvedValue({
      hostId: "host-local",
      websocketUrl: "ws://127.0.0.1:1/rpc",
    });
    mocks.readHostPidMetadataMock.mockResolvedValue({
      pid: 4100,
      hostId: "host-local",
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
      hostId: "host-local",
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
      if (method === "environment.list") {
        return Promise.resolve({ environments: [teamEnvironment] });
      }
      if (method === "environment.host.read") {
        return Promise.resolve(personalBinding);
      }
      return Promise.resolve(teamBinding);
    });
    mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
      (method: string, params: unknown) => {
        if (method === "environment.host.read")
          return Promise.resolve(personalBinding);
        if (method === "environment.host.bind")
          return Promise.resolve(teamBinding);
        if (method === "host.status") return Promise.resolve({ ready: true });
        throw new Error(`unexpected host RPC ${method} ${String(params)}`);
      },
    );
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "stored-bearer",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.validateIdentityMock.mockResolvedValue({
      kind: "valid",
      user: defaultSignInUser(),
    });
    mocks.mintTeamInstallTokenMock.mockResolvedValue({
      kind: "ok",
      token: "team-install-secret",
      environmentId: "environment-acme",
      expiresAt: 1_800_000_000,
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

  it("discloses transfer once before both binds and reports restart progress during recovery", async () => {
    const order: string[] = [];
    const progress = vi.fn(
      (info: { readonly stage: string; readonly message: string | null }) => {
        order.push(`progress:${info.message ?? ""}`);
        expect(info.stage).toBe("host-team");
      },
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
          "personal",
        ),
      );
    mocks.callHostRpcAtResolvedEndpointMock
      .mockImplementationOnce((method: string) => {
        order.push(method);
        return Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "WebSocket closed before the response arrived",
            requestId: "team-bind-recovery",
            method: "environment.host.bind",
            fatalDetails: null,
          }),
        );
      })
      .mockImplementation((method: string) => {
        order.push(method);
        if (method === "environment.host.bind") {
          return Promise.resolve(teamBinding);
        }
        if (method === "host.status") return Promise.resolve({ ready: true });
        throw new Error(`unexpected host RPC ${method}`);
      });

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in", reason: null },
          inlineSignInToken: null,
        },
        progress,
      ),
    ).resolves.toEqual(teamBinding);

    expect(progress).toHaveBeenCalledWith({
      stage: "host-team",
      message: "Restarting Traycer on this computer to run as acme…",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    const disclosureMessages = progress.mock.calls
      .map(([info]) => info.message)
      .filter((message) =>
        TEAM_TRANSFER_DISCLOSURE.some((disclosure) => disclosure === message),
      );
    expect(disclosureMessages).toEqual([...TEAM_TRANSFER_DISCLOSURE]);
    const firstBind = order.indexOf("environment.host.bind");
    const disclosureProgressIndexes = TEAM_TRANSFER_DISCLOSURE.map((line) =>
      order.indexOf(`progress:${line}`),
    );
    expect(Math.max(...disclosureProgressIndexes)).toBeLessThan(firstBind);
    expect(
      order.filter((entry) => entry === "environment.host.bind"),
    ).toHaveLength(2);
    expect(progress).toHaveBeenCalledTimes(TEAM_TRANSFER_DISCLOSURE.length + 1);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
  });

  it("the CLI does not send a team target to a host that cannot transfer", async () => {
    const legacyHost = new LegacyTeamHost();
    mocks.legacyHost = legacyHost;

    await expect(buildHostUseCommand("acme")(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: expect.stringContaining("traycer host update"),
    });
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
          { kind: "team", id: "organization-acme", name: "Acme" },
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

  it("uses the sign-in team's slug when host environment labels collide", async () => {
    const token = "pre-existing-token";
    await writeStoredCredentials(token);
    mocks.callHostRpcMock.mockImplementation((method: string) => {
      if (method === "environment.list") {
        return Promise.resolve({
          environments: [teamEnvironment, collidingLabelEnvironment],
        });
      }
      if (method === "environment.host.read")
        return Promise.resolve(personalBinding);
      return Promise.resolve(teamBinding);
    });
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
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
    ).resolves.toEqual(teamBinding);

    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);
    expect(mocks.callHostRpcMock).not.toHaveBeenCalled();

    expect(
      mocks.callHostRpcAtResolvedEndpointMock,
    ).toHaveBeenCalledExactlyOnceWith(
      "environment.host.bind",
      { environmentId: teamEnvironment.environmentId },
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:1/rpc" },
      {
        token: "stored-bearer",
        authnBaseUrl: "https://authn.test",
        userId: "member-1",
      },
      expect.objectContaining({
        requiredHostMethodVersion: {
          method: "environment.host.bind",
          version: { major: 1, minor: 1 },
        },
      }),
    );
    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("matches a team's canonical environment id as the selector", async () => {
    await writeStoredCredentials("pre-existing-token");
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
          "personal",
        ),
      );

    await expect(
      completeTeamInstall(
        teamEnvironment.environmentId,
        {
          preflight: { state: "signed-in", reason: null },
          inlineSignInToken: null,
        },
        vi.fn(),
      ),
    ).resolves.toEqual(teamBinding);

    expect(mocks.validateIdentityMock).toHaveBeenCalledTimes(1);

    expect(
      mocks.callHostRpcAtResolvedEndpointMock,
    ).toHaveBeenCalledExactlyOnceWith(
      "environment.host.bind",
      { environmentId: teamEnvironment.environmentId },
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:1/rpc" },
      {
        token: "stored-bearer",
        authnBaseUrl: "https://authn.test",
        userId: "member-1",
      },
      expect.objectContaining({
        requiredHostMethodVersion: {
          method: "environment.host.bind",
          version: { major: 1, minor: 1 },
        },
      }),
    );
  });

  it("prefers an exact environment id over another team's colliding slug", async () => {
    await writeStoredCredentials("pre-existing-token");
    const user = signInUser({
      personalEnvironmentId: null,
      teams: [
        {
          teamId: "organization-exact-id",
          environmentId: "shared-selector",
          slug: "exact-id-team",
        },
        {
          teamId: "organization-slug-match",
          environmentId: "environment-slug-match",
          slug: "shared-selector",
        },
      ],
    });
    mocks.validateIdentityMock.mockResolvedValue({ kind: "valid", user });
    mocks.callHostRpcAtResolvedEndpointMock.mockResolvedValueOnce({
      ...teamBinding,
      environment: {
        ...teamEnvironment,
        environmentId: "shared-selector",
        ownerId: "organization-exact-id",
        label: "exact-id-team",
      },
    });
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-exact-id", name: "Exact ID" },
          "personal",
        ),
      );

    await completeTeamInstall(
      "shared-selector",
      { preflight: signedIn(), inlineSignInToken: null },
      vi.fn(),
    );

    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledWith(
      "environment.host.bind",
      { environmentId: "shared-selector" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
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

  it("lists the signed-in teams and binds the selected team before clearing an inline-created sign-in", async () => {
    const token = "inline-team-token";
    await writeStoredCredentials(token);
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
          { kind: "team", id: "organization-acme", name: "Acme" },
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
    ).toEqual(["environment.host.bind"]);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock,
    ).toHaveBeenCalledExactlyOnceWith(
      "environment.host.bind",
      { environmentId: "environment-acme" },
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:1/rpc" },
      {
        token: "stored-bearer",
        authnBaseUrl: "https://authn.test",
        userId: "member-1",
      },
      expect.objectContaining({
        requiredHostMethodVersion: {
          method: "environment.host.bind",
          version: { major: 1, minor: 1 },
        },
      }),
    );
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
    expect(mocks.readHostOwnershipMock).toHaveBeenNthCalledWith(
      1,
      "https://authn.test",
      "stored-bearer",
      "host-local",
    );
    expect(mocks.readHostOwnershipMock).toHaveBeenNthCalledWith(
      2,
      "https://authn.test",
      "stored-bearer",
      "host-local",
    );
    const ownershipReads = mocks.readHostOwnershipMock.mock.invocationCallOrder;
    const identityReads = mocks.validateIdentityMock.mock.invocationCallOrder;
    const bindCalls =
      mocks.callHostRpcAtResolvedEndpointMock.mock.invocationCallOrder;
    expect(identityReads[0]).toBeLessThan(ownershipReads[0] ?? Infinity);
    expect(ownershipReads[0]).toBeLessThan(bindCalls[0] ?? Infinity);
    expect(ownershipReads[1]).toBeGreaterThan(bindCalls[0] ?? -Infinity);
    expect(credentialsAtOwnerChecks).toEqual([token, token]);
    expect(await readCredentialsFile(mocks.credentialsPath)).toBeNull();
  });

  it("keeps the inline-created sign-in when the team bind fails", async () => {
    const token = "inline-team-token";
    await writeStoredCredentials(token);
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new Error("bind failed"),
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

  it("confirms a sent bind after the replacement host answers its pinned binding read", async () => {
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
    mocks.callHostRpcAtResolvedEndpointMock
      .mockRejectedValueOnce(
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "WebSocket closed before the response arrived",
          requestId: "team-bind-lost-response",
          method: "environment.host.bind",
          fatalDetails: null,
        }),
      )
      .mockImplementationOnce(async (method: string) => {
        if (method !== "environment.host.read")
          throw new Error(`unexpected replacement RPC ${method}`);
        notifyReadStarted();
        return await hostRead;
      });
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
          "personal",
        ),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
          "personal",
        ),
      );

    const operation = completeTeamInstall(
      "acme",
      {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      },
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
    const bindCalls = mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
      ([method]) => method === "environment.host.bind",
    );
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0]).toEqual([
      "environment.host.bind",
      { environmentId: "environment-acme" },
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:1/rpc" },
      {
        token: "stored-bearer",
        authnBaseUrl: "https://authn.test",
        userId: "member-1",
      },
      expect.objectContaining({
        requiredHostMethodVersion: {
          method: "environment.host.bind",
          version: { major: 1, minor: 1 },
        },
      }),
    ]);
    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.map(
        ([method, _params, endpoint]) =>
          method === "environment.host.read" ? endpoint : null,
      ),
    ).toEqual([
      null,
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:2/rpc" },
    ]);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(3);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
  });

  it("allows one new bind only when both authoritative reads still say Personal", async () => {
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before the response arrived",
        requestId: "team-bind-lost-response",
        method: "environment.host.bind",
        fatalDetails: null,
      }),
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
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
    ).resolves.toEqual(teamBinding);

    const bindCalls = mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
      ([method]) => method === "environment.host.bind",
    );
    expect(bindCalls).toHaveLength(2);
    expect(bindCalls.map(([, , endpoint]) => endpoint)).toEqual([
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:1/rpc" },
      { hostId: "host-local", websocketUrl: "ws://127.0.0.1:2/rpc" },
    ]);
    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledTimes(3);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(4);
  });

  it("preserves a known team-transfer refusal instead of confirming around it", async () => {
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_ENVIRONMENT_NOT_A_MEMBER",
        message: "internal refusal details are discarded by the CLI",
        requestId: "team-bind-refused",
        method: "environment.host.bind",
        fatalDetails: null,
      }),
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
      code: "E_ENVIRONMENT_NOT_A_MEMBER",
      message: "Join the team before adding this computer.",
      exitCode: 1,
    });

    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledTimes(1);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      outcome: "the owner now belongs to another team",
      confirmation: hostOwnership(
        { kind: "team", id: "organization-other", name: "Other" },
        "personal",
      ),
    },
    {
      outcome: "the authoritative owner read does not return",
      confirmation: { kind: "network-error" } satisfies HostOwnershipResult,
    },
  ])(
    "keeps a sent bind outcome unknown when $outcome after the response is lost",
    async ({ confirmation }) => {
      mocks.callHostRpcAtResolvedEndpointMock
        .mockRejectedValueOnce(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "WebSocket closed before the response arrived",
            requestId: "team-bind-lost-response",
            method: "environment.host.bind",
            fatalDetails: null,
          }),
        )
        .mockResolvedValueOnce(teamBinding);
      mocks.readHostOwnershipMock
        .mockResolvedValueOnce(
          hostOwnership({ kind: "user", id: "member-1" }, "personal"),
        )
        .mockResolvedValueOnce(confirmation);

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
        code: "E_HOST_REQUEST_OUTCOME_UNKNOWN",
        exitCode: 1,
      });

      expect(
        mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
          ([method]) => method === "environment.host.bind",
        ),
      ).toHaveLength(1);
      expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a sent bind outcome unknown when only the old host answers after the drop", async () => {
    const replacementMetadata = mocks.replacementMetadata;
    if (replacementMetadata === null)
      throw new Error("replacement metadata was not installed");
    mocks.replacementMetadata = {
      ...replacementMetadata,
      pid: 4100,
    };
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before the response arrived",
        requestId: "team-bind-lost-response",
        method: "environment.host.bind",
        fatalDetails: null,
      }),
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
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
      code: "E_HOST_REQUEST_OUTCOME_UNKNOWN",
      exitCode: 1,
    });

    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledTimes(1);
    expect(mocks.probeHostHealthMock).toHaveBeenCalledTimes(1);
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { metadata: null, reason: "initial metadata is absent" },
    {
      metadata: hostPidMetadata({ hostId: "different-host" }),
      reason: "initial metadata names a different host",
    },
    {
      metadata: hostPidMetadata({ websocketUrl: "ws://127.0.0.1:3/rpc" }),
      reason: "initial metadata names a different endpoint",
    },
  ])("keeps a sent bind outcome unknown when $reason", async ({ metadata }) => {
    mocks.readHostPidMetadataMock.mockResolvedValueOnce(metadata);
    mocks.callHostRpcAtResolvedEndpointMock.mockRejectedValueOnce(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before the response arrived",
        requestId: "team-bind-lost-response",
        method: "environment.host.bind",
        fatalDetails: null,
      }),
    );
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
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
      code: "E_HOST_REQUEST_OUTCOME_UNKNOWN",
      exitCode: 1,
    });

    expect(
      mocks.callHostRpcAtResolvedEndpointMock.mock.calls.filter(
        ([method]) => method === "environment.host.bind",
      ),
    ).toHaveLength(1);
    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(mocks.readHostOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it("does not clear a newer sign-in that replaced the inline token during owner confirmation", async () => {
    const token = "inline-team-token";
    const replacement = "concurrent-login-token";
    const session: TeamInstallAuthSession = {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: token,
    };
    await writeStoredCredentials(token);
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockImplementationOnce(async () => {
        await writeStoredCredentials(replacement);
        return hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
          "personal",
        );
      });

    await completeTeamInstall("acme", session, vi.fn());

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
    const ctx = fakeCtx();
    const session: TeamInstallAuthSession = {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: "inline-team-token",
    };

    await warnIfTeamInstallSignInRemains(ctx, session);

    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
  });

  it("keeps the inline-created sign-in when the registry does not confirm the team owner after bind", async () => {
    const token = "inline-team-token";
    await writeStoredCredentials(token);

    await expect(
      completeTeamInstall(
        "acme",
        {
          preflight: { state: "signed-in-inline", reason: null },
          inlineSignInToken: token,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "E_HOST_REQUEST_OUTCOME_UNKNOWN" });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("accepts an existing same-team owner plus explicit binding without changing the stored sign-in", async () => {
    const token = "pre-existing-token";
    await writeStoredCredentials(token);
    mocks.callHostRpcAtResolvedEndpointMock.mockResolvedValue(teamBinding);
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership(
        { kind: "team", id: "organization-acme", name: "Acme" },
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

  it("refuses a sandbox host before attempting a team bind", async () => {
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
        { kind: "team", id: "organization-other", name: "Other" },
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

  it("retains a pre-existing sign-in after the team bind", async () => {
    const token = "pre-existing-token";
    await writeStoredCredentials(token);
    mocks.readHostOwnershipMock
      .mockResolvedValueOnce(
        hostOwnership({ kind: "user", id: "member-1" }, "personal"),
      )
      .mockResolvedValueOnce(
        hostOwnership(
          { kind: "team", id: "organization-acme", name: "Acme" },
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

  it("treats an unreadable stored sign-in as signed out and keeps its diagnostic at debug level", async () => {
    const diagnostic =
      "stored-credentials-marker path=/private/test/credentials body=distinctive";
    const ctx = fakeCtx();
    const warn = vi.fn();
    const debug = vi.fn();
    ctx.runtime.logger = { ...ctx.runtime.logger, warn, debug };
    mocks.resolveHostAuthMock.mockRejectedValue(new Error(diagnostic));

    const result = await maybeProvisionCredential(ctx, "start", null);

    expect(result).toBeNull();
    expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Host install could not read the stored credentials; treating as signed out",
      { environment: "production", stage: "provision", kind: "error" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(diagnostic);
    expect(JSON.stringify(debug.mock.calls)).toContain(diagnostic);
  });

  it("maps a thrown probe to an error outcome and keeps its diagnostic at debug level", async () => {
    // The probe runs AFTER the bytes are swapped and the service started, so
    // an escape would report a completed command as a failed one.
    const diagnostic =
      "credential-probe-marker path=/private/test/credentials body=distinctive";
    const ctx = fakeCtx();
    const warn = vi.fn();
    const debug = vi.fn();
    ctx.runtime.logger = { ...ctx.runtime.logger, warn, debug };
    mocks.resolveHostAuthMock.mockResolvedValue(storedAuth());
    mocks.provisionInstalledHostCredentialMock.mockRejectedValue(
      new Error(diagnostic),
    );

    const result = await maybeProvisionCredential(ctx, "start", signedIn());

    expect(result).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: diagnostic,
    });
    expect(warn).toHaveBeenCalledWith(
      "Host credential provisioning threw; the command itself was unaffected",
      { kind: "error" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(diagnostic);
    expect(JSON.stringify(debug.mock.calls)).toContain(diagnostic);
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
