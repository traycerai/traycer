import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import {
  SANDBOX_FROZEN_MESSAGE,
  createSandboxViaHttp,
  destroySandboxViaHttp,
  ensureSandboxAwake,
  fetchSandboxCatalogueViaHttp,
  fetchSandboxCostsViaHttp,
  isSandboxAsleep,
  isSandboxFrozenInEffect,
  listSandboxesViaHttp,
  runSandboxVerbViaHttp,
  SANDBOX_VERB_FETCH_TIMEOUT_MS,
  type EnsureSandboxAwakeDeps,
  type SandboxDialFacts,
  type SandboxVerbFetchResult,
  type SandboxWakeBudget,
} from "../sandbox-control";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
/** A request timeout the tests that do not examine it pass. */
const VERB_TIMEOUT_MS = 60_000;
/** A real-shaped sandbox id: the server mints lowercase ULIDs. */
const ULID = "01jbz8k3m4n5p6q7r8s9t0vwxy";
/** Ids that are not one plain path segment, so no URL is built from them. */
const UNSAFE_IDS = ["", ".", "..", "a/b", "a%2Fb", "odd id"] as const;
const INVALID_ID_RESULT = {
  kind: "network-error",
  detail: "the sandbox id is not one the control plane mints",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A control plane from before `frozenAt`, `guestConfigured` and the reason. */
const OLDER_SUMMARY_BODY = {
  id: "sbx_1",
  hostId: "host-1",
  kind: "agent",
  provider: "tensorlake",
  region: "us-east",
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: 20480,
  displayName: "build-box",
  state: "awake",
  frozen: false,
  failureCode: null,
  idleMinutes: null,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
  createdAt: 1_791_000_000_000,
  lastTransitionAt: 1_791_000_010_000,
  lastActivityAt: null,
  destroyedAt: null,
  priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
};

const SUMMARY = {
  ...OLDER_SUMMARY_BODY,
  frozenAt: null,
  guestConfigured: null,
  guestConfigFailureReason: null,
};

function stubFetch(
  respond: (url: string, init: RequestInit) => Promise<Response>,
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    respond(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runSandboxVerbViaHttp", () => {
  it("POSTs the verb to the sandbox's own path with the user bearer", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { sandbox: SUMMARY }),
    );

    await runSandboxVerbViaHttp(BASE, BEARER, ULID, "resume", VERB_TIMEOUT_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/sandboxes/${ULID}/resume`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${BEARER}`,
    });
  });

  it("refuses an id that is not one plain path segment before any request", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { sandbox: SUMMARY }),
    );
    for (const id of UNSAFE_IDS) {
      expect(
        await runSandboxVerbViaHttp(
          BASE,
          BEARER,
          id,
          "resume",
          VERB_TIMEOUT_MS,
        ),
      ).toEqual(INVALID_ID_RESULT);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads 200 as settled", async () => {
    stubFetch(async () => jsonResponse(200, { sandbox: SUMMARY }));
    expect(
      await runSandboxVerbViaHttp(
        BASE,
        BEARER,
        "sbx_1",
        "suspend",
        VERB_TIMEOUT_MS,
      ),
    ).toEqual({ kind: "ok", settled: true });
  });

  it("reads 202 as ok but not settled", async () => {
    stubFetch(async () => jsonResponse(202, { sandbox: SUMMARY }));
    expect(
      await runSandboxVerbViaHttp(
        BASE,
        BEARER,
        "sbx_1",
        "suspend",
        VERB_TIMEOUT_MS,
      ),
    ).toEqual({ kind: "ok", settled: false });
  });

  it("reads 402 sandbox_frozen as a typed refusal carrying the code and status", async () => {
    stubFetch(async () => jsonResponse(402, { code: "sandbox_frozen" }));
    expect(
      await runSandboxVerbViaHttp(
        BASE,
        BEARER,
        "sbx_1",
        "resume",
        VERB_TIMEOUT_MS,
      ),
    ).toEqual({
      kind: "refused",
      status: 402,
      code: "sandbox_frozen",
      reason: null,
      shortfallMc: null,
      newRateMcPerHour: null,
      currentAwakeBurnMcPerHour: null,
    });
  });

  it("reads 409 sandbox_busy as a typed refusal", async () => {
    stubFetch(async () => jsonResponse(409, { code: "sandbox_busy" }));
    const result = await runSandboxVerbViaHttp(
      BASE,
      BEARER,
      "sbx_1",
      "suspend",
      VERB_TIMEOUT_MS,
    );
    expect(result).toMatchObject({
      kind: "refused",
      status: 409,
      code: "sandbox_busy",
    });
  });

  it("carries the credit gate's verdict, shortfall and burn", async () => {
    stubFetch(async () =>
      jsonResponse(402, {
        code: "insufficient_credit",
        reason: "denied",
        shortfallMc: 70,
        newRateMcPerHour: 120,
        currentAwakeBurnMcPerHour: 60,
      }),
    );
    expect(
      await runSandboxVerbViaHttp(
        BASE,
        BEARER,
        "sbx_1",
        "start",
        VERB_TIMEOUT_MS,
      ),
    ).toEqual({
      kind: "refused",
      status: 402,
      code: "insufficient_credit",
      reason: "denied",
      shortfallMc: 70,
      newRateMcPerHour: 120,
      currentAwakeBurnMcPerHour: 60,
    });
  });

  it("reads 401 and 403 as unauthorized, whatever the body says", async () => {
    for (const status of [401, 403]) {
      stubFetch(async () => jsonResponse(status, { code: "sandbox_busy" }));
      expect(
        await runSandboxVerbViaHttp(
          BASE,
          BEARER,
          "sbx_1",
          "stop",
          VERB_TIMEOUT_MS,
        ),
      ).toEqual({ kind: "unauthorized" });
    }
  });

  it("collapses an untyped 5xx and an HTML body into a network error without echoing the body", async () => {
    stubFetch(
      async () =>
        new Response("<html>secret upstream page</html>", { status: 502 }),
    );
    const result = await runSandboxVerbViaHttp(
      BASE,
      BEARER,
      "sbx_1",
      "stop",
      VERB_TIMEOUT_MS,
    );
    expect(result).toEqual({
      kind: "network-error",
      detail: "the control plane answered HTTP 502 without a typed refusal",
    });
  });

  it("collapses a transport failure into a network error that names only the error class", async () => {
    stubFetch(async () => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.1");
    });
    const result = await runSandboxVerbViaHttp(
      BASE,
      BEARER,
      "sbx_1",
      "stop",
      VERB_TIMEOUT_MS,
    );
    expect(result).toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
  });
});

