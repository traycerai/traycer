import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  close: vi.fn(),
  getClient: () => undefined,
}));

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
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import {
  advanceFakeClockUntil,
  bearerOf,
  refreshAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_REFRESH_TOKEN,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
  useBoundedFakeClock,
} from "../../__tests__/support/stored-sign-in";

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
let ownershipRefusedBearers: string[] = [];
let releaseStatus = 204;
let releaseRefusedBearers: string[] = [];
let refreshStatus: number | null = 200;
let hungPaths: string[] = [];
let onHung: () => void = () => {};
let fileAtRefreshedRequest: Array<{
  readonly pathname: string;
  readonly bytes: string;
}> = [];
let releaseBody: unknown = {};
let questionAnswer = "y";
let localFacts: () => Promise<unknown> = noTeamWork;
let savedStdinIsTTY: PropertyDescriptor | undefined;

function noTeamWork(): Promise<unknown> {
  return Promise.resolve({ activeTurns: 0, terminals: 0 });
}

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
  savedStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === STORED_SIGN_IN_REFRESH_PATH) {
        events.push("refresh");
        if (hungPaths.includes(parsed.pathname)) {
          onHung();
          return new Promise<Response>(() => {});
        }
        return refreshAnswer(refreshStatus);
      }
      if (bearerOf(init) === `Bearer ${REFRESHED_TOKEN}`) {
        fileAtRefreshedRequest.push({
          pathname: parsed.pathname,
          bytes: await storedSignInBytes(),
        });
      }
      if (hungPaths.includes(parsed.pathname)) {
        events.push(
          parsed.pathname.endsWith("team-release") ? "release" : "ownership",
        );
        onHung();
        return new Promise<Response>(() => {});
      }
      if (parsed.pathname === "/api/v3/hosts") {
        events.push("ownership");
        if (ownershipRefusedBearers.includes(bearerOf(init) ?? "")) {
          return jsonResponse(401, {});
        }
        return jsonResponse(ownershipStatus, { hosts: [ownership] });
      }
      if (parsed.pathname === `/api/v3/hosts/${HOST_ID}/team-release`) {
        events.push("release");
        if (releaseRefusedBearers.includes(bearerOf(init) ?? "")) {
          return jsonResponse(401, {});
        }
        if (releaseStatus === 204) return new Response(null, { status: 204 });
        if (releaseStatus === 409) {
          return jsonResponse(409, { code: "host_return_not_computer" });
        }
        return jsonResponse(releaseStatus, releaseBody);
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
  mocks.callHostRpcAtResolvedEndpointMock.mockImplementation(
    async (method: string) =>
      method === "environment.previewLocalFacts"
        ? localFacts()
        : {
            hostId: HOST_ID,
            environment: { environmentId: ENVIRONMENT_ID },
            explicit: true,
            enrolledByUserId: "member-1",
            canUnbind: true,
          },
  );
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
  ownershipRefusedBearers = [];
  releaseStatus = 204;
  releaseRefusedBearers = [];
  refreshStatus = 200;
  hungPaths = [];
  onHung = () => {};
  fileAtRefreshedRequest = [];
  releaseBody = {};
  questionAnswer = "y";
  localFacts = noTeamWork;
  requests = [];
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
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
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("buildHostClaimCommand", () => {
  it("releases the team's computer, then provisions its credential", async () => {
    setStdinIsTTY(true);
    const ctx = fakeCtx(false);

    const result = await makeClaimCommand(false)(ctx);

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
    expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledWith(
      "environment.previewLocalFacts",
      { environmentId: ENVIRONMENT_ID, subject: { kind: "computer" } },
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

  const CONFIRM =
    "This computer will become yours. The team will lose access to it.";
  const confirmStates: ReadonlyArray<{
    readonly label: string;
    readonly facts: () => Promise<unknown>;
    readonly confirm: string;
  }> = [
    {
      label: "chats running",
      facts: () => Promise.resolve({ activeTurns: 3, terminals: 1 }),
      confirm: `${CONFIRM}\n3 chats are running and will stop.`,
    },
    {
      label: "one chat running",
      facts: () => Promise.resolve({ activeTurns: 1, terminals: 0 }),
      confirm: `${CONFIRM}\n1 chat is running and will stop.`,
    },
    {
      label: "nothing running",
      facts: noTeamWork,
      confirm: CONFIRM,
    },
    {
      label: "a null count",
      facts: () => Promise.resolve({ activeTurns: null, terminals: null }),
      confirm: `${CONFIRM}\nRunning chats will stop.`,
    },
    {
      label: "a failed read",
      facts: () => Promise.reject(new Error("socket closed")),
      confirm: `${CONFIRM}\nRunning chats will stop.`,
    },
    {
      label: "a host that answers unsupported",
      facts: () =>
        Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message:
              "This host does not support 'environment.previewLocalFacts'.",
            requestId: "req_1",
            method: "environment.previewLocalFacts",
            fatalDetails: null,
          }),
        ),
      confirm: `${CONFIRM}\nRunning chats will stop.`,
    },
  ];

  it.each(confirmStates)(
    "with $label, confirms with its line and asks the question",
    async ({ facts, confirm }) => {
      localFacts = facts;
      setStdinIsTTY(true);
      const ctx = fakeCtx(false);

      const result = await makeClaimCommand(false)(ctx);

      expect(ctx.output.humanRequired).toHaveBeenCalledWith(confirm);
      expect(mocks.questionMock).toHaveBeenCalledWith(
        "Claim it as your own? [y/N] ",
      );
      expect(result.human).toBe("This computer is yours.");
    },
  );

  it.each(confirmStates)(
    "with $label, --yes prints its line and skips the question",
    async ({ facts, confirm }) => {
      localFacts = facts;
      const ctx = fakeCtx(false);

      const result = await makeClaimCommand(true)(ctx);

      expect(ctx.output.humanRequired).toHaveBeenCalledWith(confirm);
      expect(mocks.questionMock).not.toHaveBeenCalled();
      expect(result.human).toBe("This computer is yours.");
      expect(requests).toHaveLength(2);
    },
  );

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
    await expect(makeClaimCommand(false)(fakeCtx(true))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "Pass --yes to claim this computer without the question.",
    });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v3/hosts",
    ]);
  });

  it("requires sign-in before reading ownership", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);

    await expect(makeClaimCommand(false)(fakeCtx(false))).rejects.toMatchObject(
      {
        code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
        message: "Sign in with `traycer login`, then run the command again.",
      },
    );
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
      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        message: scenario.message,
      });
      expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
      expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { yes: false, asked: true },
    { yes: true, asked: false },
  ])(
    "tells a Viewer of the team who can claim the computer (--yes: $yes)",
    async ({ yes, asked }) => {
      setStdinIsTTY(true);
      releaseStatus = 403;
      releaseBody = { code: "host_return_seat_read_only" };

      await expect(makeClaimCommand(yes)(fakeCtx(false))).rejects.toMatchObject(
        {
          code: CLI_ERROR_CODES.ENVIRONMENT_SEAT_WITHOUT_WRITE,
          message:
            "Only admins and editors of this team can claim this computer.",
          exitCode: 1,
        },
      );
      expect(mocks.questionMock).toHaveBeenCalledTimes(asked ? 1 : 0);
      expect(events).toEqual(["ownership", "release"]);
    },
  );

  it.each([
    [404, "This computer is no longer available to claim."],
    [401, "Sign in as a member of this team to claim this computer."],
    [403, "Sign in as a member of this team to claim this computer."],
    [500, "Could not claim this computer. Try again."],
    [409, "A sandbox cannot be claimed as a computer."],
  ])(
    "handles team release HTTP %i without provisioning",
    async (status, message) => {
      releaseStatus = status;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        message,
      });
      expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
    },
  );
});

