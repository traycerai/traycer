import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeAutoCleanupPolicyState } from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The automatic-cleanup CHIP's state ladder and its one write.
 *
 * Everything the card used to hold is now reached through the chip: the chip
 * itself states the policy, and the popover behind it carries the switch, the
 * threshold, the schedule and the way into history. So every assertion here
 * goes through those two surfaces rather than through a card that no longer
 * exists.
 *
 * The RPCs run for real against a `MockHostMessenger`, so the revision guard,
 * the bounds-driven validation and the conflict re-read all go through the
 * actual query/mutation path rather than a hook stub. Only the two per-host
 * FACTS the chip cannot synthesize — reachability and whether this host
 * advertised the capability — are mocked.
 */
const state = vi.hoisted(() => ({
  reachability: { status: "reachable", hostLabel: "Host A" },
  supported: true as boolean | null,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.supported,
  useHostSupportsMethod: () => state.supported === true,
  useHostMethodSchemaVersion: () => null,
}));

import { WorktreeAutoCleanupChip } from "@/components/settings/panels/worktree-auto-cleanup-chip";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";

function chip(): HTMLElement {
  return screen.getByTestId("worktree-auto-cleanup-chip");
}

/**
 * Opens the popover the way a user does. Every control except the chip's own
 * summary lives behind it, so a test that touches one opens it first - which
 * is also the assertion that the chip is the only way in.
 */
async function openPopover(): Promise<void> {
  fireEvent.click(chip());
  await screen.findByTestId("worktree-auto-cleanup-popover");
}

/**
 * The toggle renders as soon as the popover does but stays DISABLED until the
 * policy read lands - the control must never write a revision it has not read.
 * Tests that press it therefore wait for the loaded state, not merely for the
 * element.
 */
