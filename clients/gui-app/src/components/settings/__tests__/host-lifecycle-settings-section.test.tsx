// Same boundary as `local-host-restart-flow.test.tsx`: mock `@/lib/host`'s
// `useHostBinding` narrowly (spreading the real module so every other export
// stays intact), so the `→ none` confirm dialog's `NoneConfirmBody` can take
// its bound or unbound branch without standing up a real host runtime.
interface HostBindingFixture {
  readonly directory: { readonly getLocalEntry: () => null };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

// `useLocalHostQuitStatus` is the `→ none` confirm dialog's read-verdict
// source (`host-lifecycle-none-confirm-dialog.tsx` -> `BoundNoneConfirm`).
// Mocked at its own leaf, the same house pattern `local-host-restart-flow`'s
// suite uses for its own resolution hooks: this file is about the dialog's
// branching given a verdict, not about how the verdict is derived (that is
// `use-local-host-quit-status.test.ts`'s job).
const localHostQuitStatusMock = vi.hoisted(
  (): { current: LocalHostQuitStatus | null } => ({ current: null }),
);
vi.mock(
  "@/components/host/use-local-host-quit-status",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/host/use-local-host-quit-status")
      >();
    return {
      ...actual,
      useLocalHostQuitStatus: () => localHostQuitStatusMock.current,
    };
  },
);

// `HostRestartSessions` (mounted inside `HostQuitDialogView`, reachable from
// the confirm dialog's `sessionsHostId` slot) calls `useFocusModel()` ->
// `useConnectableHostIds()` -> ... -> `resolveSubtreeHostClient(binding,
// effectiveHostId)` against the SAME narrowly-mocked `@/lib/host` binding
// above, whose fixture carries no `hostClient` (this suite only ever needs
// `directory`). Mocked at its own leaf - same boundary as
// `local-host-restart-flow.test.tsx` uses for the identical dependency chain
// - rather than reconstructing the whole notification/auth/browser stack
// `useFocusModel` also reaches into.
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});

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
import { toast } from "sonner";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { LocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import { HostLifecycleSettingsSection } from "@/components/settings/host-lifecycle-settings-section";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  HOST_LIFECYCLE_NONE_PLAN_REASON,
  HOST_LIFECYCLE_PENDING_RESTART_APP,
  HOST_LIFECYCLE_PENDING_RESTART_HOST,
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  HOST_NONE_CONFIRM_STOP_LABEL,
  hostLifecycleOptionCopy,
  hostMachineNoun,
} from "@/lib/host/host-lifecycle-copy";
import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

const MACHINE = hostMachineNoun();
const OPTION_COPY = hostLifecycleOptionCopy(MACHINE);

function view(overrides: Partial<HostLifecycleView>): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: { localHostCapability: "managed", supervisor: "enforcing" },
    pending: "none",
    ...overrides,
  };
}

interface LifecycleHostFixture {
  readonly host: IHostLifecycleHost;
  readonly setMock: Mock<
    (request: HostLifecycleSetRequest) => Promise<HostLifecycleSetResult>
  >;
  readonly changeHandlers: Array<(view: HostLifecycleView) => void>;
  pushChange(next: HostLifecycleView): void;
}

