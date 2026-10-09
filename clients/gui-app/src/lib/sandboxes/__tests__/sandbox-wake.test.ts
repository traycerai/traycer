import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type {
  SandboxListFetchResult,
  SandboxVerbFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const HOST_ID = "host-sbx-1";
/** The wake's whole budget: the timeout its first lifecycle request is given. */
const WAKE_BUDGET_MS = 120_000;

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { warning: mocks.toastWarning, error: mocks.toastError },
}));
vi.mock("@/lib/host/runtime", () => ({
  getHostBindingSnapshot: () => mocks.binding,
}));
// The app-wide client the pick reads, free of the app's persistence and
// devtools wiring.
vi.mock("@/lib/query-client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    }),
  };
});

import { queryClient } from "@/lib/query-client";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import { useAuthStore } from "@/stores/auth/auth-store";

function sandboxOption(
  state: HostSandboxState,
  frozen: boolean,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: HOST_ID,
    kind: "sandbox",
    connectable: false,
    sandbox: {
      state,
      frozen,
      summary: sandboxSummaryFixture({ id: "sbx_1", hostId: HOST_ID, state }),
    },
  });
}

function listOf(row: Partial<SandboxSummary>) {
  return () =>
    Promise.resolve({
      kind: "ok" as const,
      response: {
        sandboxes: [
          sandboxSummaryFixture({ id: "sbx_1", hostId: HOST_ID, ...row }),
        ],
      },
    });
}

/**
 * Scripts the list: the row reads `asleep` until a verb has been sent, and
 * `awake` after, so the wake's poll lands on the first re-read.
 */
function scriptListUntilVerb(
  binding: FakeSandboxBinding,
  asleep: HostSandboxState,
): void {
  binding.auth.listSandboxes.mockImplementation(() =>
    listOf({
      state:
        binding.auth.runSandboxVerb.mock.calls.length > 0 ? "awake" : asleep,
    })(),
  );
}

/** Lets a wake's unscheduled awaits settle, runs its poll sleep, and lets the rest settle. */
async function settleWake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * A lifecycle request that stays pending until the timeout it was passed has
 * elapsed, plus `lateMs`, then answers a network error: the abort the fetch
 * layer makes at that timeout (`lateMs` is how long after it the abort lands).
 */
function hangVerbUntilItsTimeout(
  binding: FakeSandboxBinding,
  lateMs: number,
): void {
  binding.auth.runSandboxVerb.mockImplementation(
    (_sandboxId, _verb, timeoutMs) =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              kind: "network-error",
              detail: "the request timed out",
            }),
          timeoutMs + lateMs,
        );
      }),
  );
}

