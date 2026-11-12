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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCredentialsFile,
  writeCredentialsFile,
} from "@traycer/protocol/config/credentials";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";

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
  readHostOwnershipMock: vi.fn(),
  credentialsPath: "",
  legacyHost: null as LegacyTeamHost | null,
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: mocks.resolveHostAuthMock,
}));

vi.mock("../credential-provisioning", () => ({
  provisionInstalledHostCredential: mocks.provisionInstalledHostCredentialMock,
}));

// Keep the network out while exercising the real team selection and bind
// logic in install-auth.ts.
vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
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
  };
});

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
import { CLI_ERROR_CODES } from "../../runner/errors";

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

describe("install auth helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.legacyHost = null;
    caseCredentialsRoot = mkdtempSync(join(credentialsRoot, "case-"));
    mocks.credentialsPath = join(caseCredentialsRoot, "cli", "credentials");
    mocks.callHostRpcMock.mockImplementation((method: string) => {
      if (method === "environment.list") {
        return Promise.resolve({ environments: [teamEnvironment] });
      }
      if (method === "environment.host.read") {
        return Promise.resolve(personalBinding);
      }
      return Promise.resolve(teamBinding);
    });
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "stored-bearer",
      authnBaseUrl: "https://authn.test",
      userId: "member-1",
    });
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership({ kind: "user", id: "member-1" }, "personal"),
    );
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
      kind: "active",
      minted: true,
    });
  });

  it("the CLI does not send a team target to a host that cannot transfer", async () => {
    const legacyHost = new LegacyTeamHost();
    mocks.legacyHost = legacyHost;

    await expect(buildHostUseCommand("acme")(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message: expect.stringContaining("traycer host update"),
    });
    expect(legacyHost.requests).toEqual([]);
    expect(mocks.callHostRpcMock.mock.calls.map(([method]) => method)).toEqual([
      "environment.list",
    ]);
    expect(mocks.readHostOwnershipMock).not.toHaveBeenCalled();
  });

  it("prefers an exact team slug when another team's display label collides", async () => {
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
      completeTeamInstall("acme", {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      }),
    ).resolves.toEqual(teamBinding);

    expect(mocks.callHostRpcMock).toHaveBeenCalledWith(
      "environment.host.bind",
      { environmentId: teamEnvironment.environmentId },
    );
    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("still accepts a team's canonical environment id as the selector", async () => {
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
      completeTeamInstall(teamEnvironment.environmentId, {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      }),
    ).resolves.toEqual(teamBinding);

    expect(mocks.callHostRpcMock).toHaveBeenCalledWith(
      "environment.host.bind",
      { environmentId: teamEnvironment.environmentId },
    );
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

    await completeTeamInstall("team/acme", {
      preflight: { state: "signed-in-inline", reason: null },
      inlineSignInToken: token,
    });

    expect(mocks.callHostRpcMock.mock.calls.map(([method]) => method)).toEqual([
      "environment.list",
      "environment.host.read",
      "environment.host.bind",
    ]);
    expect(mocks.callHostRpcMock.mock.calls[2]?.[1]).toEqual({
      environmentId: "environment-acme",
    });
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
    const bindCalls = mocks.callHostRpcMock.mock.invocationCallOrder;
    expect(ownershipReads[0]).toBeLessThan(bindCalls[2] ?? Infinity);
    expect(ownershipReads[1]).toBeGreaterThan(bindCalls[2] ?? -Infinity);
    expect(credentialsAtOwnerChecks).toEqual([token, token]);
    expect(await readCredentialsFile(mocks.credentialsPath)).toBeNull();
  });

  it("keeps the inline-created sign-in when the team bind fails", async () => {
    const token = "inline-team-token";
    await writeStoredCredentials(token);
    mocks.callHostRpcMock
      .mockResolvedValueOnce({ environments: [teamEnvironment] })
      .mockResolvedValueOnce(personalBinding)
      .mockRejectedValueOnce(new Error("bind failed"));

    await expect(
      completeTeamInstall("acme", {
        preflight: { state: "signed-in-inline", reason: null },
        inlineSignInToken: token,
      }),
    ).rejects.toThrow();

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
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

    await completeTeamInstall("acme", session);

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
      completeTeamInstall("acme", {
        preflight: { state: "signed-in-inline", reason: null },
        inlineSignInToken: token,
      }),
    ).rejects.toMatchObject({ code: "E_HOST_REQUEST_OUTCOME_UNKNOWN" });

    expect((await readCredentialsFile(mocks.credentialsPath))?.token).toBe(
      token,
    );
  });

  it("accepts an existing same-team owner plus explicit binding without changing the stored sign-in", async () => {
    const token = "pre-existing-token";
    await writeStoredCredentials(token);
    mocks.callHostRpcMock.mockImplementation((method: string) => {
      if (method === "environment.list") {
        return Promise.resolve({ environments: [teamEnvironment] });
      }
      return Promise.resolve(teamBinding);
    });
    mocks.readHostOwnershipMock.mockResolvedValue(
      hostOwnership(
        { kind: "team", id: "organization-acme", name: "Acme" },
        "personal",
      ),
    );

    const binding = await completeTeamInstall("acme", {
      preflight: { state: "signed-in", reason: null },
      inlineSignInToken: null,
    });

    expect(binding).toEqual(teamBinding);
    expect(mocks.callHostRpcMock).not.toHaveBeenCalledWith(
      "environment.host.bind",
      expect.anything(),
    );
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
      completeTeamInstall("acme", {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      }),
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
      completeTeamInstall("acme", {
        preflight: { state: "signed-in", reason: null },
        inlineSignInToken: null,
      }),
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

    await completeTeamInstall("acme", {
      preflight: { state: "signed-in", reason: null },
      inlineSignInToken: null,
    });

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
});