function buildLifecycleHost(
  initial: HostLifecycleView,
  setImpl: (
    request: HostLifecycleSetRequest,
  ) => Promise<HostLifecycleSetResult>,
): LifecycleHostFixture {
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const setMock = vi.fn(setImpl);
  const host: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: setMock,
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  return {
    host,
    setMock,
    changeHandlers,
    pushChange(next) {
      for (const handler of changeHandlers) handler(next);
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderSection(runnerHost: IRunnerHost | null): void {
  const tree: ReactNode =
    runnerHost === null ? (
      <HostLifecycleSettingsSection />
    ) : (
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

function radioChecked(label: string): string | null {
  return screen
    .getByRole("radio", { name: label })
    .getAttribute("aria-checked");
}

function radioDisabled(label: string): boolean {
  return screen.getByRole("radio", { name: label }).hasAttribute("disabled");
}

/**
 * The card's `RadioGroup` is disabled wholesale (`view === undefined`) until
 * the mocked `IHostLifecycleHost.get()` promise resolves, so
 * `findByTestId("host-lifecycle-options")` alone - the element exists from
 * the first render - is not proof the card is ready to interact with. Wait
 * for `background`, the one option never plan-gated, to come off group
 * disablement instead.
 */
async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(radioDisabled(OPTION_COPY[0].label)).toBe(false);
  });
}

function idleVerdict(hostId: string): LocalHostQuitStatus {
  return {
    localHostId: hostId,
    verdict: {
      kind: "idle",
      busySessionCount: 0,
      breakdown: null,
      statusMinor: null,
    },
    liveLocalHostIdNow: () => hostId,
    recheck: () => undefined,
  };
}

function busyVerdict(hostId: string): LocalHostQuitStatus {
  return {
    localHostId: hostId,
    verdict: {
      kind: "busy",
      busySessionCount: 1,
      breakdown: null,
      statusMinor: null,
    },
    liveLocalHostIdNow: () => hostId,
    recheck: () => undefined,
  };
}

afterEach(() => {
  cleanup();
  hostBindingMock.current = null;
  localHostQuitStatusMock.current = null;
  setMobileApp(false);
  useAuthStore.getState().setSubscriptionStatus(null);
  vi.mocked(toast.info).mockClear();
  vi.restoreAllMocks();
});

describe("<HostLifecycleSettingsSection /> - options and selection", () => {
  it("renders all five radio options with their copy", async () => {
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    for (const option of OPTION_COPY) {
      const row = screen.getByTestId(`host-lifecycle-option-${option.mode}`);
      expect(row.textContent).toContain(option.label);
      expect(row.textContent).toContain(option.description);
    }
  });

  it("selects the radio matching the desired mode", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 1, updatedBy: null, updatedAt: null },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitFor(() => {
      expect(radioChecked(OPTION_COPY[3].label)).toBe("true");
    });
    expect(radioChecked(OPTION_COPY[0].label)).toBe("false");
  });

  it("choosing a different mode calls set({mode, stop: null}) and fires analytics on an applied result", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const applied = view({
      desired: { mode: "ask", rev: 2, updatedBy: null, updatedAt: null },
    });
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: applied }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[1].label }));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledWith({ mode: "ask", stop: null });
    });
    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(
        AnalyticsEvent.HostLifecycleModeSet,
        { mode: "ask", source: "settings" },
      );
    });
  });

  it.each(["stop-refused", "failed", "superseded"] as const)(
    "does NOT fire analytics on a %s result",
    async (kind) => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      const resultView = view({});
      const RESULTS: Record<
        "stop-refused" | "failed" | "superseded",
        HostLifecycleSetResult
      > = {
        "stop-refused": {
          kind: "stop-refused",
          reason: "host-busy",
          message: "busy",
          view: resultView,
        },
        failed: {
          kind: "failed",
          reason: "write-failed",
          message: "failed",
          view: resultView,
        },
        superseded: { kind: "superseded", view: resultView },
      };
      const result = RESULTS[kind];
      const fixture = buildLifecycleHost(view({}), () =>
        Promise.resolve(result),
      );
      renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

      await waitForReady();
      fireEvent.click(
        screen.getByRole("radio", { name: OPTION_COPY[1].label }),
      );

      await waitFor(() => {
        expect(fixture.setMock).toHaveBeenCalled();
      });
      expect(
        trackSpy.mock.calls.some(
          (call) => call[0] === AnalyticsEvent.HostLifecycleModeSet,
        ),
      ).toBe(false);
    },
  );

  it("an external onChange push updates the selected radio without calling set again", async () => {
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitFor(() => {
      expect(radioChecked(OPTION_COPY[0].label)).toBe("true");
    });

    fixture.pushChange(
      view({
        desired: {
          mode: "stop-if-idle",
          rev: 2,
          updatedBy: "cli",
          updatedAt: null,
        },
      }),
    );

    await waitFor(() => {
      expect(radioChecked(OPTION_COPY[2].label)).toBe("true");
    });
    expect(fixture.setMock).not.toHaveBeenCalled();
  });
});

describe("<HostLifecycleSettingsSection /> - desired/applied status line", () => {
  it("shows the restart-host line with a visible Restart host button when pending is restart-host", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    const line = await screen.findByTestId("host-lifecycle-applied-line");
    expect(line.textContent).toContain("Set to Linked");
    expect(line.textContent).toContain(HOST_LIFECYCLE_PENDING_RESTART_HOST);
    expect(screen.getByTestId("host-lifecycle-restart-host")).not.toBeNull();
  });

  it("shows the restart-app line ('takes effect at next launch') for none pending restart-app, with no Restart host button", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "none", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-app",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    const line = await screen.findByTestId("host-lifecycle-applied-line");
    expect(line.textContent).toContain("Set to No local host");
    expect(line.textContent).toContain(HOST_LIFECYCLE_PENDING_RESTART_APP);
    expect(screen.queryByTestId("host-lifecycle-restart-host")).toBeNull();
  });

  it("shows no status line when pending is none", async () => {
    const fixture = buildLifecycleHost(view({ pending: "none" }), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    expect(screen.queryByTestId("host-lifecycle-applied-line")).toBeNull();
  });
});