function wakeMutations(): number {
  return queryClient.isMutating({
    mutationKey: sandboxMutationKeys.wake(HOST_ID),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.binding = createFakeSandboxBinding();
  mocks.toastWarning.mockClear();
  mocks.toastError.mockClear();
});
afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

describe("wakeSandboxOnPick", () => {
  it("reads the list, then resumes a suspended sandbox and starts a stopped one", async () => {
    for (const [state, verb] of [
      ["suspended", "resume"],
      ["stopped", "start"],
    ] as const) {
      const binding = createFakeSandboxBinding();
      mocks.binding = binding;
      scriptListUntilVerb(binding, state);

      wakeSandboxOnPick(sandboxOption(state, false));
      await settleWake();

      expect(binding.auth.listSandboxes).toHaveBeenCalled();
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        verb,
        WAKE_BUDGET_MS,
      );
      // A woken host dials the moment the directory says so.
      expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.toastWarning).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
    }
  });

  it("resumes once for two picks of one host while the first wake is in flight, and toasts the outcome once", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    binding.auth.runSandboxVerb.mockResolvedValue(
      refusal(402, "insufficient_credit"),
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "Not enough credits to wake this sandbox",
      expect.anything(),
    );
    // Only the starter refreshed the directory.
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
  });

  it("names the credit shortfall rounded up, and none when the gate sent none", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    binding.auth.runSandboxVerb.mockResolvedValueOnce({
      ...refusal(402, "insufficient_credit"),
      shortfallMc: 10_100,
    });

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();
    expect(mocks.toastWarning).toHaveBeenLastCalledWith(
      "Not enough credits to wake this sandbox",
      { description: "Add 11 credits, then try again." },
    );

    binding.auth.runSandboxVerb.mockResolvedValueOnce(
      refusal(402, "insufficient_credit"),
    );
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();
    expect(mocks.toastWarning).toHaveBeenLastCalledWith(
      "Not enough credits to wake this sandbox",
      { description: "Add credits, then try again." },
    );
  });

  it("starts a fresh wake for a pick made after the last one settled", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    binding.auth.runSandboxVerb.mockResolvedValue(
      refusal(402, "insufficient_credit"),
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(2);
    expect(mocks.toastWarning).toHaveBeenCalledTimes(2);
  });

  it("leaves a frozen sandbox, an awake one and a personal host alone", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;

    wakeSandboxOnPick(sandboxOption("suspended", true));
    wakeSandboxOnPick(sandboxOption("awake", false));
    wakeSandboxOnPick(hostScopeOptionFixture({ hostId: HOST_ID }));
    await settleWake();

    expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    expect(binding.directory.refresh).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(wakeMutations()).toBe(0);
  });

  it("reports a failed first list read as a failure to retry, never as a sandbox that no longer exists", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockResolvedValue({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
    // Not-wakeable's "It no longer exists." is a warning.
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("does nothing, and says nothing, for a wake with no host binding", async () => {
    mocks.binding = null;

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // Synchronous: no mutation was ever created.
    expect(wakeMutations()).toBe(0);
    await settleWake();

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: sandboxMutationKeys.wake(HOST_ID) }),
    ).toEqual([]);
  });

  it("runs under the host's wake mutation key while it is under way, so a tile can show Resuming", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    scriptListUntilVerb(binding, "suspended");
    expect(wakeMutations()).toBe(0);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // Past the first reads, parked on the poll sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(wakeMutations()).toBeGreaterThan(0);

    await settleWake();
    expect(wakeMutations()).toBe(0);
  });

  it("lets the cache collect the wake's mutation once it settles, because nothing observes it any more", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    scriptListUntilVerb(binding, "suspended");
    const findWakes = () =>
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: sandboxMutationKeys.wake(HOST_ID) });

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    const settled = findWakes();
    expect(settled).toHaveLength(1);
    expect(settled[0].state.status).toBe("success");

    // A mutation's observer list is private, so the unsubscribe is read
    // through what it causes: the cache removes a settled mutation only once
    // no observer is left, after its gc window.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(findWakes()).toEqual([]);
  });

  it("fails a wake whose lifecycle verb never answers once the 120 s budget is spent, then lets the next pick start afresh", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    // The verb's own request outlives the whole budget, and is aborted at it.
    hangVerbUntilItsTimeout(binding, 0);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // A second pick while it is pending joins it: one verb, one outcome.
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(wakeMutations()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
    expect(wakeMutations()).toBe(0);

    // The timed-out wake, its request aborted, no longer holds the host: a new
    // pick sends a verb.
    scriptListUntilVerb(binding, "suspended");
    binding.auth.runSandboxVerb.mockReset();
    binding.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: true,
    });
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("leaves no budget timer running once a wake has its answer", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    scriptListUntilVerb(binding, "suspended");

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();
    // The one timer left is the mutation cache's own gc timer for the settled
    // wake; an uncancelled 120 s budget would make it two.
    expect(vi.getTimerCount()).toBe(1);
    // Past the cache's gc window that one is gone too.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("toasts why and sends nothing when the build cannot reach the sandbox control plane", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.sandboxControlUnavailableReason.mockReturnValue(
      "Sandboxes aren't available in the staging build.",
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // Synchronous: no mutation was ever created.
    expect(wakeMutations()).toBe(0);
    await settleWake();

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "Couldn't wake this sandbox",
      { description: "Sandboxes aren't available in the staging build." },
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    expect(binding.directory.refresh).not.toHaveBeenCalled();
  });
});

describe("wakeSandboxOnPick when the lifecycle request hangs", () => {
  // A wake still pending when a test ends would hold its host in the module's
  // in-flight map and be joined by the next test's pick: run every clock out.
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(300_000);
  });

  function hungHost(lateMs: number): FakeSandboxBinding {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    hangVerbUntilItsTimeout(binding, lateMs);
    return binding;
  }

  it("answers timed out at 120 s, and the request was handed that same 120 s to live", async () => {
    const binding = hungHost(0);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "resume",
      120_000,
    );

    await vi.advanceTimersByTimeAsync(119_999);
    expect(mocks.toastError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
  });

  it("joins a retry made before the timeout: one request, whatever the wake has waited", async () => {
    const binding = hungHost(0);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);

    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("joins a retry made after the wake timed out but before its request settled: still one request", async () => {
    // The abort lands 5 s after the budget is spent.
    const binding = hungHost(5_000);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // Past the first reads, so the budget starts at t = 0.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(mocks.toastError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(wakeMutations()).toBe(0);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);

    // Nothing is sent into the first request's transition.
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh wake for a retry made once the request has settled, with a full budget again", async () => {
    const binding = hungHost(5_000);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // Past the first reads, so the budget starts at t = 0.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);

    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(2);
    expect(binding.auth.runSandboxVerb).toHaveBeenNthCalledWith(
      2,
      "sbx_1",
      "resume",
      120_000,
    );
  });
});

