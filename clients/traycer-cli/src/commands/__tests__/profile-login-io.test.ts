import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import type { SignInRequestRecordAnswer } from "../../../../shared/host-client/provider-sign-in-request";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { PROCESS_PROFILE_LOGIN_IO } from "../profile-login";
import {
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

describe("PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest", () => {
  const STORED_TOKEN = "stored-bearer";
  let testUserId = "profile-login-io-user-0";
  let testUserSequence = 0;
  const STORED_HEADER = `Bearer ${STORED_TOKEN}`;
  const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
  const REQUEST: ProviderLoginSignInRequest = {
    operationId: "6f1c1d2e-4c0e-4d7a-9a55-3a1c0d6a8b11",
    environmentId: "environment-1",
    sourceHostId: "host-1",
    sourceSharingGeneration: 1,
    harnessId: "claude-code",
  };
  const RECORD_BOUND_MS = 15_000;
  const REFRESH_BOUND_MS = 20_000;
  const RECORD_PATH = `/api/v3/environments/${REQUEST.environmentId}/profile-records/intents`;
  const IDENTITY_PATH = "/api/v3/user/negotiated";

  let calls: Array<{
    pathname: string;
    bearer: "stored" | "refreshed" | "other" | null;
  }>;
  let identityReads: Array<{
    pathname: string;
    bearer: "stored" | "refreshed" | "other" | null;
  }>;
  let recordBearers: Array<"stored" | "refreshed" | "other" | null>;
  let recordRefusedBearers: string[];
  let identityStatuses: number[];
  let recordStatus: number;
  let heldRequest: {
    readonly pathname: string;
    readonly boundMs: number;
    readonly response: AbortableResponse;
  } | null;
  let fileAtRefreshedRecord: boolean[];
  let refreshStatus: number | null;
  let deferredRefresh: AbortableResponse | null;
  let requestControllers: AbortController[];
  let pendingOperations: Promise<unknown>[];
  let cleanupStarted: boolean;

  function bearerKind(
    bearer: string | null,
  ): "stored" | "refreshed" | "other" | null {
    if (bearer === STORED_HEADER) return "stored";
    if (bearer === REFRESHED_HEADER) return "refreshed";
    return bearer === null ? null : "other";
  }

  interface Gate {
    readonly promise: Promise<void>;
    readonly open: () => void;
  }

  interface AbortableResponse {
    readonly promise: Promise<Response>;
    readonly started: Gate;
    readonly aborted: Gate;
    readonly settled: Promise<void>;
    bind(signal: AbortSignal): void;
    resolve(response: Response): void;
    abort(): void;
    isPending(): boolean;
    getSignal(): AbortSignal | null;
  }

  function createGate(): Gate {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  function createAbortableResponse(): AbortableResponse {
    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (reason: unknown) => void;
    const promise = new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    const started = createGate();
    const aborted = createGate();
    let pending = true;
    let signal: AbortSignal | null = null;
    let abortListener: (() => void) | null = null;

    function removeAbortListener(): void {
      if (signal !== null && abortListener !== null) {
        signal.removeEventListener("abort", abortListener);
      }
      abortListener = null;
    }

    function rejectOnAbort(): void {
      if (!pending) return;
      pending = false;
      removeAbortListener();
      aborted.open();
      rejectResponse(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    }

    function bind(nextSignal: AbortSignal): void {
      signal = nextSignal;
      abortListener = rejectOnAbort;
      if (signal.aborted) {
        rejectOnAbort();
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    function resolve(response: Response): void {
      if (!pending) return;
      pending = false;
      removeAbortListener();
      resolveResponse(response);
    }

    function abort(): void {
      if (!pending) return;
      pending = false;
      removeAbortListener();
      rejectResponse(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    }

    return {
      promise,
      started,
      aborted,
      settled,
      bind,
      resolve,
      abort,
      isPending: () => pending,
      getSignal: () => signal,
    };
  }

  function trackedController(): AbortController {
    const controller = new AbortController();
    requestControllers.push(controller);
    return controller;
  }

  function trackOperation<A>(operation: Promise<A>): Promise<A> {
    pendingOperations.push(operation);
    return operation;
  }

  function holdRequest(
    pathname: string,
    boundMs: number,
  ): { readonly started: Gate; readonly aborted: Gate } {
    const response = createAbortableResponse();
    heldRequest = { pathname, boundMs, response };
    return { started: response.started, aborted: response.aborted };
  }

  function itWithCleanup(name: string, body: () => Promise<void>): void {
    it(name, async () => {
      onTestFinished(async () => {
        cleanupStarted = true;
        for (const controller of requestControllers) controller.abort();

        if (deferredRefresh !== null) {
          deferredRefresh.resolve(refreshAnswer(200));
          await deferredRefresh.settled;
        }

        if (heldRequest !== null) {
          const signal = heldRequest.response.getSignal();
          if (
            heldRequest.response.isPending() &&
            signal !== null &&
            !signal.aborted
          ) {
            await vi.advanceTimersByTimeAsync(heldRequest.boundMs);
          }
          heldRequest.response.abort();
          await heldRequest.response.settled;
        }

        await Promise.all(
          pendingOperations.map((operation) =>
            operation.then(
              () => undefined,
              () => undefined,
            ),
          ),
        );
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await removeStoredSignIn();
      });
      await body();
    });
  }

  beforeEach(async () => {
    testUserId = `profile-login-io-user-${++testUserSequence}`;
    calls = [];
    identityReads = [];
    recordBearers = [];
    recordRefusedBearers = [];
    identityStatuses = [];
    recordStatus = 200;
    heldRequest = null;
    fileAtRefreshedRecord = [];
    refreshStatus = 200;
    deferredRefresh = null;
    requestControllers = [];
    pendingOperations = [];
    cleanupStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (cleanupStarted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const pathname = new URL(String(input)).pathname;
        const bearer = bearerOf(init);
        const label = bearerKind(bearer);
        const actuallySent = init?.signal?.aborted !== true;
        if (actuallySent) calls.push({ pathname, bearer: label });
        if (!actuallySent) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (heldRequest !== null && heldRequest.pathname === pathname) {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            throw new Error("Held request had no AbortSignal");
          }
          heldRequest.response.started.open();
          heldRequest.response.bind(signal);
          return heldRequest.response.promise;
        }
        if (pathname === IDENTITY_PATH) {
          identityReads.push({ pathname, bearer: label });
          const status = identityStatuses[identityReads.length - 1] ?? 200;
          if (status !== 200) return new Response("{}", { status });
          const fixture = createAuthenticatedUserFixture(undefined);
          return new Response(
            JSON.stringify({
              ...fixture,
              user: { ...fixture.user, id: testUserId },
              userSubscription: {
                ...fixture.userSubscription,
                userID: testUserId,
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-traycer-user-record-version": "3.0",
              },
            },
          );
        }
        if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
          if (deferredRefresh !== null) {
            const signal = init?.signal;
            if (signal === undefined || signal === null) {
              throw new Error("Deferred refresh had no AbortSignal");
            }
            deferredRefresh.started.open();
            deferredRefresh.bind(signal);
            return deferredRefresh.promise;
          }
          return refreshAnswer(refreshStatus);
        }
        if (pathname === RECORD_PATH) {
          recordBearers.push(label);
          if (bearer === REFRESHED_HEADER) {
            const stored = JSON.parse(await storedSignInBytes()) as {
              token: string;
              refreshToken: string;
            };
            fileAtRefreshedRecord.push(
              stored.token === REFRESHED_TOKEN &&
                stored.refreshToken === REFRESHED_REFRESH_TOKEN,
            );
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
        }
        throw new Error(`Unexpected authn request path: ${pathname}`);
      }),
    );
    await seedStoredSignIn(STORED_TOKEN, testUserId);
  });

  function paths(): string[] {
    return calls.map(({ pathname }) => pathname);
  }

  function record(signal: AbortSignal): Promise<SignInRequestRecordAnswer> {
    return trackOperation(
      PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest(
        REQUEST,
        signal,
      ),
    );
  }

  itWithCleanup(
    "refreshes one refused sign-in, reads identity twice, and resends the record once on the refreshed sign-in",
    async () => {
      recordRefusedBearers = [STORED_HEADER];
      identityStatuses = [401, 200];

      expect(await record(trackedController().signal)).toEqual({
        kind: "recorded",
      });

      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
      ]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual([
        "stored",
        "refreshed",
      ]);
      expect(recordBearers).toEqual(["stored", "refreshed"]);
      expect(fileAtRefreshedRecord).toEqual([true]);
    },
  );

  itWithCleanup(
    "answers unauthorized after one refused refresh, with one record and one identity read, leaving stored bytes unchanged",
    async () => {
      recordRefusedBearers = [STORED_HEADER];
      identityStatuses = [401];
      refreshStatus = 401;
      const before = await storedSignInBytes();

      expect(await record(trackedController().signal)).toEqual({
        kind: "unauthorized",
      });

      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(recordBearers).toEqual(["stored"]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual(["stored"]);
      expect((await storedSignInBytes()) === before).toBe(true);
    },
  );

  itWithCleanup(
    "answers unauthorized after one refresh when the refreshed record is refused again, with two records and two identity reads",
    async () => {
      recordRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];
      identityStatuses = [401, 200];

      expect(await record(trackedController().signal)).toEqual({
        kind: "unauthorized",
      });

      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
      ]);
      expect(recordBearers).toEqual(["stored", "refreshed"]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual([
        "stored",
        "refreshed",
      ]);
    },
  );

  itWithCleanup(
    "answers forbidden to a 403 with one record and no identity read, refresh, or resend",
    async () => {
      recordStatus = 403;

      expect(await record(trackedController().signal)).toEqual({
        kind: "forbidden",
      });

      expect(paths()).toEqual([RECORD_PATH]);
      expect(recordBearers).toEqual(["stored"]);
      expect(identityReads).toEqual([]);
    },
  );

  itWithCleanup(
    "answers failed after the record's 15-second bound, with one record and no identity read or refresh",
    async () => {
      useBoundedFakeClock();
      const held = holdRequest(RECORD_PATH, RECORD_BOUND_MS);
      const answer = record(trackedController().signal);

      await held.started.promise;
      await vi.advanceTimersByTimeAsync(RECORD_BOUND_MS);
      await held.aborted.promise;

      expect(await answer).toEqual({ kind: "failed" });
      expect(paths()).toEqual([RECORD_PATH]);
      expect(
        calls
          .filter(({ pathname }) => pathname === RECORD_PATH)
          .map(({ bearer }) => bearer),
      ).toEqual(["stored"]);
      expect(identityReads).toEqual([]);
    },
  );

  itWithCleanup(
    "answers failed, not unauthorized, after one refresh request's bound with one record and one identity read",
    async () => {
      useBoundedFakeClock();
      recordRefusedBearers = [STORED_HEADER];
      identityStatuses = [401];
      const held = holdRequest(STORED_SIGN_IN_REFRESH_PATH, REFRESH_BOUND_MS);
      const answer = record(trackedController().signal);

      await held.started.promise;
      await vi.advanceTimersByTimeAsync(REFRESH_BOUND_MS);
      await held.aborted.promise;

      expect(await answer).toEqual({ kind: "failed" });
      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
      ]);
      expect(recordBearers).toEqual(["stored"]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual(["stored"]);
    },
  );

  itWithCleanup(
    "waits for a refresh already in flight after cancellation, then reads the refreshed identity without sending a canceled record",
    async () => {
      recordRefusedBearers = [STORED_HEADER];
      identityStatuses = [401, 200];
      const refresh = createAbortableResponse();
      deferredRefresh = refresh;
      const controller = trackedController();
      const answer = record(controller.signal);

      await refresh.started.promise;
      controller.abort();
      refresh.resolve(refreshAnswer(200));
      await refresh.settled;

      expect(await answer).toEqual({ kind: "failed" });
      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
      ]);
      expect(recordBearers).toEqual(["stored"]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual([
        "stored",
        "refreshed",
      ]);
    },
  );

  itWithCleanup(
    "reuses the refreshed identity on a second refused record of the same client, with one refresh total",
    async () => {
      const send = (): Promise<SignInRequestRecordAnswer> =>
        record(trackedController().signal);
      recordRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];
      identityStatuses = [401, 200, 200];

      expect(await send()).toEqual({ kind: "unauthorized" });
      expect(await send()).toEqual({ kind: "unauthorized" });

      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
        RECORD_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
      ]);
      expect(recordBearers).toEqual([
        "stored",
        "refreshed",
        "refreshed",
        "refreshed",
      ]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual([
        "stored",
        "refreshed",
        "refreshed",
      ]);
    },
  );

  itWithCleanup(
    "refreshes again when the second record's identity read also refuses, with two refreshes total",
    async () => {
      const send = (): Promise<SignInRequestRecordAnswer> =>
        record(trackedController().signal);
      recordRefusedBearers = [STORED_HEADER, REFRESHED_HEADER];
      identityStatuses = [401, 200, 401, 200];

      expect(await send()).toEqual({ kind: "unauthorized" });
      expect(await send()).toEqual({ kind: "unauthorized" });

      expect(paths()).toEqual([
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
        RECORD_PATH,
        IDENTITY_PATH,
        STORED_SIGN_IN_REFRESH_PATH,
        IDENTITY_PATH,
        RECORD_PATH,
      ]);
      expect(recordBearers).toEqual([
        "stored",
        "refreshed",
        "refreshed",
        "refreshed",
      ]);
      expect(identityReads.map(({ bearer }) => bearer)).toEqual([
        "stored",
        "refreshed",
        "refreshed",
        "refreshed",
      ]);
    },
  );

  itWithCleanup(
    "answers unauthorized without sending a record after the stored sign-in was removed",
    async () => {
      const send = (): Promise<SignInRequestRecordAnswer> =>
        record(trackedController().signal);

      expect(await send()).toEqual({ kind: "recorded" });
      await removeStoredSignIn();
      expect(await send()).toEqual({ kind: "unauthorized" });

      expect(paths()).toEqual([RECORD_PATH]);
      expect(recordBearers).toEqual(["stored"]);
      expect(identityReads).toEqual([]);
    },
  );

  itWithCleanup(
    "sends a record on a replacement sign-in with no identity read or refresh",
    async () => {
      const send = (): Promise<SignInRequestRecordAnswer> =>
        record(trackedController().signal);

      expect(await send()).toEqual({ kind: "recorded" });
      await seedStoredSignIn("other-account-bearer", "member-2");
      expect(await send()).toEqual({ kind: "recorded" });

      expect(paths()).toEqual([RECORD_PATH, RECORD_PATH]);
      expect(recordBearers).toEqual(["stored", "other"]);
      expect(identityReads).toEqual([]);
    },
  );
});
