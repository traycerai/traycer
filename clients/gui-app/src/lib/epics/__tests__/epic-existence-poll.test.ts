import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createOutcomeIsDecidable,
  EPIC_EXISTENCE_POLL_BUDGET_MS,
  pollEpicExistence,
  resetEpicExistencePollForTests,
  type EpicExistenceClient,
  type EpicExistenceVerdict,
} from "@/lib/epics/epic-existence-poll";

const EPIC = "epic-1";
const HOST = "host-1";

interface ProbeCall {
  readonly method: string;
  readonly params: unknown;
  /** Fake-clock time the probe was ISSUED, not when it settled. */
  readonly at: number;
}

type TaskContextRow =
  | { readonly status: "found"; readonly task: Record<string, unknown> }
  | { readonly status: "confirmed-absent" }
  | { readonly status: "unknown"; readonly reason: string };

function fakeClient(
  respond: (
    call: number,
  ) => Promise<{ readonly tasks: Record<string, TaskContextRow> }>,
): {
  readonly client: EpicExistenceClient;
  readonly calls: ReadonlyArray<ProbeCall>;
} {
  const calls: ProbeCall[] = [];
  const request = ((method: string, params: unknown) => {
    const call = calls.length;
    // `at` is what lets a case assert WHEN a probe was issued rather than only
    // how many there were. A count sampled after the deadline cannot tell a
    // probe that started at 59,999 ms from one that started at exactly 60,000.
    calls.push({ method, params, at: Date.now() });
    return respond(call);
  }) as HostRequester<HostRpcRegistry>["request"];
  return { client: { request }, calls };
}

// `Error`, not `unknown`: the parameter was wider than anything this helper is
// given (its one caller passes a `HostRpcError`, which extends `Error`), and a
// rejection with a non-Error is what the lint forbids. Narrowing it costs no
// coverage - the poll's catch arm only distinguishes `HostRpcError` from
// everything else, and every "everything else" case a test could want is still
// an `Error`.
function throwingClient(error: Error): {
  readonly client: EpicExistenceClient;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  const request = (() => {
    calls.push(null);
    return Promise.reject(error);
  }) as HostRequester<HostRpcRegistry>["request"];
  return { client: { request }, calls };
}

/**
 * A poll plus a synchronously readable "has it answered yet".
 *
 * The budget cases below are about WHEN the poll settles, and `await
 * expect(promise).resolves` cannot express that: a poll that overruns simply
 * never settles, so the case dies of the runner's timeout instead of at the
 * assertion that states the claim. A flag can be asserted at an exact point on
 * the fake clock.
 */
function watchPoll(promise: Promise<EpicExistenceVerdict>): {
  readonly promise: Promise<EpicExistenceVerdict>;
  readonly settled: boolean;
} {
  const state = { settled: false };
  const watched = promise.then((verdict) => {
    state.settled = true;
    return verdict;
  });
  return {
    promise: watched,
    get settled(): boolean {
      return state.settled;
    },
  };
}

afterEach(() => {
  resetEpicExistencePollForTests();
  vi.useRealTimers();
});

