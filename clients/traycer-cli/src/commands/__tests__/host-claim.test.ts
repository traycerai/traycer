import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
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
  bearerOf,
  refreshAnswer,
  refreshedPairAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_REFRESH_TOKEN,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
  useBoundedFakeClock,
} from "../../__tests__/support/stored-sign-in";
import { AUTH_FETCH_MAX_ATTEMPTS } from "../../../../shared/auth/auth-validation";
import { nextCasePerson } from "../../internal/__tests__/case-person-test-support";

const HOST_ID = "host-local";
const TEAM_ID = "team-acme";
const ENVIRONMENT_ID = "environment-acme";
const AUTHN = "https://authn.example.test";
const BEARER = "fixture-bearer";
const IDENTITY_PATH = "/api/v3/user/negotiated";

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
// Bearers whose identity read authn refuses. Empty means authn takes the sign-in.
let identityRefusedBearers: string[] = [];
let identityUnreachable = false;
let hungPaths: string[] = [];
let heldRequests: HeldRequest[] = [];
let onHeldStarted: () => void = () => {};
let onHeldAborted: () => void = () => {};
let hangCleanupOwned = false;
let cleanupStarted = false;
let commandSettled: Promise<void> = Promise.resolve();
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

interface HeldRequest {
  readonly finish: () => void;
  readonly done: Promise<void>;
}

/**
 * A response authn never sends. It rejects when the request's signal aborts,
 * and cleanup can finish it the same way if the test ends first.
 */
