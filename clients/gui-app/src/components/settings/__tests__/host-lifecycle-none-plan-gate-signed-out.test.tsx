// The "When you quit Traycer" card is reachable signed out, so the plan gate on
// its `none` option accounts for admission as well as the plan. Signed out
// (not admitted per `useShellLocalPlaneAdmission`) the plan is `null`, which
// alone would leave `none` enabled for a session that cannot use it; the gate
// disables `none` with its reason unless it is already the desired mode. An
// admitted session is unchanged: an unread plan does not block, a known
// unpaid plan blocks, a paid plan does not.
//
// Harness mirrors `host-lifecycle-settings-section.test.tsx`'s own
// `renderSection` / `view` / `buildLifecycleHost` / `radioDisabled` pattern —
// that file owns the rest of the card's suite, this one is scoped to the
// plan gate's admission half.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { HostLifecycleSettingsSection } from "@/components/settings/host-lifecycle-settings-section";
import {
  HOST_LIFECYCLE_NONE_PLAN_REASON,
  hostLifecycleOptionCopy,
  hostMachineNoun,
} from "@/lib/host/host-lifecycle-copy";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

const MACHINE = hostMachineNoun();
const OPTION_COPY = hostLifecycleOptionCopy(MACHINE);
const NONE_OPTION_LABEL = OPTION_COPY[4].label;

function view(overrides: Partial<HostLifecycleView>): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs: null,
    },
    pending: "none",
    ...overrides,
  };
}

interface LifecycleHostFixture {
  readonly host: IHostLifecycleHost;
  readonly setMock: Mock<
    (request: HostLifecycleSetRequest) => Promise<HostLifecycleSetResult>
  >;
}

function buildLifecycleHost(initial: HostLifecycleView): LifecycleHostFixture {
  const setMock = vi.fn((): Promise<HostLifecycleSetResult> =>
    Promise.resolve({ kind: "applied", view: initial }),
  );
  const host: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: setMock,
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
  return { host, setMock };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderSection(runnerHost: IRunnerHost): void {
  const tree: ReactNode = (
    <RunnerHostProvider runnerHost={runnerHost}>
      <HostLifecycleSettingsSection />
    </RunnerHostProvider>
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      {tree}
    </QueryClientProvider>,
  );
}

function radioDisabled(label: string): boolean {
  return screen.getByRole("radio", { name: label }).hasAttribute("disabled");
}

/**
 * Same reasoning as the sibling suite's `waitForReady`: the whole
 * `RadioGroup` is disabled until the mocked `get()` promise resolves, so wait
 * for `background` — never plan-gated — to come off group disablement before
 * reading the `none` row.
 */
async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(radioDisabled(OPTION_COPY[0].label)).toBe(false);
  });
}

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  useAuthStore.getState().setSubscriptionStatus(null);
});

describe("<HostLifecycleSettingsSection /> - the 'none' plan gate, signed out", () => {
  it("signed out, desired background: 'none' is disabled, reasoned, and a click never calls set", async () => {
    useAuthStore.getState().setSignedOut();
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(true);
    expect(
      screen.getByTestId("host-lifecycle-none-plan-reason").textContent,
    ).toBe(HOST_LIFECYCLE_NONE_PLAN_REASON);

    fireEvent.click(screen.getByRole("radio", { name: NONE_OPTION_LABEL }));
    expect(fixture.setMock).not.toHaveBeenCalled();
  });

  it("signed out, desired none: 'none' is enabled with no reason", async () => {
    useAuthStore.getState().setSignedOut();
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "none", rev: 1, updatedBy: null, updatedAt: null },
      }),
    );
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(false);
    expect(screen.queryByTestId("host-lifecycle-none-plan-reason")).toBeNull();
  });

  it("signed in, plan null (unread): 'none' is enabled", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "Test User",
        email: "user@example.invalid",
      },
      { userId: "user-1", username: "Test User" },
      [],
    );
    useAuthStore.getState().setSubscriptionStatus(null);
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(false);
    expect(screen.queryByTestId("host-lifecycle-none-plan-reason")).toBeNull();
  });

  it("signed in, known unpaid plan: 'none' is disabled with the reason", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "Test User",
        email: "user@example.invalid",
      },
      { userId: "user-1", username: "Test User" },
      [],
    );
    useAuthStore.getState().setSubscriptionStatus("FREE");
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(true);
    expect(
      screen.getByTestId("host-lifecycle-none-plan-reason").textContent,
    ).toBe(HOST_LIFECYCLE_NONE_PLAN_REASON);
  });

  it("signed in, paid plan: 'none' is enabled", async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "Test User",
        email: "user@example.invalid",
      },
      { userId: "user-1", username: "Test User" },
      [],
    );
    useAuthStore.getState().setSubscriptionStatus("PRO");
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(false);
    expect(screen.queryByTestId("host-lifecycle-none-plan-reason")).toBeNull();
  });
});