describe("pollEpicExistence", () => {
  it("resolves 'exists' as soon as the host reports found, with no further probe", async () => {
    const { client, calls } = fakeClient(() =>
      Promise.resolve({ tasks: { [EPIC]: { status: "found", task: {} } } }),
    );

    const verdict = await pollEpicExistence({
      client,
      hostId: HOST,
      epicId: EPIC,
    });

    expect(verdict).toBe("exists");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "epic.getTaskContexts",
      params: { taskIds: [EPIC] },
    });
  });

  it("does not end the poll on a confirmed-absent reading; a later found still wins", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient((call) =>
      Promise.resolve({
        tasks: {
          [EPIC]:
            call === 0
              ? { status: "confirmed-absent" }
              : { status: "found", task: {} },
        },
      }),
    );

    const promise = pollEpicExistence({ client, hostId: HOST, epicId: EPIC });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);

    await expect(promise).resolves.toBe("exists");
  });

  it("answers 'absent' once the budget is spent with only confirmed-absent readings, and not one tick later", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(() =>
      Promise.resolve({ tasks: { [EPIC]: { status: "confirmed-absent" } } }),
    );

    const poll = watchPoll(
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
    );
    // EXACTLY the budget, not the budget plus slack. Advancing past it was what
    // let the unclamped backoff hide: the schedule's last sleep started at 55s
    // and ran a full 8, so the poll answered at 63s and an 80s window called
    // that a pass.
    await vi.advanceTimersByTimeAsync(EPIC_EXISTENCE_POLL_BUDGET_MS);

    // Asked as a FLAG before it is awaited: a poll that overran its budget
    // would leave `await expect(promise)` hanging until the test timed out,
    // which is a red that names no line and no claim.
    expect(poll.settled).toBe(true);
    await expect(poll.promise).resolves.toBe("absent");
  });

  it("issues no probe once the budget is spent", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const { client, calls } = fakeClient(() =>
      Promise.resolve({ tasks: { [EPIC]: { status: "confirmed-absent" } } }),
    );

    const poll = watchPoll(
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
    );
    // Sampled one tick SHORT of the deadline, which is the whole point. Taking
    // the baseline at 60,000 ms folds a probe issued at exactly the deadline
    // into it, and the count then never moves - so dropping the pre-dispatch
    // guard (whose job is to refuse that eleventh probe) would read as a pass.
    await vi.advanceTimersByTimeAsync(EPIC_EXISTENCE_POLL_BUDGET_MS - 1);
    const beforeDeadline = calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.settled).toBe(true);
    // Nothing is still scheduled: a clamped sleep that ended AT the deadline
    // must not wake up and ask again.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(calls).toHaveLength(beforeDeadline);
    // The invariant stated directly rather than inferred from a count: every
    // probe STARTED inside the budget. A count can be preserved by two
    // compensating errors; a timestamp cannot.
    const deadline = started + EPIC_EXISTENCE_POLL_BUDGET_MS;
    expect(calls.every((call) => call.at < deadline)).toBe(true);
  });

  it("settles at the budget with a probe still in flight, rather than waiting out its RPC", async () => {
    vi.useFakeTimers();
    // The condition this module exists for is a host that stopped answering, so
    // the probe that asks about it is exactly the request liable to hang. With
    // the deadline checked only after the await, this poll's real bound was
    // "the budget plus one RPC timeout".
    const { client, calls } = fakeClient(
      () => new Promise<never>(() => undefined),
    );

    const poll = watchPoll(
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
    );

    await vi.advanceTimersByTimeAsync(EPIC_EXISTENCE_POLL_BUDGET_MS - 1);
    expect(poll.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(poll.settled).toBe(true);
    // `unknown`, not `absent`: the poll never got a reading at all.
    await expect(poll.promise).resolves.toBe("unknown");
    // One probe, still unresolved. The verdict came from the clock.
    expect(calls).toHaveLength(1);
  });

  it("stops immediately at a non-transient HostRpcError, answering 'unknown' after exactly one probe", async () => {
    const { client, calls } = throwingClient(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "old host",
        requestId: "r1",
        method: "epic.getTaskContexts",
        fatalDetails: null,
      }),
    );

    const verdict = await pollEpicExistence({
      client,
      hostId: HOST,
      epicId: EPIC,
    });

    expect(verdict).toBe("unknown");
    expect(calls).toHaveLength(1);
  });

  it("shares one in-flight poll across two concurrent callers for the same host+epic", async () => {
    let requestCount = 0;
    const { client } = fakeClient(() => {
      requestCount += 1;
      return Promise.resolve({
        tasks: { [EPIC]: { status: "found", task: {} } },
      });
    });

    const [first, second] = await Promise.all([
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
    ]);

    expect(first).toBe("exists");
    expect(second).toBe("exists");
    expect(requestCount).toBe(1);
  });

  it("client: null answers 'unknown' and registers no poll for a later caller to join", async () => {
    const verdict = await pollEpicExistence({
      client: null,
      hostId: HOST,
      epicId: EPIC,
    });
    expect(verdict).toBe("unknown");

    // The second half is the part that is not vacuous. Counting requests on a
    // client the poll was never GIVEN proves nothing - there is no way for it
    // to have made one. What is worth pinning is that the early answer left no
    // entry in `pollsInFlight`: a later caller that does have a client must
    // reach the host, not join a poll that already gave up and inherit its
    // `unknown`.
    const { client, calls } = fakeClient(() =>
      Promise.resolve({ tasks: { [EPIC]: { status: "found", task: {} } } }),
    );

    await expect(
      pollEpicExistence({ client, hostId: HOST, epicId: EPIC }),
    ).resolves.toBe("exists");
    expect(calls).toHaveLength(1);
  });

  it("hostId: null answers 'unknown' with no request", async () => {
    const { client, calls } = fakeClient(() =>
      Promise.resolve({ tasks: { [EPIC]: { status: "found", task: {} } } }),
    );

    const verdict = await pollEpicExistence({
      client,
      hostId: null,
      epicId: EPIC,
    });

    expect(verdict).toBe("unknown");
    expect(calls).toHaveLength(0);
  });
});