describe("runSandboxVerbViaHttp request deadline", () => {
  /** The signal timeout each request is built with, observed on the platform call. */
  function watchTimeouts(): MockInstance<typeof AbortSignal.timeout> {
    return vi.spyOn(AbortSignal, "timeout");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports the ceiling at the 370 s the card's verbs wait", () => {
    expect(SANDBOX_VERB_FETCH_TIMEOUT_MS).toBe(370_000);
  });

  it("aborts the request at the timeout it was passed", async () => {
    stubFetch(async () => jsonResponse(200, { sandbox: SUMMARY }));
    const timeout = watchTimeouts();

    await runSandboxVerbViaHttp(BASE, BEARER, "sbx_1", "resume", 120_000);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("keeps a timeout that is exactly the ceiling, and caps one above it", async () => {
    stubFetch(async () => jsonResponse(200, { sandbox: SUMMARY }));
    const timeout = watchTimeouts();

    await runSandboxVerbViaHttp(
      BASE,
      BEARER,
      "sbx_1",
      "resume",
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    expect(timeout).toHaveBeenLastCalledWith(370_000);

    await runSandboxVerbViaHttp(BASE, BEARER, "sbx_1", "resume", 370_001);
    expect(timeout).toHaveBeenLastCalledWith(370_000);

    await runSandboxVerbViaHttp(BASE, BEARER, "sbx_1", "resume", 1_000_000);
    expect(timeout).toHaveBeenLastCalledWith(370_000);
  });

  it("treats a negative timeout as already spent rather than throwing", async () => {
    stubFetch(async () => jsonResponse(200, { sandbox: SUMMARY }));
    const timeout = watchTimeouts();

    await expect(
      runSandboxVerbViaHttp(BASE, BEARER, "sbx_1", "resume", -5_000),
    ).resolves.toEqual({ kind: "ok", settled: true });
    expect(timeout).toHaveBeenCalledWith(0);
  });

  it("hands fetch a signal that fires at that timeout, and reads the abort as a network error", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.signal = init.signal ?? null;
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
    );

    const pending = runSandboxVerbViaHttp(BASE, BEARER, "sbx_1", "resume", 30);
    await Promise.resolve();
    // A signal exists and has not fired yet.
    expect(seen.signal).not.toBeNull();
    expect(seen.signal?.aborted).toBe(false);

    expect(await pending).toEqual({
      kind: "network-error",
      detail: "the request never completed (TimeoutError)",
    });
    expect(seen.signal?.aborted).toBe(true);
  });
});