async function loadedCleanupToggle(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(
      screen
        .getByRole("switch", { name: "Automatic cleanup" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  return screen.getByRole("switch", { name: "Automatic cleanup" });
}

function policyFixture(
  overrides: Partial<WorktreeAutoCleanupPolicyState>,
): WorktreeAutoCleanupPolicyState {
  return {
    enabled: false,
    inactivityDays: 30,
    revision: 0,
    updatedAt: null,
    updatedByUserId: null,
    lastEvaluatedAt: null,
    nextEvaluationAt: null,
    pausedReason: null,
    bounds: { minDays: 1, maxDays: 365 },
    ...overrides,
  };
}

interface PolicyHandlers {
  readonly get: () => WorktreeAutoCleanupPolicyState;
  readonly set: (request: {
    readonly enabled: boolean;
    readonly inactivityDays: number;
    readonly expectedRevision: number;
  }) => WorktreeAutoCleanupPolicyState;
}

function clientWithPolicy(
  handlers: PolicyHandlers,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "worktree.getAutoCleanupPolicy": () => handlers.get(),
        "worktree.setAutoCleanupPolicy": (request) => handlers.set(request),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

const HOST_A = { hostId: "host-a", name: "Host A" };
const HOST_B = { hostId: "host-b", name: "Host B" };

function chipForHost(
  client: HostClient<HostRpcRegistry> | null,
  host: { readonly hostId: string; readonly name: string },
  onOpenHistory: () => void,
): ReactNode {
  return (
    <WorktreeAutoCleanupChip
      scope={hostScopeFixture({
        host: hostScopeOptionFixture(host),
        client,
      })}
      onOpenHistory={onOpenHistory}
    />
  );
}

function renderChip(
  client: HostClient<HostRpcRegistry> | null,
  onOpenHistory: () => void,
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(chipForHost(client, HOST_A, onOpenHistory), {
    wrapper: Wrapper,
  });
}

function noop(): void {
  return undefined;
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.supported = true;
  useWorktreeCleanupViewStore.setState({
    view: "settings",
    focusedRunId: null,
    autoCleanupFocusHostId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorktreeAutoCleanupChip", () => {
  it("states an off policy in the toolbar without opening anything", async () => {
    renderChip(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup off");
    });
    expect(
      screen
        .getByTestId("worktree-auto-cleanup-chip-dot")
        .getAttribute("data-tone"),
    ).toBe("off");
    // The chip is a summary, not the editor: nothing is mounted until it is
    // pressed.
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("states an enabled policy and its threshold in the chip itself", async () => {
    renderChip(
      clientWithPolicy({
        get: () => policyFixture({ enabled: true, inactivityDays: 7 }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup · On · 7d");
    });
    expect(
      screen
        .getByTestId("worktree-auto-cleanup-chip-dot")
        .getAttribute("data-tone"),
    ).toBe("on");
  });

  it("claims no policy state until the read lands", () => {
    // Asserted on the FIRST paint, before the read resolves: the chip must not
    // paint "off" - which is a real policy - for a policy it has not been told
    // yet.
    renderChip(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    expect(chip().textContent).toBe("Cleanup");
    expect(screen.queryByTestId("worktree-auto-cleanup-chip-dot")).toBeNull();
  });

  it("says the host is too old in a tooltip rather than offering controls", async () => {
    state.supported = false;

    renderChip(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    expect(chip().getAttribute("data-gate")).toBe("unsupported");
    expect(chip().getAttribute("aria-disabled")).toBe("true");
    fireEvent.pointerMove(chip());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Update the host to turn it on");

    // Inert: pressing it opens nothing, so no control is offered for a host
    // that cannot run cleanup at all.
    fireEvent.click(chip());
    expect(screen.queryByTestId("worktree-auto-cleanup-popover")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("explains an offline host without claiming its version is the problem", async () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };

    renderChip(null, noop);

    expect(chip().getAttribute("data-gate")).toBe("offline");
    fireEvent.pointerMove(chip());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Host A is offline");
    expect(tooltip.textContent).not.toContain("Update the host");
    fireEvent.click(chip());
    expect(screen.queryByTestId("worktree-auto-cleanup-popover")).toBeNull();
  });

  it("renders nothing at all without a resolved host", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider delayDuration={0}>
          <WorktreeAutoCleanupChip
            scope={hostScopeFixture({ host: null, client: null })}
            onOpenHistory={noop}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // The inventory's own `HostScopeGate` names that state; a second copy of
    // it in the toolbar would be two answers to one question.
    expect(container.querySelector("[data-testid]")).toBeNull();
  });

  it("toggles the policy from the popover, sending the revision it read", async () => {
    const requests: boolean[] = [];
    let policy = policyFixture({ enabled: true, revision: 4 });
    renderChip(
      clientWithPolicy({
        get: () => policy,
        set: (request) => {
          requests.push(request.enabled);
          policy = policyFixture({
            ...request,
            revision: request.expectedRevision + 1,
          });
          return policy;
        },
      }),
      noop,
    );

    await openPopover();
    fireEvent.click(await loadedCleanupToggle());

    await waitFor(() => {
      expect(requests).toEqual([false]);
    });
    // The popover survives its own switch: turning cleanup off is not a reason
    // to close the surface the user is still reading.
    screen.getByTestId("worktree-auto-cleanup-popover");
    await waitFor(() => {
      screen.getByText("Nothing is deleted automatically.");
    });
    // Off has nothing to configure, so the threshold and the schedule are gone
    // rather than disabled over an inert setting.
    expect(
      screen.queryByRole("textbox", { name: "Custom inactivity days" }),
    ).toBeNull();
    expect(screen.queryByTestId("worktree-auto-cleanup-schedule")).toBeNull();
    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup off");
    });
  });

  it("sends the current revision with a preset threshold change", async () => {
    const requests: Array<{
      readonly inactivityDays: number;
      readonly expectedRevision: number;
    }> = [];
    let policy = policyFixture({ enabled: true, revision: 3 });
    renderChip(
      clientWithPolicy({
        get: () => policy,
        set: (request) => {
          requests.push(request);
          policy = policyFixture({
            ...request,
            revision: request.expectedRevision + 1,
          });
          return policy;
        },
      }),
      noop,
    );

    await openPopover();
    await loadedCleanupToggle();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    await waitFor(() => {
      expect(requests).toEqual([
        { enabled: true, inactivityDays: 7, expectedRevision: 3 },
      ]);
    });
    // The response is the fresh state, so the control re-presents it without a
    // second round trip - and the chip agrees with it.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "7 days" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup · On · 7d");
    });
  });

  it("offers only the presets inside the host's bounds", async () => {
    const requests: number[] = [];
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            inactivityDays: 30,
            bounds: { minDays: 30, maxDays: 60 },
          }),
        set: (request) => {
          requests.push(request.inactivityDays);
          return policyFixture(request);
        },
      }),
      noop,
    );

    await openPopover();
    await loadedCleanupToggle();
    // Only the two presets inside [30, 60] are offered - a preset the host
    // would refuse is not shown as a button at all.
    screen.getByRole("button", { name: "30 days" });
    screen.getByRole("button", { name: "60 days" });
    for (const days of [7, 14, 90]) {
      expect(screen.queryByRole("button", { name: `${days} days` })).toBeNull();
    }

    // The custom input validates against the same bounds.
    const input = screen.getByRole("textbox", {
      name: "Custom inactivity days",
    });
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    await waitFor(() => {
      screen.getByText("Choose between 30 and 60 days.");
    });
    expect(requests).toEqual([]);
    // The refusal is announced to the field, not merely printed beside it.
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Choose between 30 and 60 days.",
    );

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(requests).toEqual([45]);
    });
  });

  it("refuses a custom value outside the host's bounds without sending it", async () => {
    const requests: number[] = [];
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            bounds: { minDays: 1, maxDays: 365 },
          }),
        set: (request) => {
          requests.push(request.inactivityDays);
          return policyFixture(request);
        },
      }),
      noop,
    );

    await openPopover();
    await loadedCleanupToggle();
    const input = screen.getByRole("textbox", {
      name: "Custom inactivity days",
    });
    fireEvent.change(input, { target: { value: "400" } });
    fireEvent.blur(input);

    await waitFor(() => {
      screen.getByText("Choose between 1 and 365 days.");
    });
    expect(requests).toEqual([]);

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(requests).toEqual([45]);
    });
  });

  it("re-reads and explains a revision conflict instead of retrying blind", async () => {
    let policy = policyFixture({ enabled: false, revision: 1 });
    let setCalls = 0;
    renderChip(
      clientWithPolicy({
        get: () => policy,
        set: () => {
          setCalls += 1;
          // Another surface moved the policy on underneath this client.
          policy = policyFixture({
            enabled: true,
            inactivityDays: 14,
            revision: 2,
          });
          throw new HostRpcError({
            code: "AUTO_CLEANUP_POLICY_REVISION_CONFLICT",
            message: "Policy revision conflict",
            requestId: "req-conflict",
            method: "worktree.setAutoCleanupPolicy",
            fatalDetails: null,
          });
        },
      }),
      noop,
    );

    await openPopover();
    fireEvent.click(await loadedCleanupToggle());

    await waitFor(() => {
      screen.getByTestId("worktree-auto-cleanup-conflict");
    });
    expect(setCalls).toBe(1);
    // The re-read wins: the chip states what actually landed, and the controls
    // behind it agree.
    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup · On · 14d");
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "14 days" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });

  it("surfaces a failed policy read inside the popover, chip still usable", async () => {
    renderChip(
      clientWithPolicy({
        get: () => {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "Could not read the cleanup policy.",
            requestId: "req-read",
            method: "worktree.getAutoCleanupPolicy",
            fatalDetails: null,
          });
        },
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    // A read that failed is not a host that cannot do this: the chip stays
    // live, and the failure is explained where the controls would have been.
    expect(chip().getAttribute("aria-disabled")).toBeNull();
    await openPopover();
    await screen.findByText("Could not read the cleanup policy.");
    expect(
      screen
        .getByRole("switch", { name: "Automatic cleanup" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("explains a pause in plain English and offers no repair affordance", async () => {
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            pausedReason: "needs_reauth",
            lastEvaluatedAt: 1_000,
            nextEvaluationAt: null,
          }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await openPopover();
    await waitFor(() => {
      screen.getByTestId("worktree-auto-cleanup-paused");
    });
    const paused = screen.getByTestId("worktree-auto-cleanup-paused");
    expect(paused.textContent).toContain("needs to be re-authorized");
    expect(paused.textContent).toContain("resumes on its own");
    // A `null` next check while paused is a real state, not an unknown one.
    expect(
      screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
    ).toContain("Next check: paused");
    // Nothing to press: every pause arm clears without the user acting.
    expect(screen.queryByRole("button", { name: /re-?authorize/i })).toBeNull();
  });

  it("shows History only while cleanup is on, and closes the popover on the way", async () => {
    // The history is automatic runs only - manual deletions never appear in
    // it - so with the policy off the link is hidden even when earlier runs
    // exist. A link beside "Cleanup off" read as the place manual deletions
    // should show up.
    const openHistory = vi.fn();
    const { unmount } = renderChip(
      clientWithPolicy({
        get: () => policyFixture({ enabled: false, lastEvaluatedAt: 1_000 }),
        set: (r) => policyFixture(r),
      }),
      openHistory,
    );
    await openPopover();
    await loadedCleanupToggle();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    unmount();

    renderChip(
      clientWithPolicy({
        get: () => policyFixture({ enabled: true }),
        set: (r) => policyFixture(r),
      }),
      openHistory,
    );
    await openPopover();
    const history = await screen.findByRole("button", { name: "History" });
    fireEvent.click(history);

    expect(openHistory).toHaveBeenCalledTimes(1);
    // History is the full-panel view, so the popover it was reached from gets
    // out of the way rather than floating over the sub-view it opened.
    await waitFor(() => {
      expect(screen.queryByTestId("worktree-auto-cleanup-popover")).toBeNull();
    });
  });

  it("renders an upcoming check as a countdown, never as a past-tense label", async () => {
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 5 * 60_000,
            nextEvaluationAt: Date.now() + 10 * 60_000,
          }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await openPopover();
    await waitFor(() => {
      screen.getByTestId("worktree-auto-cleanup-schedule");
    });
    const schedule = screen.getByTestId("worktree-auto-cleanup-schedule");
    // The regression this pins: `useRelativeTimestamp` clamps a negative
    // delta, so a check ~10m AWAY rendered as "Just now" - a past-tense claim
    // about an event that has not happened.
    expect(schedule.textContent).toMatch(/next check in \d+m/);
    expect(schedule.textContent).not.toContain("next check Just now");
    expect(schedule.textContent).toContain("Last checked");
  });

  it("renders a sub-minute check as under a minute rather than a seconds count", async () => {
    // The shared clock ticks once a minute, so a seconds count would sit
    // frozen past its own deadline. The phrase stays true for the whole tick.
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 5 * 60_000,
            nextEvaluationAt: Date.now() + 30_000,
          }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await openPopover();
    await waitFor(() => {
      expect(
        screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
      ).toContain("next check in under a minute");
    });
  });

  it("flips to due now at the deadline without waiting for the next clock tick", async () => {
    // The shared clock samples once a minute; a deadline landing between two
    // samples must not leave "in under a minute" on screen past itself.
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 5 * 60_000,
            nextEvaluationAt: Date.now() + 700,
          }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await openPopover();
    await waitFor(() => {
      expect(
        screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
      ).toContain("next check in under a minute");
    });
    await waitFor(
      () => {
        expect(
          screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
        ).toContain("next check due now");
      },
      { timeout: 3_000 },
    );
  });

  it("renders an overdue check as due now rather than counting down to zero", async () => {
    renderChip(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 60 * 60_000,
            nextEvaluationAt: Date.now() - 60_000,
          }),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await openPopover();
    await waitFor(() => {
      expect(
        screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
      ).toContain("next check due now");
    });
  });

  it("opens itself for a deep link naming its host, then drops the request", async () => {
    // The Sweep dialog's discovery line leaves this one-shot request behind.
    // The popover is what the link promised, so it opens AND takes the caret -
    // and clears the request, or a later visit to Settings would re-open a
    // popover nobody asked about that time.
    useWorktreeCleanupViewStore.getState().requestAutoCleanupFocus("host-a");

    renderChip(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
      noop,
    );

    await screen.findByTestId("worktree-auto-cleanup-popover");
    const toggle = await loadedCleanupToggle();
    await waitFor(() => {
      expect(document.activeElement).toBe(toggle);
    });
    expect(
      useWorktreeCleanupViewStore.getState().autoCleanupFocusHostId,
    ).toBeNull();
  });

  it("leaves another host's focus request alone until that host is scoped", async () => {
    // The request outlives its destination whenever the named host never
    // mounts a chip - offline, too old, or Settings simply never opened. An
    // unscoped flag would then be spent on whichever host came next, opening
    // the policy for a machine nobody asked about.
    useWorktreeCleanupViewStore.getState().requestAutoCleanupFocus("host-b");
    const client = clientWithPolicy({
      get: () => policyFixture({}),
      set: (r) => policyFixture(r),
    });

    const { rerender } = renderChip(client, noop);

    await waitFor(() => {
      expect(chip().textContent).toBe("Cleanup off");
    });
    expect(screen.queryByTestId("worktree-auto-cleanup-popover")).toBeNull();
    // Untouched, so it is still there for the host it was actually about.
    expect(useWorktreeCleanupViewStore.getState().autoCleanupFocusHostId).toBe(
      "host-b",
    );

    rerender(chipForHost(client, HOST_B, noop));

    await screen.findByTestId("worktree-auto-cleanup-popover");
    expect(
      useWorktreeCleanupViewStore.getState().autoCleanupFocusHostId,
    ).toBeNull();
  });

  it("starts closed again when the scoped host changes in place", async () => {
    const client = clientWithPolicy({
      get: () => policyFixture({ enabled: true }),
      set: (r) => policyFixture(r),
    });
    const { rerender } = renderChip(client, noop);
    await openPopover();

    // The sidebar can switch straight from one usable host to another, which
    // keeps the chip at the same tree position and only swaps its scope. An
    // open popover must not follow it across that switch: the new host starts
    // closed like any first visit.
    rerender(chipForHost(client, HOST_B, noop));

    await waitFor(() => {
      expect(screen.queryByTestId("worktree-auto-cleanup-popover")).toBeNull();
    });
  });
});
