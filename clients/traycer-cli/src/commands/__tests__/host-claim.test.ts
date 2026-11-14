import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostOwnership } from "@traycer-clients/shared/host-client/host-ownership";
import type { CommandContext } from "../../runner/runner";

const mocks = vi.hoisted(() => ({
  resolveHostAuthMock: vi.fn(),
  resolveEndpointMock: vi.fn(),
  callHostRpcAtResolvedEndpointMock: vi.fn(),
  provisionRunningHostCredentialMock: vi.fn(),
  questionMock: vi.fn(),
  closePromptMock: vi.fn(),
}));

vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: (...callArgs: unknown[]) =>
    mocks.resolveHostAuthMock(...callArgs),
}));

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    resolveEndpoint: (...callArgs: unknown[]) =>
      mocks.resolveEndpointMock(...callArgs),
    callHostRpcAtResolvedEndpoint: (...callArgs: unknown[]) =>
      mocks.callHostRpcAtResolvedEndpointMock(...callArgs),
  };
});

vi.mock("../../host/install-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/install-auth")>();
  return {
    ...actual,
    provisionRunningHostCredential: (...callArgs: unknown[]) =>
      mocks.provisionRunningHostCredentialMock(...callArgs),
  };
});

vi.mock("node:readline/promises", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:readline/promises")>();
  return {
    ...actual,
    createInterface: () => ({
      question: (...callArgs: unknown[]) => mocks.questionMock(...callArgs),
      close: () => mocks.closePromptMock(),
    }),
  };
});

import { buildHostClaimCommand } from "../host-claim";
import type { HostClaimArgs } from "../host-claim";
import { CLI_ERROR_CODES } from "../../runner/errors";

const HOST_ID = "host-local";
const TEAM_ID = "team-acme";
const ENVIRONMENT_ID = "environment-acme";
const AUTHN = "https://authn.example.test";
const BEARER = "fixture-bearer";

let requests: Array<{
  readonly url: string;
  readonly init: RequestInit | undefined;
}> = [];
let events: string[] = [];
let ownership: HostOwnership = {
  hostId: HOST_ID,
  owner: { kind: "team", id: TEAM_ID, name: "acme" },
  kind: "personal",
  remoteAccess: true,
};
let ownershipStatus = 200;
let releaseStatus = 204;
let questionAnswer = "y";
let savedStdinIsTTY: PropertyDescriptor | undefined;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeCtx(nonInteractive: boolean): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive,
      environment: "production",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

function makeClaimCommand(yes: boolean) {
  const args: HostClaimArgs = { yes };
  return buildHostClaimCommand(args);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v3/hosts") {
        events.push("ownership");
        return jsonResponse(ownershipStatus, { hosts: [ownership] });
      }
      if (parsed.pathname === `/api/v3/hosts/${HOST_ID}/team-release`) {
        events.push("release");
        if (releaseStatus === 204) return new Response(null, { status: 204 });
        if (releaseStatus === 409) {
          return jsonResponse(409, { code: "host_return_not_computer" });
        }
        return jsonResponse(releaseStatus, {});
      }
      return jsonResponse(404, {});
    }),
  );
  mocks.resolveHostAuthMock.mockResolvedValue({
    token: BEARER,
    authnBaseUrl: AUTHN,
    userId: "member-1",
  });
  mocks.resolveEndpointMock.mockResolvedValue({
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:1/rpc",
  });
  mocks.callHostRpcAtResolvedEndpointMock.mockResolvedValue({
    hostId: HOST_ID,
    environment: { environmentId: ENVIRONMENT_ID },
    explicit: true,
    enrolledByUserId: "member-1",
    canUnbind: true,
  });
  mocks.provisionRunningHostCredentialMock.mockImplementation(async () => {
    events.push("provision");
    return { kind: "active", minted: false };
  });
  mocks.questionMock.mockImplementation(async () => questionAnswer);
  ownership = {
    hostId: HOST_ID,
    owner: { kind: "team", id: TEAM_ID, name: "acme" },
    kind: "personal",
    remoteAccess: true,
  };
  ownershipStatus = 200;
  releaseStatus = 204;
  questionAnswer = "y";
  requests = [];
  events = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedStdinIsTTY === undefined) {
    Reflect.deleteProperty(process.stdin, "isTTY");
  } else {
    Object.defineProperty(process.stdin, "isTTY", savedStdinIsTTY);
  }
  savedStdinIsTTY = undefined;
});