describe("destroySandboxViaHttp", () => {
  it("DELETEs the sandbox and reads 200 as settled, 202 as still destroying", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    expect(await destroySandboxViaHttp(BASE, BEARER, "sbx_1")).toEqual({
      kind: "ok",
      settled: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/sandboxes/sbx_1`);
    expect(init?.method).toBe("DELETE");

    stubFetch(async () => jsonResponse(202, {}));
    expect(await destroySandboxViaHttp(BASE, BEARER, "sbx_1")).toEqual({
      kind: "ok",
      settled: false,
    });
  });

  it("refuses an id that is not one plain path segment before any request", async () => {
    // An empty id would otherwise DELETE the collection.
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    for (const id of UNSAFE_IDS) {
      expect(await destroySandboxViaHttp(BASE, BEARER, id)).toEqual(
        INVALID_ID_RESULT,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands a 404 sandbox_not_found to the caller as a typed refusal", async () => {
    stubFetch(async () => jsonResponse(404, { code: "sandbox_not_found" }));
    expect(await destroySandboxViaHttp(BASE, BEARER, "sbx_1")).toMatchObject({
      kind: "refused",
      status: 404,
      code: "sandbox_not_found",
    });
  });
});

describe("fetchSandboxCostsViaHttp", () => {
  const COSTS = {
    sandboxes: [
      {
        sandboxId: "sbx_1",
        currentRateMillicreditsPerHour: 120,
        state: "awake",
        frozen: false,
        charged: {
          computeMillicredits: 10,
          storageMillicredits: 2,
          sinceCreatedAt: 1_791_000_000_000,
        },
        pendingMillicredits: 0,
        segments: [],
      },
    ],
    awakeBurnMillicreditsPerHour: 120,
  };

  it("parses the user's cost view", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, COSTS));
    const result = await fetchSandboxCostsViaHttp(BASE, BEARER);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${BASE}/api/sandboxes/cost`,
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.costs.awakeBurnMillicreditsPerHour).toBe(120);
    }
  });

  it("answers a parse failure as a network error, never a zero burn", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        sandboxes: [],
        awakeBurnMillicreditsPerHour: "lots",
      }),
    );
    expect(await fetchSandboxCostsViaHttp(BASE, BEARER)).toEqual({
      kind: "network-error",
      detail: "the sandbox cost did not match the contract",
    });
  });
});