// A wake can outlive a sign-out and a sign-in as someone else. It then stops
// reading the list under the new account's bearer, and reports and refreshes
// nothing: its outcome belongs to the account that started it.
describe("wakeSandboxOnPick across accounts", () => {
  const REGISTERED_HOSTS_KEY = ["auth", "registered-hosts"];

  interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function signInAs(userId: string): void {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
  }

  let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

  beforeEach(() => {
    invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    signInAs("user-a");
  });
  afterEach(async () => {
    // Runs any wake still polling out to its end, so none leaks into the next
    // test through the module-level map of wakes in flight.
    await vi.advanceTimersByTimeAsync(300_000);
    invalidate.mockRestore();
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });

  function expectNothingReported(binding: FakeSandboxBinding): void {
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(binding.directory.refresh).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  }

  it("started as A, stops reading the list once B is signed in, and reports nothing", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    // The first read and the verb are done; the wake is waiting to poll.
    await vi.advanceTimersByTimeAsync(0);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);

    signInAs("user-b");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);
    expectNothingReported(binding);
    expect(wakeMutations()).toBe(0);
  });

  it("started as A, does not call the sandbox gone when B signs in during a poll whose answer lacks the row", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    const poll = deferred<SandboxListFetchResult>();
    binding.auth.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementationOnce(() => poll.promise);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    // The verb was sent and the poll is in flight.
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);

    signInAs("user-b");
    poll.resolve({ kind: "ok", response: { sandboxes: [] } });
    await vi.advanceTimersByTimeAsync(0);

    expectNothingReported(binding);
    expect(wakeMutations()).toBe(0);
  });

  it("started as A, toasts no credit shortfall when B is signed in by the time the gate answers", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    const verb = deferred<SandboxVerbFetchResult>();
    binding.auth.runSandboxVerb.mockImplementation(() => verb.promise);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);

    signInAs("user-b");
    verb.resolve(refusal(402, "insufficient_credit"));
    await vi.advanceTimersByTimeAsync(0);

    expectNothingReported(binding);
    expect(wakeMutations()).toBe(0);
  });

  it("after a fenced wake, a pick under B for the same host starts fresh instead of joining it", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    // Asleep until the second verb: A's wake never gets to see it awake.
    binding.auth.listSandboxes.mockImplementation(() =>
      listOf({
        state:
          binding.auth.runSandboxVerb.mock.calls.length >= 2
            ? "awake"
            : "suspended",
      })(),
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    signInAs("user-b");
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(wakeMutations()).toBe(0);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);
    expectNothingReported(binding);

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);

    // It read the list again and sent its own verb, rather than awaiting the
    // fenced wake's outcome.
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    // B's wake is B's: it refreshes the directory, and A's did not.
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("a pick under B while A's wake is still polling starts B's own wake instead of joining A's, and A's fenced wake toasts nothing", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    const poll = deferred<SandboxListFetchResult>();
    binding.auth.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementationOnce(() => poll.promise)
      .mockImplementation(() =>
        listOf({
          state:
            binding.auth.runSandboxVerb.mock.calls.length >= 2
              ? "awake"
              : "suspended",
        })(),
      );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    // A's verb was sent and A's next list read is in flight.
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);

    signInAs("user-b");
    wakeSandboxOnPick(sandboxOption("suspended", false));
    await vi.advanceTimersByTimeAsync(0);

    // B's own attempt read the list and, the row being asleep, sent its own verb.
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(2);

    // A's read lands late; the fence ends A's wake without a word.
    poll.resolve({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx_1",
            hostId: HOST_ID,
            state: "suspended",
          }),
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    // Only B's wake refreshed.
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
    expect(wakeMutations()).toBe(0);
  });

  it("control: with the same account throughout, the outcome is toasted and the directory and host list are refreshed", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended" }),
    );
    binding.auth.runSandboxVerb.mockResolvedValue(
      refusal(402, "insufficient_credit"),
    );

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "Not enough credits to wake this sandbox",
      { description: "Add credits, then try again." },
    );
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REGISTERED_HOSTS_KEY });
  });

  it("control: with the same account throughout, a wake that finds the sandbox awake refreshes and says nothing", async () => {
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    scriptListUntilVerb(binding, "suspended");

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REGISTERED_HOSTS_KEY });
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
