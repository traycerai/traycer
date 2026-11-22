import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { buildBotListCommand } from "../bot-list";
import { botSubscribeClient, makeCtx, THIS_HOST_ID } from "./bot-test-support";
import {
  bearerOf,
  refreshAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
} from "../../__tests__/support/stored-sign-in";

// `bot list`'s directory read on the stored sign-in. The sign-in service
// (authn's directory and refresh) is a stubbed `fetch`; the stored sign-in is
// the real store under the suite's temp HOME. The local host and the
// sign-in's environment list stand in.

const mocks = vi.hoisted(() => ({
  listBots: vi.fn(),
  openLocalStreamClient: vi.fn(),
  readSignInEnvironments: vi.fn(),
}));

vi.mock("../../internal/bot-host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/bot-host")>();
  return {
    ...actual,
    listBots: mocks.listBots,
    openLocalStreamClient: mocks.openLocalStreamClient,
  };
});

vi.mock("../../internal/sign-in-environments", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../internal/sign-in-environments")
    >();
  return { ...actual, readSignInEnvironments: mocks.readSignInEnvironments };
});

const DIRECTORY_PATH = "/api/v3/hosts";
const STORED_TOKEN = "stored-bearer";
const STORED_HEADER = `Bearer ${STORED_TOKEN}`;
const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
const TEAM_ID = "team-acme";
const REJECTED_LINE =
  "The stored credential was rejected. Run `traycer login` to re-authenticate.";
const UNCONFIRMED_LINE =
  "This computer's ownership could not be confirmed. Try again.";
/** The directory call's own bound. */
const DIRECTORY_BOUND_MS = 10_000;

interface Arrival {
  readonly pathname: string;
  readonly bearer: string | null;
  /** The stored file as it was when the request arrived. */
  readonly stored: string;
}

let arrivals: Arrival[] = [];
let arrivalWaiters: { readonly count: number; readonly resolve: () => void }[] =
  [];
let directoryStatuses: Record<string, number> = {};
let hungPaths: string[] = [];
let refreshStatus: number | null = 200;

function arrivalsOn(pathname: string): readonly Arrival[] {
  return arrivals.filter((arrival) => arrival.pathname === pathname);
}

function pathsSent(): readonly string[] {
  return arrivals.map(({ pathname }) => pathname);
}

function untilArrivals(count: number): Promise<void> {
  if (arrivals.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    arrivalWaiters.push({ count, resolve });
  });
}

