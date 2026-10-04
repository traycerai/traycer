// The "When you quit Traycer" card is reachable signed out, so the `none`
// option ("Don't run a host on this machine") is gated on shell admission
// alone. Signed out (not admitted per `useShellLocalPlaneAdmission`) a remote
// host cannot be reached either, so `none` would leave nothing usable: it is
// disabled with `HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON` unless it is already
// the desired mode. Remote hosts are available on every plan, so once the
// session is admitted the subscription never enters the decision: an unread
// status, FREE, PENDING and every paid tier all leave `none` selectable.
//
// Harness mirrors `host-lifecycle-settings-section.test.tsx`'s own
// `renderSection` / `view` / `buildLifecycleHost` / `radioDisabled` pattern —
// that file owns the rest of the card's suite, this one is scoped to the
// sign-in gate on `none`.
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
  HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON,
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
 * for `background` — never held by sign-in — to come off group disablement before
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

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "Test User",
      email: "user@example.invalid",
    },
    { userId: "user-1", username: "Test User" },
    [],
  );
}

describe("<HostLifecycleSettingsSection /> - the 'none' option and the sign-in gate", () => {
  it("signed out, desired background: 'none' is disabled, reasoned, and a click never calls set", async () => {
    useAuthStore.getState().setSignedOut();
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(true);
    expect(
      screen.getByTestId("host-lifecycle-none-signed-out-reason").textContent,
    ).toBe(HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON);

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
    expect(
      screen.queryByTestId("host-lifecycle-none-signed-out-reason"),
    ).toBeNull();
  });

  it("signed in, subscription not read yet: 'none' is enabled", async () => {
    signIn();
    useAuthStore.getState().setSubscriptionStatus(null);
    const fixture = buildLifecycleHost(view({}));
    renderSection(
      createFakeRunnerHost({ hostLifecycle: fixture.host, hasLocalHost: true }),
    );

    await waitForReady();
    expect(radioDisabled(NONE_OPTION_LABEL)).toBe(false);
    expect(
      screen.queryByTestId("host-lifecycle-none-signed-out-reason"),
    ).toBeNull();
  });

  it.each(["FREE", "PENDING", "PRO"] as const)(
    "signed in on %s: 'none' is enabled with no reason",
    async (status) => {
      signIn();
      useAuthStore.getState().setSubscriptionStatus(status);
      const fixture = buildLifecycleHost(view({}));
      renderSection(
        createFakeRunnerHost({
          hostLifecycle: fixture.host,
          hasLocalHost: true,
        }),
      );

      await waitForReady();
      expect(radioDisabled(NONE_OPTION_LABEL)).toBe(false);
      expect(
        screen.queryByTestId("host-lifecycle-none-signed-out-reason"),
      ).toBeNull();
    },
  );
});