function holdOpen(init: RequestInit | undefined): Promise<Response> {
  if (cleanupStarted) {
    return Promise.reject(
      new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  const signal = init?.signal ?? null;
  let rejectResponse: (reason: unknown) => void = () => {};
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  const response = new Promise<Response>((_resolve, reject) => {
    rejectResponse = reject;
  });
  let settled = false;

  function finish(): void {
    if (settled) return;
    settled = true;
    if (signal !== null) signal.removeEventListener("abort", onAbort);
    const reason =
      signal?.reason ??
      new DOMException("The operation was aborted.", "AbortError");
    rejectResponse(reason);
    markDone();
  }

  function onAbort(): void {
    finish();
    onHeldAborted();
  }

  heldRequests.push({ finish, done });
  if (signal !== null) {
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  onHeldStarted();
  // The caller awaits this promise. A late finish, during cleanup, still
  // rejects it, and that rejection must not surface as unhandled.
  void response.catch(() => undefined);
  return response;
}

/**
 * A major-2 identity body. The version header is what keeps this one response:
 * without it the negotiated route is unlabelled and the frozen route is read too.
 */
function acceptedIdentityResponse(): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: "user-1",
        name: "Test User",
        providerId: "gh-1",
        providerHandle: "test-user",
        providerType: "GITHUB",
        email: "test@example.com",
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: "sub-1",
        userID: "user-1",
        orgID: null,
        teamID: null,
        customerId: "cus-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
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
  const run = buildHostClaimCommand(args);
  return (ctx: CommandContext) => {
    const command = run(ctx);
    commandSettled = command.then(
      () => undefined,
      () => undefined,
    );
    return command;
  };
}

/**
 * Cleanup joins the command only after a request that arrives now is settled
 * at once and every held response has been finished. The rejection is swallowed
 * here; the test body still asserts the outcome.
 */
async function joinCommand(command: Promise<unknown>): Promise<void> {
  cleanupStarted = true;
  for (const held of heldRequests) held.finish();
  await Promise.all(heldRequests.map((held) => held.done));
  await command.then(
    () => undefined,
    () => undefined,
  );
}

beforeEach(() => {
  savedStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (cleanupStarted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const url = String(input);
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === STORED_SIGN_IN_REFRESH_PATH) {
        events.push("refresh");
        if (hungPaths.includes(parsed.pathname)) {
          return holdOpen(init);
        }
        return refreshStatus === 200
          ? refreshedPairAnswer(REFRESHED_TOKEN, REFRESHED_REFRESH_TOKEN)
          : refreshAnswer(refreshStatus);
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
        return holdOpen(init);
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
      if (parsed.pathname === IDENTITY_PATH) {
        if (identityUnreachable) throw new TypeError("fetch failed");
        if (identityRefusedBearers.includes(bearerOf(init) ?? "")) {
          return jsonResponse(401, {});
        }
        return acceptedIdentityResponse();
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
  identityRefusedBearers = [];
  identityUnreachable = false;
  hungPaths = [];
  heldRequests = [];
  onHeldStarted = () => {};
  onHeldAborted = () => {};
  hangCleanupOwned = false;
  cleanupStarted = false;
  commandSettled = Promise.resolve();
  fileAtRefreshedRequest = [];
  releaseBody = {};
  questionAnswer = "y";
  localFacts = noTeamWork;
  requests = [];
  events = [];
});

afterEach(async () => {
  // A hang test joins the command in onTestFinished. This runner calls
  // afterEach first, so that test skips the restore here.
  if (!hangCleanupOwned) {
    await joinCommand(commandSettled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
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
  const settled = (async () => {
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
    try {
      process.exitCode = undefined;
      // The runner keeps the first failing code it records; a fresh copy per run.
      vi.resetModules();
      const { runCommand } = await import("../../runner/runner");
      // Loaded after the reset too, so its errors are the runner's own class.
      const { buildHostClaimCommand: freshClaimCommand } =
        await import("../host-claim");
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
  })();
  commandSettled = settled.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}

describe("buildHostClaimCommand with a stored sign-in authn refuses", () => {
  const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
  const OWNERSHIP_UNCONFIRMED =
    "This computer's ownership could not be confirmed. Try again.";
  const CREDENTIAL_REJECTED =
    "The stored credential was rejected. Run `traycer login` to re-authenticate.";
  const AUTHN_UNREACHABLE =
    "Could not reach the authn service; check your network.";
  const RELEASE_REFUSED =
    "Sign in as a member of this team to claim this computer.";
  const SIGN_IN_FIRST =
    "Sign in with `traycer login`, then run the command again.";
  const OWNERSHIP_PATH = "/api/v3/hosts";
  const RELEASE_PATH = `/api/v3/hosts/${HOST_ID}/team-release`;
  // The ownership read and the release each bound their request at 10 s.
  // The refresh cap is a margin above the refresh request's own 10 s bound,
  // used only so a hung request's abort can fire. It is not an assertion.
  const REQUEST_BOUND_MS = 10_000;
  const REFRESH_BOUND_MS = 20_000;
  let storedToken = "";
  let storedHeader = "";

  beforeEach(async () => {
    const person = nextCasePerson();
    storedToken = person.signIn;
    storedHeader = `Bearer ${person.signIn}`;
    const actual = await vi.importActual<
      typeof import("../../internal/host-auth")
    >("../../internal/host-auth");
    mocks.resolveHostAuthMock.mockImplementation(() =>
      actual.resolveHostAuth(),
    );
    await seedStoredSignIn(storedToken, person.userId);
  });

  afterEach(async () => {
    if (!hangCleanupOwned) {
      await joinCommand(commandSettled);
      await removeStoredSignIn();
    }
  });

  function callsTo(pathname: string): Array<string | null> {
    return requests
      .filter(({ url }) => new URL(url).pathname === pathname)
      .map(({ init }) => bearerOf(init));
  }

  function requestedPaths(): string[] {
    return requests.map(({ url }) => new URL(url).pathname);
  }

  /**
   * Runs the claim until the held request has started, advances the fake
   * clock by that request's bound once, then waits until its abort fires.
   * The caller asserts the line and the requests.
   */
  async function claimUntilHang(boundMs: number): Promise<unknown> {
    useBoundedFakeClock();
    const started = new Promise<void>((resolve) => {
      onHeldStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      onHeldAborted = resolve;
    });
    // One hook, so the command is joined before timers, globals, spies,
    // and the stored sign-in are cleared. afterEach runs first and skips
    // those steps while hangCleanupOwned is set.
    let ended: Promise<unknown> = Promise.resolve();
    onTestFinished(async () => {
      await joinCommand(ended);
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      await removeStoredSignIn();
    });
    hangCleanupOwned = true;
    ended = makeClaimCommand(true)(fakeCtx(false)).then(
      (result): unknown => result,
      (error: unknown) => error,
    );
    await started;
    await vi.advanceTimersByTimeAsync(boundMs);
    await aborted;
    return await ended;
  }

  describe("when it reads the computer's ownership", () => {
    it("expired access token is refreshed once before the claim continues", async () => {
      // Stored bearer is expired on both the ownership read and the judge's
      // identity read. One refresh, then one accepted identity read, then the
      // ownership read again. The two host reads and the release use the
      // refreshed sign-in, saved before any of those three requests.
      ownershipRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).resolves.toMatchObject({
        human: "This computer is yours.",
        exitCode: 0,
      });

      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        OWNERSHIP_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(OWNERSHIP_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(callsTo(RELEASE_PATH)).toEqual([REFRESHED_HEADER]);
      const refresh = requests.find(
        ({ url }) => new URL(url).pathname === STORED_SIGN_IN_REFRESH_PATH,
      );
      expect(JSON.parse(String(refresh?.init?.body))).toMatchObject({
        refreshToken: STORED_REFRESH_TOKEN,
      });
      expect(fileAtRefreshedRequest.map(({ pathname }) => pathname)).toEqual([
        IDENTITY_PATH,
        OWNERSHIP_PATH,
        RELEASE_PATH,
      ]);
      for (const recorded of fileAtRefreshedRequest) {
        expect(JSON.parse(recorded.bytes)).toMatchObject({
          token: REFRESHED_TOKEN,
          refreshToken: REFRESHED_REFRESH_TOKEN,
        });
      }
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

    it("prints the login line and exits 1, leaving the stored sign-in as it was, when the refresh after the refused identity read is refused", async () => {
      ownershipRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      refreshStatus = 401;
      const before = await storedSignInBytes();

      const run = await runClaimThroughRunner();

      expect(run.printed).toEqual({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: CREDENTIAL_REJECTED,
      });
      expect(run.exitCode).toBe(1);
      // Ownership refused, one identity read refused, one refresh refused.
      // No second identity read and no host read.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(mocks.callHostRpcAtResolvedEndpointMock).not.toHaveBeenCalled();
      expect(await storedSignInBytes()).toBe(before);
    });

    it("prints the ownership line and exits 1 when the ownership read is refused again on the refreshed sign-in", async () => {
      ownershipRefusedBearers = [storedHeader, REFRESHED_HEADER];
      identityRefusedBearers = [storedHeader];

      const run = await runClaimThroughRunner();

      expect(run.printed).toEqual({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
      });
      expect(run.exitCode).toBe(1);
      // One refused identity read, one refresh, one accepted identity read,
      // then the ownership read is sent once more and refused.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        OWNERSHIP_PATH,
      ]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(callsTo(OWNERSHIP_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
    });

    it("prints the authn line when the one refresh after a refused ownership read cannot reach authn", async () => {
      ownershipRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      refreshStatus = null;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
        exitCode: 1,
      });
      // One refused identity read, then one refresh request that itself fails.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
    });

    it("prints the authn line when the one refresh after a refused ownership read never answers", async () => {
      ownershipRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      hungPaths = [STORED_SIGN_IN_REFRESH_PATH];

      const outcome = await claimUntilHang(REFRESH_BOUND_MS);

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
      });
      // One refused identity read, then the one refresh that never answers.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
    });

    it("prints the authn line and sends no refresh when the ownership read's identity read cannot reach authn", async () => {
      ownershipRefusedBearers = [storedHeader];
      identityUnreachable = true;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
        exitCode: 1,
      });
      // A thrown identity read is a network failure. The validator sends it
      // once per attempt, up to its ceiling, and the judge does not refresh.
      expect(callsTo(IDENTITY_PATH)).toHaveLength(AUTH_FETCH_MAX_ATTEMPTS);
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        ...Array<string>(AUTH_FETCH_MAX_ATTEMPTS).fill(IDENTITY_PATH),
      ]);
    });

    it("prints the ownership line after one identity read and one resend, with no refresh, when authn answers 403 and still takes the sign-in", async () => {
      ownershipStatus = 403;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
        exitCode: 1,
      });
      // 403 refuses the read. The one identity read is accepted, so nothing
      // is refreshed; the read is sent once more and that refusal ends it.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        OWNERSHIP_PATH,
      ]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("prints the ownership line and sends no refresh when authn never answers the ownership read", async () => {
      hungPaths = [OWNERSHIP_PATH];

      const outcome = await claimUntilHang(REQUEST_BOUND_MS);

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: OWNERSHIP_UNCONFIRMED,
      });
      // The unanswered read is not a refusal, so the judge is not entered.
      expect(requestedPaths()).toEqual([OWNERSHIP_PATH]);
    });
  });

  describe("when it releases the team's computer", () => {
    it("refreshes once after a refused release and sends the release again on the refreshed sign-in, saved before that send", async () => {
      releaseRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];

      const result = await makeClaimCommand(true)(fakeCtx(false));

      expect(result.human).toBe("This computer is yours.");
      // Ownership succeeded on the stored sign-in, so the host reads use it.
      // The release was refused, one identity read was refused, one refresh
      // ran, one identity read of the refreshed sign-in was accepted, and the
      // release was sent again on it.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(RELEASE_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(fileAtRefreshedRequest.map(({ pathname }) => pathname)).toEqual([
        IDENTITY_PATH,
        RELEASE_PATH,
      ]);
      expect(JSON.parse(fileAtRefreshedRequest[1].bytes)).toMatchObject({
        token: REFRESHED_TOKEN,
        refreshToken: REFRESHED_REFRESH_TOKEN,
      });
      expect(mocks.callHostRpcAtResolvedEndpointMock).toHaveBeenCalledWith(
        "environment.host.read",
        expect.anything(),
        expect.objectContaining({ hostId: HOST_ID }),
        expect.objectContaining({ token: storedToken }),
        expect.anything(),
      );
      expect(mocks.provisionRunningHostCredentialMock).toHaveBeenCalledTimes(1);
    });

    it("prints the login line and leaves the stored sign-in as it was when the release's refresh is refused", async () => {
      releaseRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      refreshStatus = 401;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: CREDENTIAL_REJECTED,
        exitCode: 1,
      });
      // Release refused, one identity read refused, one refresh refused.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("prints the member line when the release is refused again on the refreshed sign-in", async () => {
      releaseRefusedBearers = [storedHeader, REFRESHED_HEADER];
      identityRefusedBearers = [storedHeader];

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });
      // One refused identity read, one refresh, one accepted identity read,
      // then the release is sent once more and refused.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(RELEASE_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader, REFRESHED_HEADER]);
    });

    it("sends the release twice and does not refresh a second time when the ownership read already refreshed and the release is refused", async () => {
      ownershipRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      releaseRefusedBearers = [REFRESHED_HEADER];

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });
      // The ownership judge: one refused identity read, one refresh, one
      // accepted identity read, then the ownership read succeeds. The release
      // of that refreshed sign-in is refused. Its judge's one identity read
      // accepts it, so there is no second refresh, and the release is sent
      // once more.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(IDENTITY_PATH)).toEqual([
        storedHeader,
        REFRESHED_HEADER,
        REFRESHED_HEADER,
      ]);
      expect(callsTo(RELEASE_PATH)).toEqual([
        REFRESHED_HEADER,
        REFRESHED_HEADER,
      ]);
      expect(
        requestedPaths().filter((path) => path === STORED_SIGN_IN_REFRESH_PATH),
      ).toHaveLength(1);
    });

    it("prints the member line after one identity read and one resend, with no refresh, when authn answers 403 to the release and still takes the sign-in", async () => {
      releaseStatus = 403;
      const before = await storedSignInBytes();

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: RELEASE_REFUSED,
        exitCode: 1,
      });
      // A bare 403 refuses the release. The one identity read is accepted,
      // so nothing is refreshed; the release is sent once more and that
      // refusal ends it.
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        RELEASE_PATH,
      ]);
      expect(callsTo(IDENTITY_PATH)).toEqual([storedHeader]);
      expect(callsTo(RELEASE_PATH)).toEqual([storedHeader, storedHeader]);
      expect(await storedSignInBytes()).toBe(before);
    });

    it("prints the authn line when the one refresh after a refused release cannot reach authn", async () => {
      releaseRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      refreshStatus = null;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
        exitCode: 1,
      });
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
    });

    it("prints the authn line when the one refresh after a refused release never answers", async () => {
      releaseRefusedBearers = [storedHeader];
      identityRefusedBearers = [storedHeader];
      hungPaths = [STORED_SIGN_IN_REFRESH_PATH];

      const outcome = await claimUntilHang(REFRESH_BOUND_MS);

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
      });
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
    });

    it("prints the authn line and sends no refresh when the release's identity read cannot reach authn", async () => {
      releaseRefusedBearers = [storedHeader];
      identityUnreachable = true;

      await expect(
        makeClaimCommand(true)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: AUTHN_UNREACHABLE,
        exitCode: 1,
      });
      expect(callsTo(IDENTITY_PATH)).toHaveLength(AUTH_FETCH_MAX_ATTEMPTS);
      expect(requestedPaths()).toEqual([
        OWNERSHIP_PATH,
        RELEASE_PATH,
        ...Array<string>(AUTH_FETCH_MAX_ATTEMPTS).fill(IDENTITY_PATH),
      ]);
    });

    it("prints the failed-claim line and sends no refresh when authn never answers the release", async () => {
      hungPaths = [RELEASE_PATH];

      const outcome = await claimUntilHang(REQUEST_BOUND_MS);

      expect(outcome).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message: "Could not claim this computer. Try again.",
      });
      // The unanswered release is not a refusal, so the judge is not entered.
      expect(requestedPaths()).toEqual([OWNERSHIP_PATH, RELEASE_PATH]);
    });

    it("prints the sign-in line and sends no release when the stored sign-in is removed between the question and the release", async () => {
      setStdinIsTTY(true);
      mocks.questionMock.mockImplementation(async () => {
        await removeStoredSignIn();
        return "y";
      });

      await expect(
        makeClaimCommand(false)(fakeCtx(false)),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
        message: SIGN_IN_FIRST,
        exitCode: 1,
      });
      expect(mocks.questionMock).toHaveBeenCalledTimes(1);
      expect(requestedPaths()).toEqual([OWNERSHIP_PATH]);
      expect(mocks.provisionRunningHostCredentialMock).not.toHaveBeenCalled();
    });
  });
});
