import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import type { SignInRequestRecordAnswer } from "../../../../shared/host-client/provider-sign-in-request";
import { PROCESS_PROFILE_LOGIN_IO } from "../profile-login";
import {
  bearerOf,
  refreshAnswer,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
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

describe("PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest", () => {
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
  const RECORD_PATH = `/api/v3/environments/${REQUEST.environmentId}/profile-records/intents`;

  let calls: Array<{
    readonly pathname: string;
    readonly bearer: string | null;
  }>;
  let recordRefusedBearers: string[];
  let refreshStatus: number | null;

  beforeEach(async () => {
    calls = [];
    recordRefusedBearers = [];
    refreshStatus = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        const bearer = bearerOf(init);
        calls.push({ pathname, bearer });
        if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
          return refreshAnswer(refreshStatus);
        }
        if (recordRefusedBearers.includes(bearer ?? "")) {
          return new Response("{}", { status: 401 });
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
    vi.unstubAllGlobals();
    await removeStoredSignIn();
  });

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
    expect(JSON.parse(await storedSignInBytes())).toMatchObject({
      token: REFRESHED_TOKEN,
    });
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
});