describe("createOutcomeIsDecidable", () => {
  it("is true for an ambiguous post-send drop (HostTransportFailureError, fatalDetails: null)", () => {
    const error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "WebSocket closed before next frame",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(createOutcomeIsDecidable(error)).toBe(true);
  });

  it("is true for the host's idempotency key-reuse conflict message", () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "The idempotency key was already used with different params",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(createOutcomeIsDecidable(error)).toBe(true);
  });

  // The three cases below carry the host's OWN sentences verbatim
  // (`idempotency-cache.ts`), none of which contains the key-reuse fragment.
  // So each one exercises the code arm specifically: were
  // `DECIDABLE_IDEMPOTENCY_CODES` emptied, the first two would go red rather
  // than fall through to the prose match and pass for the wrong reason.
  it("is true for E_IDEMPOTENCY_OUTCOME_UNKNOWN - the host cannot promise an answer", () => {
    const error = new HostRpcError({
      code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
      message:
        "The original keyed request is still unresolved; its outcome is unknown and it will not be re-executed",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(error.message.toLowerCase()).not.toContain(
      "idempotency key was already used",
    );
    expect(createOutcomeIsDecidable(error)).toBe(true);
  });

  it("is true for E_IDEMPOTENCY_REPLAY_TOO_LARGE - the create SETTLED, only its response was dropped", () => {
    const error = new HostRpcError({
      code: "E_IDEMPOTENCY_REPLAY_TOO_LARGE",
      message:
        "The original keyed request completed, but its response exceeded the host's replay retention ceiling and was not kept; it will not be re-executed",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(error.message.toLowerCase()).not.toContain(
      "idempotency key was already used",
    );
    expect(createOutcomeIsDecidable(error)).toBe(true);
  });

  it("is false for E_IDEMPOTENCY_CACHE_SATURATED - the host guarantees the command did not run", () => {
    const error = new HostRpcError({
      code: "E_IDEMPOTENCY_CACHE_SATURATED",
      message: "The host idempotency cache is temporarily saturated",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(createOutcomeIsDecidable(error)).toBe(false);
  });

  it("is false for a RetryableTransportError - it carries the no-dispatch guarantee", () => {
    const error = new RetryableTransportError({
      code: "RPC_ERROR",
      message: "Dial failed before the request was sent",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
      replaySafetyFromKey: false,
    });
    expect(createOutcomeIsDecidable(error)).toBe(false);
  });

  it("is false for a HostRequestAbortedError - a caller-owned cancellation", () => {
    const error = new HostRequestAbortedError({
      message: "aborted",
      requestId: "r1",
      method: "epic.create",
    });
    expect(createOutcomeIsDecidable(error)).toBe(false);
  });

  it("is false for a plain HostRpcError with no ambiguity and no key-reuse prose", () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "host refused",
      requestId: "r1",
      method: "epic.create",
      fatalDetails: null,
    });
    expect(createOutcomeIsDecidable(error)).toBe(false);
  });
});