describe("the other sandbox routes parse or fail the same way", () => {
  it("list: a body that is not the contract is a network error", async () => {
    stubFetch(async () => jsonResponse(200, { sandboxes: [{ id: "" }] }));
    expect(await listSandboxesViaHttp(BASE, BEARER)).toEqual({
      kind: "network-error",
      detail: "the sandbox list did not match the contract",
    });
  });

  it("list: parses rows and defaults the three newer fields", async () => {
    stubFetch(async () =>
      jsonResponse(200, { sandboxes: [OLDER_SUMMARY_BODY] }),
    );
    const result = await listSandboxesViaHttp(BASE, BEARER);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.response.sandboxes[0]?.frozenAt).toBeNull();
    }
  });

  it("catalogue: a body that is not the contract is a network error", async () => {
    stubFetch(async () => jsonResponse(200, { providers: "none" }));
    expect(await fetchSandboxCatalogueViaHttp(BASE, BEARER)).toEqual({
      kind: "network-error",
      detail: "the sandbox catalogue did not match the contract",
    });
  });

  it("create: sends the body as JSON and reads a typed shape refusal", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(400, {
        code: "shape_not_offered",
        reason: "cpus-out-of-range",
      }),
    );
    const result = await createSandboxViaHttp(BASE, BEARER, {
      os: "linux",
      cpus: 64,
      memoryMb: 4096,
      diskMb: null,
      region: null,
      displayName: "big",
      idleMinutes: null,
      burst: false,
      createdByHostId: null,
      createdByAgentId: null,
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(result).toMatchObject({
      kind: "refused",
      status: 400,
      code: "shape_not_offered",
      reason: "cpus-out-of-range",
    });
  });
});

describe("isSandboxFrozenInEffect", () => {
  it("lets a terminal state win over the stored frozen flag", () => {
    for (const state of [
      "destroying",
      "destroyed",
      "failed",
      "released",
    ] as const) {
      expect(isSandboxFrozenInEffect(state, true)).toBe(false);
    }
  });

  it("keeps a stored frozen flag in effect for every other state, and for an unknown one", () => {
    for (const state of [
      "creating",
      "awake",
      "suspending",
      "suspended",
      "resuming",
      "stopping",
      "stopped",
      "starting",
      null,
    ] as const) {
      expect(isSandboxFrozenInEffect(state, true)).toBe(true);
    }
  });

  it("is never in effect for a row that is not frozen", () => {
    for (const state of [
      "awake",
      "suspended",
      "stopped",
      "destroyed",
      null,
    ] as const) {
      expect(isSandboxFrozenInEffect(state, false)).toBe(false);
    }
  });
});

describe("isSandboxAsleep", () => {
  it("is true for a sandbox suspended or stopped, or on its way there", () => {
    for (const state of [
      "suspending",
      "suspended",
      "stopping",
      "stopped",
    ] as const) {
      expect(isSandboxAsleep(state)).toBe(true);
    }
  });

  it("is false for a sandbox that is up, coming up, gone or unknown", () => {
    for (const state of [
      "creating",
      "awake",
      "resuming",
      "starting",
      "destroying",
      "destroyed",
      "failed",
      "released",
      null,
    ] as const) {
      expect(isSandboxAsleep(state)).toBe(false);
    }
  });
});