function setStdinIsTTY(value: boolean): void {
  savedStdinIsTTY ??= Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("buildHostClaimCommand", () => {
  it("with the running count unknown, uses the C17 claim words, releases the team's computer, then provisions its credential", async () => {
    setStdinIsTTY(true);
    const ctx = fakeCtx(false);

    const result = await makeClaimCommand(false)(ctx);

    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      "This computer belongs to acme.",
    );
    expect(mocks.questionMock).toHaveBeenCalledWith(
      "Claim it as your own? [y/N] ",
    );
    expect(result).toMatchObject({
      data: { claimed: true, hostId: HOST_ID, team: "acme" },
      human: "This computer is yours.",
      exitCode: 0,
    });
    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledWith(
      "environment.host.read",
      {},
      expect.objectContaining({ hostId: HOST_ID }),
      expect.objectContaining({ token: BEARER }),
      expect.anything(),
    );
    expect(requests.map(({ url }) => url)).toEqual([
      `${AUTHN}/api/v3/hosts?include=owner%2CremoteAccess%2CsandboxState`,
      `${AUTHN}/api/v3/hosts/${HOST_ID}/team-release`,
    ]);
    const releaseRequest = requests[1];
    expect(releaseRequest.init?.method).toBe("POST");
    expect(releaseRequest.init?.body).toBe(
      JSON.stringify({ environmentId: ENVIRONMENT_ID }),
    );
    expect(
      requests.some(({ url }) =>
        new URL(url).pathname.includes("remote-access"),
      ),
    ).toBe(false);
    expect(mocks.provisionRunningHostCredentialMock).toHaveBeenCalledWith(ctx);
    expect(events).toEqual(["ownership", "release", "provision"]);
  });

  it("skips the question with --yes", async () => {
    const result = await makeClaimCommand(true)(fakeCtx(false));

    expect(mocks.questionMock).not.toHaveBeenCalled();
    expect(result.human).toBe("This computer is yours.");
    expect(requests).toHaveLength(2);
  });

  it("prints Nothing changed and makes no release call when the person declines", async () => {
    setStdinIsTTY(true);
    questionAnswer = "n";

    const result = await makeClaimCommand(false)(fakeCtx(false));

    expect(result).toMatchObject({ human: "Nothing changed.", exitCode: 0 });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v3/hosts",
    ]);
    expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
  });

  it("requires --yes when the question cannot be shown", async () => {
    await expect(
      makeClaimCommand(false)(fakeCtx(true)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "Pass --yes to claim this computer without the question.",
    });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v3/hosts",
    ]);
  });

  it("requires sign-in before reading ownership", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);

    await expect(makeClaimCommand(false)(fakeCtx(false))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "Sign in with `traycer login`, then run the command again.",
    });
    expect(requests).toEqual([]);
  });

  it.each([
    {
      label: "unconfirmed ownership",
      ownershipStatus: 503,
      kind: "personal",
      owner: { kind: "team", id: TEAM_ID, name: "acme" },
      message: "This computer's ownership could not be confirmed. Try again.",
    },
    {
      label: "a sandbox",
      ownershipStatus: 200,
      kind: "sandbox",
      owner: { kind: "team", id: TEAM_ID, name: "acme" },
      message: "A sandbox cannot be claimed as a computer.",
    },
    {
      label: "a personal computer",
      ownershipStatus: 200,
      kind: "personal",
      owner: { kind: "user", id: "member-1" },
      message: "This computer does not belong to a team.",
    },
  ] as const)(
    "refuses $label with its existing claim message",
    async (scenario) => {
      ownershipStatus = scenario.ownershipStatus;
      ownership = {
        hostId: HOST_ID,
        owner: scenario.owner,
        kind: scenario.kind,
        remoteAccess: true,
      };
      await expect(makeClaimCommand(true)(fakeCtx(false))).rejects.toMatchObject({
        message: scenario.message,
      });
      expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
      expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [404, "This computer is no longer available to claim."],
    [403, "Sign in as a member of this team to claim this computer."],
    [500, "Could not claim this computer. Try again."],
    [409, "A sandbox cannot be claimed as a computer."],
  ])(
    "handles team release HTTP %i without provisioning",
    async (status, message) => {
      releaseStatus = status;

      await expect(makeClaimCommand(true)(fakeCtx(false))).rejects.toMatchObject({
        message,
      });
      expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
    },
  );
});