describe("<HostLifecycleSettingsSection /> - the 'none' option and plan gating", () => {
  it("disables 'none' with the plan reason on a FREE subscription", async () => {
    useAuthStore.getState().setSubscriptionStatus("FREE");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    expect(radioDisabled(OPTION_COPY[4].label)).toBe(true);
    expect(
      screen.getByTestId("host-lifecycle-none-plan-reason").textContent,
    ).toBe(HOST_LIFECYCLE_NONE_PLAN_REASON);
  });

  it.each([null, "PRO"] as const)(
    "does NOT disable 'none' when subscriptionStatus is %s",
    async (status) => {
      useAuthStore.getState().setSubscriptionStatus(status);
      const fixture = buildLifecycleHost(view({}), () =>
        Promise.resolve({ kind: "applied", view: view({}) }),
      );
      renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

      await waitForReady();
      expect(radioDisabled(OPTION_COPY[4].label)).toBe(false);
      expect(
        screen.queryByTestId("host-lifecycle-none-plan-reason"),
      ).toBeNull();
    },
  );

  it("does NOT disable 'none' on a FREE plan when desired.mode is already none", async () => {
    useAuthStore.getState().setSubscriptionStatus("FREE");
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "none", rev: 1, updatedBy: null, updatedAt: null },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    expect(radioDisabled(OPTION_COPY[4].label)).toBe(false);
  });

  it("picking 'none' while managed opens the stop-only confirm dialog with no Keep, no Remember, and 'Stop host' label", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(
      view({
        applied: { localHostCapability: "managed", supervisor: "enforcing" },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog).not.toBeNull();
    expect(screen.queryByTestId("host-quit-keep")).toBeNull();
    expect(screen.queryByTestId("host-quit-remember")).toBeNull();
    expect(screen.getByTestId("host-quit-stop").textContent).toContain(
      HOST_NONE_CONFIRM_STOP_LABEL,
    );
    expect(fixture.setMock).not.toHaveBeenCalled();
  });

  it("sends stop:'if-idle' on an idle verdict and stop:'force' on a busy one", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledWith({
        mode: "none",
        stop: "if-idle",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });

    cleanup();
    fixture.setMock.mockClear();
    localHostQuitStatusMock.current = busyVerdict("host-a");
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));
    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledWith({
        mode: "none",
        stop: "force",
      });
    });
  });

  it("a stop-refused (host-busy) result keeps the dialog open with the refusal, and the NEXT Stop sends force", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    let attempt = 0;
    const fixture = buildLifecycleHost(view({}), () => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          kind: "stop-refused",
          reason: "host-busy",
          message: "Something started on the host.",
          view: view({}),
        });
      }
      return Promise.resolve({ kind: "applied", view: view({}) });
    });
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toContain(
        "Something started on the host.",
      );
    });
    expect(screen.getByTestId("host-quit-dialog")).not.toBeNull();

    fireEvent.click(screen.getByTestId("host-quit-stop"));
    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "force",
      });
    });
  });

  it("a failed result shows the failure message inline and keeps the dialog open", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "write-failed",
        message: "Couldn't write the policy file.",
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toContain(
        "Couldn't write the policy file.",
      );
    });
    expect(screen.getByTestId("host-quit-dialog")).not.toBeNull();
  });

  it("a superseded result closes the dialog and shows a toast", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "superseded", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });
    expect(toast.info).toHaveBeenCalledWith(HOST_LIFECYCLE_SUPERSEDED_TITLE, {
      description: HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
    });
  });

  it("picking 'none' while localHostCapability is 'none' calls set directly with no confirm dialog", async () => {
    const fixture = buildLifecycleHost(
      view({
        applied: { localHostCapability: "none", supervisor: "enforcing" },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledWith({
        mode: "none",
        stop: null,
      });
    });
    expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
  });
});

describe("<HostLifecycleSettingsSection /> - presence", () => {
  it("is absent when hostLifecycle is null on the runner host", () => {
    renderSection(createFakeRunnerHost({ hostLifecycle: null }));
    expect(screen.queryByTestId("settings-host-lifecycle")).toBeNull();
  });

  it("is absent on mobile even with a hostLifecycle bridge", () => {
    setMobileApp(true);
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));
    expect(screen.queryByTestId("settings-host-lifecycle")).toBeNull();
  });

  it("is absent with no runner host at all", () => {
    renderSection(null);
    expect(screen.queryByTestId("settings-host-lifecycle")).toBeNull();
  });
});