const RESULT_ERROR_LINE = z.object({
  type: z.literal("result"),
  status: z.literal("error"),
  error: z.object({ code: z.string(), message: z.string() }),
});

/** The real runner, with its stdout and exit code read the way a caller reads them. */
async function runClaimThroughRunner(): Promise<{
  readonly printed: z.infer<typeof RESULT_ERROR_LINE>["error"];
  readonly exitCode: number | string | null | undefined;
}> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    callback: (() => void) | undefined,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    if (callback !== undefined) callback();
    return true;
  }) as never);
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  // The runner keeps the first failing code it records; a fresh copy per run.
  vi.resetModules();
  const { runCommand } = await import("../../runner/runner");
  // Loaded after the reset too, so its errors are the runner's own class.
  const { buildHostClaimCommand: freshClaimCommand } =
    await import("../host-claim");
  try {
    await runCommand(freshClaimCommand({ yes: true }), {
      json: true,
      quiet: false,
      noProgress: true,
      noBootstrap: false,
    });
    const exitCode = process.exitCode;
    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => RESULT_ERROR_LINE.safeParse(JSON.parse(line)))
      .flatMap((parsed) => (parsed.success ? [parsed.data.error] : []));
    expect(lines).toHaveLength(1);
    return { printed: lines[0], exitCode };
  } finally {
    process.exitCode = priorExitCode;
  }
}

