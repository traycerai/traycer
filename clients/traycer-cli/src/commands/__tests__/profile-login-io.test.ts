import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import type { SignInRequestRecordAnswer } from "../../../../shared/host-client/provider-sign-in-request";
import { PROCESS_PROFILE_LOGIN_IO } from "../profile-login";
import {
  advanceFakeClockUntil,
  bearerOf,
  refreshAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
  useBoundedFakeClock,
} from "../../__tests__/support/stored-sign-in";

// Each interface the code under test opens is a real readline interface over
// an input of its own, so the test drives the real "line" and "close" events
// without touching the process's stdin.
vi.mock("node:readline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:readline")>();
  return {
    ...actual,
    createInterface: vi.fn(() =>
      actual.createInterface({ input: new PassThrough() }),
    ),
  };
});

const createInterfaceMock = vi.mocked(createInterface);

function openedInterface(): Interface {
  const result = createInterfaceMock.mock.results[0];
  if (result === undefined || result.type !== "return") {
    throw new Error("readLines opened no interface");
  }
  return result.value;
}

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function stubStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  createInterfaceMock.mockClear();
});

afterEach(() => {
  if (originalIsTTY === undefined) {
    Reflect.deleteProperty(process.stdin, "isTTY");
  } else {
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  }
});

describe("PROCESS_PROFILE_LOGIN_IO.readLines", () => {
  it("returns null, and opens nothing, when stdin is not a terminal", () => {
    stubStdinIsTTY(false);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);

    expect(stop).toBeNull();
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it("hands each typed line to onLine", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    const lines = openedInterface();
    lines.emit("line", "code-123");
    lines.emit("line", "second");

    expect(onLine.mock.calls).toEqual([["code-123"], ["second"]]);
    expect(onInterrupt).not.toHaveBeenCalled();
    stop?.();
  });

  it("reports an interrupt when the input closes on its own", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    expect(stop).not.toBeNull();
    openedInterface().emit("close");

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("closes the interface without reporting an interrupt when stopped", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    const lines = openedInterface();
    const closed = vi.fn<() => void>();
    lines.on("close", closed);
    stop?.();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("reports an interrupt when readline reports Ctrl+C itself", () => {
    stubStdinIsTTY(true);
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(vi.fn(), onInterrupt);
    openedInterface().emit("SIGINT");

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    stop?.();
  });
});

describe("PROCESS_PROFILE_LOGIN_IO.openSignInRequests().recordSignInRequest", () => {
  const STORED_TOKEN = "stored-bearer";
  const STORED_HEADER = `Bearer ${STORED_TOKEN}`;
  const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
  const REQUEST: ProviderLoginSignInRequest = {
    operationId: "6f1c1d2e-4c0e-4d7a-9a55-3a1c0d6a8b11",
    environmentId: "environment-1",
    sourceHostId: "host-1",
    sourceSharingGeneration: 1,
    harnessId: "claude-code",
  };
  // The record's own request bound, and the refresh's: its 10 s request bound
  // plus the store's retry waits.
  const RECORD_BOUND_MS = 15_000;
  const REFRESH_BOUND_MS = 20_000;
  const RECORD_PATH = `/api/v3/environments/${REQUEST.environmentId}/profile-records/intents`;

  let calls: Array<{
    readonly pathname: string;
    readonly bearer: string | null;
  }>;
  let recordRefusedBearers: string[];
  let recordStatus: number;
  let hungPaths: string[];
  let onHung: () => void;
  let fileAtRefreshedRecord: string[];
  let refreshStatus: number | null;

  beforeEach(async () => {
    calls = [];
    recordRefusedBearers = [];
    recordStatus = 200;
    hungPaths = [];
    onHung = () => {};
    fileAtRefreshedRecord = [];
    refreshStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        const bearer = bearerOf(init);
        calls.push({ pathname, bearer });
        if (hungPaths.includes(pathname)) {
          onHung();
          return new Promise<Response>(() => {});
        }
        if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
          return refreshAnswer(refreshStatus);
        }
        if (bearer === REFRESHED_HEADER) {
          fileAtRefreshedRecord.push(await storedSignInBytes());
        }
        if (recordRefusedBearers.includes(bearer ?? "")) {
          return new Response("{}", { status: 401 });
        }
        if (recordStatus !== 200) {
          return new Response("{}", { status: recordStatus });
        }
        return new Response(
          JSON.stringify({
            operationId: REQUEST.operationId,
            endsAt: 1_700_000_000_000,
          }),
          { status: 200 },
        );
      }),
    );
    await seedStoredSignIn(STORED_TOKEN, "member-1");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await removeStoredSignIn();
  });

  function paths(): string[] {
    return calls.map(({ pathname }) => pathname);
  }

  function record(): Promise<SignInRequestRecordAnswer> {
    return PROCESS_PROFILE_LOGIN_IO.openSignInRequests().recordSignInRequest(
      REQUEST,
      new AbortController().signal,
    );
  }

  it("refreshes a refused sign-in once and returns the answer to the record sent again on it", async () => {
    recordRefusedBearers = [STORED_HEADER];

    expect(await record()).toEqual({ kind: "recorded" });

    expect(calls).toEqual([
      { pathname: RECORD_PATH, bearer: STORED_HEADER },
      { pathname: STORED_SIGN_IN_REFRESH_PATH, bearer: STORED_HEADER },
      { pathname: RECORD_PATH, bearer: REFRESHED_HEADER },
    ]);
    expect(fileAtRefreshedRecord.map((bytes) => JSON.parse(bytes))).toEqual([
      expect.objectContaining({
        token: REFRESHED_TOKEN,
        refreshToken: REFRESHED_REFRESH_TOKEN,
      }),
    ]);
  });

  it("answers unauthorized, and leaves the stored sign-in as it was, when the refresh is refused", async () => {
    recordRefusedBearers = [STORED_HEADER];
    refreshStatus = 401;
    const before = await storedSignInBytes();

    expect(await record()).toEqual({ kind: "unauthorized" });

    expect(calls.map(({ pathname }) => pathname)).toEqual([
      RECORD_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
    ]);
    expect(await storedSignInBytes()).toBe(before);
  });

  it("answers unauthorized after one refresh when the record is refused again on the refreshed sign-in", async () => {
    recordRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];

    expect(await record()).toEqual({ kind: "unauthorized" });

    expect(calls.map(({ pathname }) => pathname)).toEqual([
      RECORD_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      RECORD_PATH,
    ]);
  });

  it("answers forbidden, and sends no refresh, when authn answers 403", async () => {
    recordStatus = 403;
    const before = await storedSignInBytes();

    expect(await record()).toEqual({ kind: "forbidden" });

    expect(paths()).toEqual([RECORD_PATH]);
    expect(await storedSignInBytes()).toBe(before);
  });

  it("answers failed, with no refresh, once the record's own bound ends a request authn never answers", async () => {
    useBoundedFakeClock();
    hungPaths = [RECORD_PATH];
    const hung = new Promise<void>((resolve) => {
      onHung = resolve;
    });
    let settled = false;
    const answer = record().finally(() => {
      settled = true;
    });
    await hung;

    const elapsedMs = await advanceFakeClockUntil(() => settled);

    expect(await answer).toEqual({ kind: "failed" });
    expect(elapsedMs).toBeLessThanOrEqual(RECORD_BOUND_MS);
    expect(paths()).toEqual([RECORD_PATH]);
  });

  it("answers unauthorized, after one refresh request, once the record's own bound ends a refresh authn never answers", async () => {
    useBoundedFakeClock();
    recordRefusedBearers = [STORED_HEADER];
    hungPaths = [STORED_SIGN_IN_REFRESH_PATH];
    const hung = new Promise<void>((resolve) => {
      onHung = resolve;
    });
    let settled = false;
    const answer = record().finally(() => {
      settled = true;
    });
    await hung;

    const elapsedMs = await advanceFakeClockUntil(() => settled);

    expect(await answer).toEqual({ kind: "unauthorized" });
    expect(elapsedMs).toBeLessThanOrEqual(REFRESH_BOUND_MS);
    expect(paths()).toEqual([RECORD_PATH, STORED_SIGN_IN_REFRESH_PATH]);
  });

  it("sends one refresh in all when two records of one client are both refused", async () => {
    const client = PROCESS_PROFILE_LOGIN_IO.openSignInRequests();
    const send = (): Promise<SignInRequestRecordAnswer> =>
      client.recordSignInRequest(REQUEST, new AbortController().signal);
    recordRefusedBearers = [STORED_HEADER];

    expect(await send()).toEqual({ kind: "recorded" });
    recordRefusedBearers = [REFRESHED_HEADER];
    expect(await send()).toEqual({ kind: "unauthorized" });

    expect(paths()).toEqual([
      RECORD_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      RECORD_PATH,
      RECORD_PATH,
    ]);
  });

  it("answers unauthorized, and sends nothing, for a record after the stored sign-in was removed", async () => {
    const client = PROCESS_PROFILE_LOGIN_IO.openSignInRequests();
    const send = (): Promise<SignInRequestRecordAnswer> =>
      client.recordSignInRequest(REQUEST, new AbortController().signal);

    expect(await send()).toEqual({ kind: "recorded" });
    await removeStoredSignIn();
    expect(await send()).toEqual({ kind: "unauthorized" });

    expect(calls).toEqual([{ pathname: RECORD_PATH, bearer: STORED_HEADER }]);
  });

  it("sends a record after another sign-in replaced the stored one on that account's token, with no refresh", async () => {
    const otherHeader = "Bearer other-account-bearer";
    const client = PROCESS_PROFILE_LOGIN_IO.openSignInRequests();
    const send = (): Promise<SignInRequestRecordAnswer> =>
      client.recordSignInRequest(REQUEST, new AbortController().signal);

    expect(await send()).toEqual({ kind: "recorded" });
    await seedStoredSignIn("other-account-bearer", "member-2");
    expect(await send()).toEqual({ kind: "recorded" });

    expect(calls).toEqual([
      { pathname: RECORD_PATH, bearer: STORED_HEADER },
      { pathname: RECORD_PATH, bearer: otherHeader },
    ]);
  });
});
