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
 * The automatic-cleanup card's state ladder and its one write.
 *
 * The RPCs run for real against a `MockHostMessenger`, so the revision guard,
 * the bounds-driven validation and the conflict re-read all go through the
 * actual query/mutation path rather than a hook stub. Only the two per-host
 * FACTS the card cannot synthesize — reachability and whether this host
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

import { WorktreeAutoCleanupSection } from "@/components/settings/panels/worktree-auto-cleanup-section";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";

/**
 * The toggle renders immediately but stays DISABLED until the policy read
 * lands - the control must never write a revision it has not read. Tests that
 * press it therefore wait for the loaded state, not merely for the element.
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

function renderSection(
  client: HostClient<HostRpcRegistry> | null,
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <WorktreeAutoCleanupSection
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({ hostId: "host-a", name: "Host A" }),
          client,
        })}
        onOpenHistory={() => undefined}
      />
    </Wrapper>,
  );
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.supported = true;
});

afterEach(() => {
  cleanup();
});

describe("WorktreeAutoCleanupSection", () => {
  it("renders default-off controls on a supported host", async () => {
    renderSection(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
    );

    const toggle = await loadedCleanupToggle();
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    // Default-off says so in words, and the threshold control is not offered
    // for a policy that deletes nothing.
    screen.getByText(
      "Cleanup is off. Nothing is deleted automatically on this host.",
    );
    expect(
      screen.queryByRole("textbox", { name: "Custom inactivity days" }),
    ).toBeNull();
  });

  it("says the host is too old rather than offering a client-side fallback", () => {
    state.supported = false;

    renderSection(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
    );

    const notice = screen.getByTestId("worktree-auto-cleanup-notice");
    expect(notice.getAttribute("data-gate")).toBe("unsupported");
    expect(notice.textContent).toContain("Update the host to turn it on");
    // No controls at all: the affordance is withheld, not disabled.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("explains an offline host without claiming its version is the problem", () => {
    state.reachability = { status: "unreachable", hostLabel: "Host A" };

    renderSection(null);

    const notice = screen.getByTestId("worktree-auto-cleanup-notice");
    expect(notice.getAttribute("data-gate")).toBe("offline");
    expect(notice.textContent).toContain("Host A is offline");
    expect(notice.textContent).not.toContain("Update the host");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("explains a pause in plain English and offers no repair affordance", async () => {
    renderSection(
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
    );

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

  it("shows the history button only once automatic cleanup is on or has ever run", async () => {
    // Fresh host, never enabled, never evaluated: a history button would point
    // at an empty list, and the history is automatic runs only - manual
    // deletions never appear in it.
    const { unmount } = renderSection(
      clientWithPolicy({
        get: () => policyFixture({}),
        set: (r) => policyFixture(r),
      }),
    );
    await waitFor(() => {
      screen.getByRole("switch", { name: "Automatic cleanup" });
    });
    expect(
      screen.queryByRole("button", { name: /automatic cleanup history/i }),
    ).toBeNull();
    unmount();

    // Disabled AFTER it ran: the record of what was deleted must stay
    // reachable - turning the policy off is when someone comes looking.
    renderSection(
      clientWithPolicy({
        get: () => policyFixture({ enabled: false, lastEvaluatedAt: 1_000 }),
        set: (r) => policyFixture(r),
      }),
    );
    await waitFor(() => {
      screen.getByRole("button", { name: /automatic cleanup history/i });
    });
  });

  it("renders an upcoming check as a countdown, never as a past-tense label", async () => {
    renderSection(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 5 * 60_000,
            nextEvaluationAt: Date.now() + 10 * 60_000,
          }),
        set: (r) => policyFixture(r),
      }),
    );

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

  it("renders an overdue check as due now rather than counting down to zero", async () => {
    renderSection(
      clientWithPolicy({
        get: () =>
          policyFixture({
            enabled: true,
            lastEvaluatedAt: Date.now() - 60 * 60_000,
            nextEvaluationAt: Date.now() - 60_000,
          }),
        set: (r) => policyFixture(r),
      }),
    );

    await waitFor(() => {
      screen.getByTestId("worktree-auto-cleanup-schedule");
    });
    expect(
      screen.getByTestId("worktree-auto-cleanup-schedule").textContent,
    ).toContain("next check due now");
  });

  it("sends the current revision with a preset threshold change", async () => {
    const requests: Array<{
      readonly inactivityDays: number;
      readonly expectedRevision: number;
    }> = [];
    let policy = policyFixture({ enabled: true, revision: 3 });
    renderSection(
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
    );

    await waitFor(() => {
      screen.getByRole("button", { name: "7 days" });
    });
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    await waitFor(() => {
      expect(requests).toEqual([
        { enabled: true, inactivityDays: 7, expectedRevision: 3 },
      ]);
    });
    // The response is the fresh state, so the control re-presents it without a
    // second round trip.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "7 days" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });

  it("refuses a custom value outside the host's bounds without sending it", async () => {
    const requests: number[] = [];
    renderSection(
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
    );

    await waitFor(() => {
      screen.getByRole("textbox", { name: "Custom inactivity days" });
    });
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
    renderSection(
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
    );

    fireEvent.click(await loadedCleanupToggle());

    await waitFor(() => {
      screen.getByTestId("worktree-auto-cleanup-conflict");
    });
    expect(setCalls).toBe(1);
    // The re-read wins: the control now shows the state that actually landed.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "14 days" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });
});