describe("ensureSandboxAwake", () => {
  /**
   * A budget the test spends by hand. `start` records the budget's length and
   * `cancel` how often the wake released it.
   */
  function controlledBudget(): {
    readonly budget: SandboxWakeBudget;
    readonly cancel: Mock<() => void>;
    readonly start: Mock<(ms: number) => SandboxWakeBudget>;
    spend(): void;
  } {
    let spend: () => void = () => undefined;
    const elapsed = new Promise<void>((resolve) => {
      spend = resolve;
    });
    const cancel = vi.fn<() => void>();
    const budget: SandboxWakeBudget = { elapsed, cancel };
    const start = vi.fn<(ms: number) => SandboxWakeBudget>(() => budget);
    return { budget, cancel, start, spend: () => spend() };
  }

  function deps(input: {
    readonly initial: SandboxDialFacts;
    readonly wake: EnsureSandboxAwakeDeps["wake"];
    readonly reads: readonly (SandboxDialFacts | null)[];
  }): EnsureSandboxAwakeDeps & { readonly clock: { t: number } } {
    const clock = { t: 0 };
    let read = 0;
    return {
      clock,
      initial: input.initial,
      wake: input.wake,
      readFacts: async () => {
        const facts = input.reads[Math.min(read, input.reads.length - 1)];
        read += 1;
        return facts;
      },
      sleep: async (ms: number) => {
        clock.t += ms;
      },
      now: () => clock.t,
      pollIntervalMs: 1_000,
      timeoutMs: 5_000,
      // A budget that never runs out on its own: the clock-driven deadline
      // is what ends a wake unless a test hands in a spendable one.
      startBudget: () => ({
        elapsed: new Promise<void>(() => undefined),
        cancel: () => undefined,
      }),
    };
  }

  const suspended: SandboxDialFacts = {
    sandboxId: "sbx_1",
    state: "suspended",
    frozen: false,
  };
  const awake: SandboxDialFacts = { ...suspended, state: "awake" };
  const ok: SandboxVerbFetchResult = { kind: "ok", settled: true };

  it("answers awake at once for an awake row without calling the wake verb", async () => {
    const wake = vi.fn(async () => ok);
    const outcome = await ensureSandboxAwake(
      deps({ initial: awake, wake, reads: [awake] }),
    );
    expect(outcome).toEqual({ kind: "awake" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("maps a frozen row to the frozen outcome before any verb is sent", async () => {
    const wake = vi.fn(async () => ok);
    const outcome = await ensureSandboxAwake(
      deps({
        initial: { ...suspended, frozen: true },
        wake,
        reads: [awake],
      }),
    );
    expect(outcome).toEqual({
      kind: "refused",
      code: "SANDBOX_FROZEN",
      message: SANDBOX_FROZEN_MESSAGE,
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("maps a sandbox_frozen refusal from the verb to the same frozen outcome", async () => {
    const outcome = await ensureSandboxAwake(
      deps({
        initial: suspended,
        wake: async () => ({
          kind: "refused",
          status: 402,
          code: "sandbox_frozen",
          reason: null,
          shortfallMc: null,
          newRateMcPerHour: null,
          currentAwakeBurnMcPerHour: null,
        }),
        reads: [awake],
      }),
    );
    expect(outcome).toEqual({
      kind: "refused",
      code: "SANDBOX_FROZEN",
      message: SANDBOX_FROZEN_MESSAGE,
    });
  });

  it("resumes a suspended row, starts a stopped one, then polls until awake", async () => {
    const wake = vi.fn(async () => ok);
    const resumed = await ensureSandboxAwake(
      deps({
        initial: suspended,
        wake,
        reads: [{ ...suspended, state: "resuming" }, awake],
      }),
    );
    expect(resumed).toEqual({ kind: "awake" });
    expect(wake).toHaveBeenLastCalledWith("sbx_1", "resume", 5_000);

    const started = await ensureSandboxAwake(
      deps({
        initial: { ...suspended, state: "stopped" },
        wake,
        reads: [awake],
      }),
    );
    expect(started).toEqual({ kind: "awake" });
    expect(wake).toHaveBeenLastCalledWith("sbx_1", "start", 5_000);
  });

  it("passes the wake what is left of its budget: the timeout minus the time already spent", async () => {
    const wake = vi.fn(async () => ok);
    const base = deps({ initial: suspended, wake, reads: [awake] });
    // Every read of the clock costs 700 ms of fake time, so the deadline is
    // taken at t = 0 and the verb is sent at t = 700.
    const ticking = {
      ...base,
      now: () => {
        const t = base.clock.t;
        base.clock.t += 700;
        return t;
      },
    };

    const outcome = await ensureSandboxAwake(ticking);

    expect(outcome).toEqual({ kind: "awake" });
    // timeoutMs 5_000 - 700.
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("sbx_1", "resume", 4_300);
  });

  it("passes the whole budget to a wake sent the moment it starts", async () => {
    const wake = vi.fn(async () => ok);

    await ensureSandboxAwake(
      deps({ initial: suspended, wake, reads: [awake] }),
    );

    expect(wake).toHaveBeenCalledWith("sbx_1", "resume", 5_000);
  });

  it("sends no verb to a row already coming up", async () => {
    const wake = vi.fn(async () => ok);
    const outcome = await ensureSandboxAwake(
      deps({
        initial: { ...suspended, state: "resuming" },
        wake,
        reads: [awake],
      }),
    );
    expect(outcome).toEqual({ kind: "awake" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("reports the credit gate's shortfall and burn", async () => {
    const outcome = await ensureSandboxAwake(
      deps({
        initial: suspended,
        wake: async () => ({
          kind: "refused",
          status: 402,
          code: "insufficient_credit",
          reason: "denied",
          shortfallMc: 70,
          newRateMcPerHour: 120,
          currentAwakeBurnMcPerHour: 60,
        }),
        reads: [awake],
      }),
    );
    expect(outcome).toEqual({
      kind: "credit-gate",
      shortfallMc: 70,
      burnMcPerHour: 60,
    });
  });

  it("maps verb_not_available, unauthorized and an unknown code to their own outcomes", async () => {
    const refusal = (code: string): SandboxVerbFetchResult => ({
      kind: "refused",
      status: 501,
      code,
      reason: null,
      shortfallMc: null,
      newRateMcPerHour: null,
      currentAwakeBurnMcPerHour: null,
    });
    expect(
      await ensureSandboxAwake(
        deps({
          initial: suspended,
          wake: async () => refusal("verb_not_available"),
          reads: [awake],
        }),
      ),
    ).toEqual({ kind: "wake-not-available" });
    expect(
      await ensureSandboxAwake(
        deps({
          initial: suspended,
          wake: async () => ({ kind: "unauthorized" }),
          reads: [awake],
        }),
      ),
    ).toEqual({
      kind: "failed",
      detail: "the control plane refused the bearer",
    });
    expect(
      await ensureSandboxAwake(
        deps({
          initial: suspended,
          wake: async () => refusal("something_new"),
          reads: [awake],
        }),
      ),
    ).toEqual({
      kind: "failed",
      detail: "the control plane refused the wake (something_new)",
    });
  });

  it("answers not-wakeable for a destroyed, failed or released row and for a vanished one", async () => {
    for (const state of [
      "destroying",
      "destroyed",
      "failed",
      "released",
    ] as const) {
      expect(
        await ensureSandboxAwake(
          deps({
            initial: { ...suspended, state },
            wake: async () => ok,
            reads: [awake],
          }),
        ),
      ).toEqual({ kind: "not-wakeable", state });
    }
    expect(
      await ensureSandboxAwake(
        deps({ initial: suspended, wake: async () => ok, reads: [null] }),
      ),
    ).toEqual({ kind: "not-wakeable", state: null });
  });

  it("answers not-wakeable, not frozen, for a destroyed row whose stored frozen flag is still set", async () => {
    const wake = vi.fn(async () => ok);
    const outcome = await ensureSandboxAwake(
      deps({
        initial: { ...suspended, state: "destroyed", frozen: true },
        wake,
        reads: [awake],
      }),
    );
    expect(outcome).toEqual({ kind: "not-wakeable", state: "destroyed" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("gives up after the timeout when the row never reports awake", async () => {
    const outcome = await ensureSandboxAwake(
      deps({
        initial: suspended,
        wake: async () => ok,
        reads: [{ ...suspended, state: "resuming" }],
      }),
    );
    expect(outcome).toEqual({
      kind: "failed",
      detail: "the sandbox did not report awake in time",
    });
  });

  it("turns frozen the moment a re-read says so, even mid-wake", async () => {
    const outcome = await ensureSandboxAwake(
      deps({
        initial: suspended,
        wake: async () => ok,
        reads: [{ ...suspended, frozen: true }],
      }),
    );
    expect(outcome.kind).toBe("refused");
  });

  describe("the wake budget covers the lifecycle verb", () => {
    it("starts the budget for the whole timeout before the verb is sent", async () => {
      const order: string[] = [];
      const controlled = controlledBudget();
      const outcome = await ensureSandboxAwake({
        ...deps({
          initial: suspended,
          wake: async () => {
            order.push("wake");
            return ok;
          },
          reads: [awake],
        }),
        startBudget: (ms) => {
          order.push(`budget:${ms}`);
          return controlled.start(ms);
        },
      });

      expect(outcome).toEqual({ kind: "awake" });
      expect(order).toEqual(["budget:5000", "wake"]);
      expect(controlled.start).toHaveBeenCalledTimes(1);
    });

    it("fails the wake as timed out when the verb's own request outlives the budget", async () => {
      const controlled = controlledBudget();
      const readFacts = vi.fn(async () => awake);
      const pending = ensureSandboxAwake({
        ...deps({
          initial: suspended,
          // A request that never answers: the old budget only started after it.
          wake: () => new Promise<SandboxVerbFetchResult>(() => undefined),
          reads: [awake],
        }),
        readFacts,
        startBudget: controlled.start,
      });
      controlled.spend();

      expect(await pending).toEqual({
        kind: "failed",
        detail: "the sandbox did not report awake in time",
      });
      // The poll never began: the verb ate the whole budget.
      expect(readFacts).not.toHaveBeenCalled();
      expect(controlled.cancel).toHaveBeenCalledTimes(1);
    });

    it("fails the wake as timed out when a poll read outlives the budget", async () => {
      const controlled = controlledBudget();
      const pending = ensureSandboxAwake({
        ...deps({ initial: suspended, wake: async () => ok, reads: [awake] }),
        readFacts: () => new Promise<SandboxDialFacts | null>(() => undefined),
        startBudget: controlled.start,
      });
      controlled.spend();

      expect(await pending).toEqual({
        kind: "failed",
        detail: "the sandbox did not report awake in time",
      });
      expect(controlled.cancel).toHaveBeenCalledTimes(1);
    });

    it("does not start a budget for a row that is settled before any verb", async () => {
      const controlled = controlledBudget();
      const wake = vi.fn(async () => ok);

      expect(
        await ensureSandboxAwake({
          ...deps({ initial: awake, wake, reads: [awake] }),
          startBudget: controlled.start,
        }),
      ).toEqual({ kind: "awake" });
      expect(
        await ensureSandboxAwake({
          ...deps({
            initial: { ...suspended, frozen: true },
            wake,
            reads: [awake],
          }),
          startBudget: controlled.start,
        }),
      ).toEqual({
        kind: "refused",
        code: "SANDBOX_FROZEN",
        message: SANDBOX_FROZEN_MESSAGE,
      });
      expect(controlled.start).not.toHaveBeenCalled();
      expect(controlled.cancel).not.toHaveBeenCalled();
    });

    it("releases the budget once on every way a started wake can end", async () => {
      const refused: SandboxVerbFetchResult = {
        kind: "refused",
        status: 402,
        code: "sandbox_frozen",
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
      };
      const cases: readonly {
        readonly name: string;
        readonly build: () => EnsureSandboxAwakeDeps;
        readonly kind: string;
      }[] = [
        {
          name: "awake",
          build: () =>
            deps({ initial: suspended, wake: async () => ok, reads: [awake] }),
          kind: "awake",
        },
        {
          name: "the verb refused",
          build: () =>
            deps({
              initial: suspended,
              wake: async () => refused,
              reads: [awake],
            }),
          kind: "refused",
        },
        {
          name: "the row vanished",
          build: () =>
            deps({ initial: suspended, wake: async () => ok, reads: [null] }),
          kind: "not-wakeable",
        },
        {
          name: "the clock deadline passed",
          build: () =>
            deps({
              initial: suspended,
              wake: async () => ok,
              reads: [{ ...suspended, state: "resuming" }],
            }),
          kind: "failed",
        },
      ];
      for (const testCase of cases) {
        const controlled = controlledBudget();
        const outcome = await ensureSandboxAwake({
          ...testCase.build(),
          startBudget: controlled.start,
        });
        expect(outcome.kind, testCase.name).toBe(testCase.kind);
        expect(controlled.cancel, testCase.name).toHaveBeenCalledTimes(1);
      }
    });

    it("releases the budget when the verb throws", async () => {
      const controlled = controlledBudget();
      await expect(
        ensureSandboxAwake({
          ...deps({
            initial: suspended,
            wake: async () => {
              throw new Error("socket closed");
            },
            reads: [awake],
          }),
          startBudget: controlled.start,
        }),
      ).rejects.toThrow("socket closed");
      expect(controlled.cancel).toHaveBeenCalledTimes(1);
    });
  });
});
