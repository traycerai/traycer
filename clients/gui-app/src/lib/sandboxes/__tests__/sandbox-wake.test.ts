import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const HOST_ID = "host-sbx-1";

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
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith("sbx_1", verb);
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
    expect(mocks.toastWarning.mock.calls[0][0]).toBe(
      "Not enough credits to wake this sandbox",
    );
    // Only the starter refreshed the directory.
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
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

  it("says a wake with no host binding failed rather than doing nothing", async () => {
    mocks.binding = null;

    wakeSandboxOnPick(sandboxOption("suspended", false));
    await settleWake();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError.mock.calls[0][0]).toBe(
      "Couldn't wake this sandbox",
    );
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
});