describe("buildHostClaimCommand with a stored sign-in authn refuses", () => {
  const STORED_USER_ID = "member-1";
  const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
  const STORED_HEADER = `Bearer ${BEARER}`;
  const OWNERSHIP_UNCONFIRMED =
    "This computer's ownership could not be confirmed. Try again.";
  const CREDENTIAL_REJECTED =
    "The stored credential was rejected. Run `traycer login` to re-authenticate.";
  const RELEASE_REFUSED =
    "Sign in as a member of this team to claim this computer.";
  const OWNERSHIP_PATH = "/api/v3/hosts";
  const RELEASE_PATH = `/api/v3/hosts/${HOST_ID}/team-release`;
  // Each shared HTTP function bounds its own request at 10 s. The refresh has
  // the same bound for its request, plus the store's own retry waits.
  const REQUEST_BOUND_MS = 10_000;
  const REFRESH_BOUND_MS = 20_000;

  beforeEach(async () => {
    // The real resolver, on the sign-in the suite seeds.
    const actual = await vi.importActual<
      typeof import("../../internal/host-auth")
    >("../../internal/host-auth");
    mocks.resolveHostAuthMock.mockImplementation(() =>
      actual.resolveHostAuth(),
    );
    await seedStoredSignIn(BEARER, STORED_USER_ID);
  });

  afterEach(async () => {
    await removeStoredSignIn();
  });

  function callsTo(pathname: string): Array<string | null> {
    return requests
      .filter(({ url }) => new URL(url).pathname === pathname)
      .map(({ init }) => bearerOf(init));
  }

  function requestedPaths(): string[] {
    return requests.map(({ url }) => new URL(url).pathname);
  }

  /** Runs the claim, on a fake clock, until it ends on a request authn never answers. */
  async function claimBoundedByHang(): Promise<{
    readonly outcome: unknown;
    readonly elapsedMs: number;
  }> {
    useBoundedFakeClock();
    const hung = new Promise<void>((resolve) => {
      onHung = resolve;
    });
    let outcome: unknown = null;
    let settled = false;
    void makeClaimCommand(true)(fakeCtx(false))
      .then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          outcome = error;
        },
      )
      .then(() => {
        settled = true;
      });
    await hung;
    const elapsedMs = await advanceFakeClockUntil(() => settled);
    return { outcome, elapsedMs };
  }

  describe("when it reads the computer's ownership", () => {
    it("refreshes once, reads again on the refreshed sign-in and carries it to every later call", async () => {
      ownershipRefusedBearers = [STORED_HEADER];

      const result = await makeClaimCommand(true)(fakeCtx(false));

      expect(result.human).toBe("This computer is yours.");
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        OWNERSHIP_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(OWNERSHIP_PATH)).toEqual([
        STORED_HEADER,
        REFRESHED_HEADER,
      ]);
      const refresh = requests.find(
        ({ url }) => new URL(url).pathname === STORED_SIGN_IN_REFRESH_PATH,
      );
      expect(JSON.parse(String(refresh?.init?.body))).toMatchObject({
        refreshToken: STORED_REFRESH_TOKEN,
      });
      expect(fileAtRefreshedRequest.map(({ pathname }) => pathname)).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
      ]);
      expect(JSON.parse(fileAtRefreshedRequest[0].bytes)).toMatchObject({
        token: REFRESHED_TOKEN,
        refreshToken: REFRESHED_REFRESH_TOKEN,
      });
      expect(callsTo(RELEASE_PATH)).toEqual([REFRESHED_HEADER]);
      for (const method of [
        "environment.host.read",
        "environment.previewLocalFacts",
      ]) {
        expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledWith(
          method,
          expect.anything(),
          expect.objectContaining({ hostId: HOST_ID }),
          expect.objectContaining({ token: REFRESHED_TOKEN }),
          expect.anything(),
        );
      }
    });

    it("prints the sign-in to make again, exits 1 and leaves the stored sign-in as it was, when the refresh is refused", async () => {
      ownershipRefusedBearers = [STORED_HEADER];
      refreshStatus = 401;
      const before = await storedSignInBytes();

      const run = await runClaimThroughRunner();

      expect(run.printed).toEqual({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: CREDENTIAL_REJECTED,
      });
      expect(run.exitCode).toBe(1);
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
      expect(await storedSignInBytes()).toBe(before);
    });

    it("prints the ownership line and exits 1 after one refresh when the read is refused again on the refreshed sign-in", async () => {
      ownershipRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];

      const run = await runClaimThroughRunner();

      expect(run.printed).toEqual({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
      });
      expect(run.exitCode).toBe(1);
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        OWNERSHIP_PATH,
      ]);
    });

    it("keeps the ownership line when authn cannot be reached for the refresh", async () => {
      ownershipRefusedBearers = [STORED_HEADER];
      refreshStatus = null;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
        exitCode: 1,
      });

      expect(events).toEqual(["ownership", "refresh"]);
    });

    it("keeps the ownership line and sends no refresh when authn answers 403", async () => {
      ownershipStatus = 403;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
        exitCode: 1,
      });

      expect(requestedPaths()).toEqual([OWNERSHIP_PATH]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("keeps the ownership line, with no refresh, when authn never answers the read", async () => {
      hungPaths = [OWNERSHIP_PATH];

      const { outcome, elapsedMs } = await claimBoundedByHang();

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
      });
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_BOUND_MS);
      expect(requestedPaths()).toEqual([OWNERSHIP_PATH]);
    });

    it("keeps the ownership line, after one refresh request, when the refresh never answers", async () => {
      ownershipRefusedBearers = [STORED_HEADER];
      hungPaths = [STORED_SIGN_IN_REFRESH_PATH];

      const { outcome, elapsedMs } = await claimBoundedByHang();

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
      });
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(elapsedMs).toBeLessThanOrEqual(REFRESH_BOUND_MS);
    });
  });

  describe("when it releases the team's computer", () => {
    it("refreshes once and sends the release again on the refreshed sign-in, saved before it is sent", async () => {
      releaseRefusedBearers = [STORED_HEADER];

      const result = await makeClaimCommand(true)(fakeCtx(false));

      expect(result.human).toBe("This computer is yours.");
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(RELEASE_PATH)).toEqual([STORED_HEADER, REFRESHED_HEADER]);
      expect(fileAtRefreshedRequest).toHaveLength(1);
      expect(JSON.parse(fileAtRefreshedRequest[0].bytes)).toMatchObject({
        token: REFRESHED_TOKEN,
        refreshToken: REFRESHED_REFRESH_TOKEN,
      });
      expect(mocks.provisionRunningHostCredentialMock).toHaveBeenCalledTimes(1);
    });

    it("keeps the release line, and leaves the stored sign-in as it was, when the refresh is refused", async () => {
      releaseRefusedBearers = [STORED_HEADER];
      refreshStatus = 401;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });

      expect(events).toEqual(["ownership", "release", "refresh"]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("keeps the release line when the release is refused again on the refreshed sign-in", async () => {
      releaseRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });

      expect(events).toEqual(["ownership", "release", "refresh", "release"]);
    });

    it("sends no second refresh when the ownership read already refreshed and the release is refused", async () => {
      ownershipRefusedBearers = [STORED_HEADER];
      releaseRefusedBearers = [REFRESHED_HEADER];

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });

      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        OWNERSHIP_PATH,
        RELEASE_PATH,
      ]);
    });

    it("keeps the release line and sends no refresh when authn answers 403", async () => {
      releaseStatus = 403;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });

      expect(requestedPaths()).toEqual([OWNERSHIP_PATH, RELEASE_PATH]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("keeps the failed-claim line, with no refresh, when authn never answers the release", async () => {
      hungPaths = [RELEASE_PATH];

      const { outcome, elapsedMs } = await claimBoundedByHang();

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message: "Could not claim this computer. Try again.",
      });
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_BOUND_MS);
      expect(requestedPaths()).toEqual([OWNERSHIP_PATH, RELEASE_PATH]);
    });

    it("keeps the release line, after one refresh request, when the refresh never answers", async () => {
      releaseRefusedBearers = [STORED_HEADER];
      hungPaths = [STORED_SIGN_IN_REFRESH_PATH];

      const { outcome, elapsedMs } = await claimBoundedByHang();

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
      });
      expect(elapsedMs).toBeLessThanOrEqual(REFRESH_BOUND_MS);
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
    });
  });
});