function neverAnswers(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function ownedByTeam(): Response {
  return new Response(
    JSON.stringify({
      hosts: [
        {
          hostId: THIS_HOST_ID,
          owner: { kind: "team", id: TEAM_ID, name: "acme" },
          kind: "personal",
          remoteAccess: true,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(async () => {
  arrivals = [];
  arrivalWaiters = [];
  directoryStatuses = {};
  hungPaths = [];
  refreshStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      arrivals.push({
        pathname,
        bearer: bearerOf(init),
        stored: await storedSignInBytes(),
      });
      for (const waiter of arrivalWaiters) {
        if (arrivals.length >= waiter.count) waiter.resolve();
      }
      if (hungPaths.includes(`${pathname}#${arrivalsOn(pathname).length}`)) {
        return neverAnswers(init?.signal);
      }
      if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
        return refreshAnswer(refreshStatus);
      }
      const status = directoryStatuses[bearerOf(init) ?? ""];
      return status === undefined
        ? ownedByTeam()
        : new Response("{}", { status });
    }),
  );
  mocks.listBots.mockResolvedValue([]);
  mocks.openLocalStreamClient.mockResolvedValue({
    client: botSubscribeClient({}),
    endpoint: { hostId: THIS_HOST_ID, websocketUrl: "ws://127.0.0.1:9999/rpc" },
  });
  mocks.readSignInEnvironments.mockResolvedValue([
    {
      environmentId: "env-personal",
      ownerKind: "user",
      ownerId: "member-1",
      label: "Personal",
    },
    {
      environmentId: "env-acme",
      ownerKind: "organization",
      ownerId: TEAM_ID,
      label: "acme",
    },
  ]);
  await seedStoredSignIn(STORED_TOKEN, "member-1");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  await removeStoredSignIn();
});

function runList() {
  return buildBotListCommand()(makeCtx());
}

describe("bot list's directory read on a refused stored sign-in", () => {
  it("refreshes once and reads again on the refreshed sign-in, which was already saved when the read arrived", async () => {
    directoryStatuses = { [STORED_HEADER]: 401 };

    const result = await runList();

    expect(result.data).toEqual({
      environments: [{ environmentId: "env-acme", label: "acme", bots: [] }],
    });
    expect(result.exitCode).toBe(0);
    expect(pathsSent()).toEqual([
      DIRECTORY_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      DIRECTORY_PATH,
    ]);
    const [first, retry] = arrivalsOn(DIRECTORY_PATH);
    expect(first.bearer).toBe(STORED_HEADER);
    expect(retry.bearer).toBe(REFRESHED_HEADER);
    expect(JSON.parse(retry.stored)).toMatchObject({
      token: REFRESHED_TOKEN,
      refreshToken: REFRESHED_REFRESH_TOKEN,
    });
  });

  it.each([
    { name: "refused", status: 401 },
    { name: "unreachable", status: null },
  ])(
    "keeps the stored-credential line, sends no second read and leaves the file as it was when the refresh is $name",
    async ({ status }) => {
      directoryStatuses = { [STORED_HEADER]: 401 };
      refreshStatus = status;
      const before = await storedSignInBytes();

      await expect(runList()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: REJECTED_LINE,
        exitCode: 1,
      });

      expect(pathsSent()).toEqual([
        DIRECTORY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(await storedSignInBytes()).toBe(before);
    },
  );

  it("ends after one refresh when the read is refused again on the refreshed sign-in", async () => {
    directoryStatuses = { [STORED_HEADER]: 401, [REFRESHED_HEADER]: 401 };

    await expect(runList()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message: REJECTED_LINE,
      exitCode: 1,
    });

    expect(pathsSent()).toEqual([
      DIRECTORY_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      DIRECTORY_PATH,
    ]);
  });

  it("prints the same line on a 403 as without a retry, and sends no refresh", async () => {
    directoryStatuses = { [STORED_HEADER]: 403 };
    const before = await storedSignInBytes();

    await expect(runList()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message: REJECTED_LINE,
      exitCode: 1,
    });

    expect(pathsSent()).toEqual([DIRECTORY_PATH]);
    expect(await storedSignInBytes()).toBe(before);
  });

  it("ends on the read's own bound with no refresh when the sign-in service never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hungPaths = [`${DIRECTORY_PATH}#1`];

    const ended = runList().then(
      () => null,
      (error: unknown) => error,
    );
    await untilArrivals(1);
    await vi.advanceTimersByTimeAsync(DIRECTORY_BOUND_MS);

    expect(await ended).toMatchObject({
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: UNCONFIRMED_LINE,
      exitCode: 1,
    });
    expect(pathsSent()).toEqual([DIRECTORY_PATH]);
  });

  it("keeps the first refusal on the refresh's own bound when a 401 is followed by a refresh that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    directoryStatuses = { [STORED_HEADER]: 401 };
    hungPaths = [`${STORED_SIGN_IN_REFRESH_PATH}#1`];
    const before = await storedSignInBytes();

    const ended = runList().then(
      () => null,
      (error: unknown) => error,
    );
    await untilArrivals(2);
    await vi.advanceTimersByTimeAsync(DIRECTORY_BOUND_MS);

    expect(await ended).toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message: REJECTED_LINE,
      exitCode: 1,
    });
    expect(pathsSent()).toEqual([DIRECTORY_PATH, STORED_SIGN_IN_REFRESH_PATH]);
    expect(await storedSignInBytes()).toBe(before);
  });
});
