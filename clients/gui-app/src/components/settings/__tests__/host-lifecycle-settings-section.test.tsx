// Same boundary as `local-host-restart-flow.test.tsx`: mock `@/lib/host`'s
// `useHostBinding` narrowly (spreading the real module so every other export
// stays intact), so the `→ none` confirm dialog's `NoneConfirmBody` can take
// its bound or unbound branch without standing up a real host runtime.
interface HostBindingFixture {
  readonly directory: {
    readonly getLocalEntry: () => HostDirectoryEntry | null;
  };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

// Same boundary as `local-host-restart-flow.test.tsx`, needed only for the
// service-restart tests below: those are the first tests
// in this file to render `LocalHostRestartFlow`'s BOUND arm
// (`CooperativeFirstRestartFlow`), which calls both hooks unconditionally.
// Neither is mocked anywhere else in this file (every earlier test either
// leaves `hostBindingMock.current` null or only cares about the `→ none`
// dialog's unbound branch), so left real they would throw
// "Host runtime hooks must be used inside a <HostRuntimeProvider>" - this
// suite never mounts one.
interface DirectoryListMockState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
}
const directoryListMock = vi.hoisted(
  (): { current: DirectoryListMockState } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => directoryListMock.current,
}));

type HostClientResolver = (
  hostId: string | null,
) => HostClient<HostRpcRegistry> | null;
const clientForHostIdMock = vi.hoisted((): { current: HostClientResolver } => ({
  current: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    clientForHostIdMock.current(hostId),
}));

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
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { LocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import type { HostRpcRegistry } from "@/lib/host";
import { HostLifecycleSettingsSection } from "@/components/settings/host-lifecycle-settings-section";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  HOST_LIFECYCLE_NONE_PLAN_REASON,
  HOST_LIFECYCLE_PENDING_RESTART_APP,
  HOST_LIFECYCLE_PENDING_RESTART_HOST,
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  HOST_LIFECYCLE_TASK_NOT_OWNED_REASON,
  HOST_NONE_CONFIRM_STOP_LABEL,
  HOST_NONE_CONFIRM_TITLE_BUSY,
  HOST_NONE_CONFIRM_TITLE_IDLE,
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
  hostLifecycleOptionCopy,
  hostMachineNoun,
} from "@/lib/host/host-lifecycle-copy";
import {
  SERVICE_TASK_NOT_OWNED_CODE,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
} from "@traycer-clients/shared/platform/host-service-notices";
import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

const MACHINE = hostMachineNoun();
const OPTION_COPY = hostLifecycleOptionCopy(MACHINE);

// The copy a set refusal renders is chosen by `result.reason`
// (`hostLifecycleSetRefusalCopy`), never `result.message` (main's or the CLI's
// raw text). Written out literally so these tests pin the wording itself.
const HOST_BUSY_STOP_REFUSED_COPY =
  "The host has work in progress, so it was left running. Stop host again to end that work.";
const LOCK_BUSY_STOP_REFUSED_COPY =
  "Another Traycer process is managing the host right now, so nothing was changed. Try again in a moment.";
const UPDATE_ACTIVE_STOP_REFUSED_COPY =
  "The host is installing an update, so nothing was changed. Try again once it finishes.";
const STOP_FAILED_COPY =
  "The host couldn't be stopped, so nothing was changed. If you started it from a terminal, stop it there, then try again.";
const WRITE_FAILED_COPY =
  "Couldn't save this setting. Try again, or change it from the command line with `traycer host lifecycle set <mode>`.";
const CONFIRMATION_REQUIRED_COPY =
  "Turning off the local host stops Traycer Host. Confirm the stop to continue.";

// Fixture `message` values: the real raw CLI/main text that must never reach
// the DOM.
const CLI_BUSY =
  "The running host has work in progress; refusing to stop it and lose that work. Re-run with --force to stop it anyway.";
const NOT_SERVICE_RUN =
  "host stop: the running host was started in a terminal (supervisor pid 4242) and is not run by the service; stop it there with Ctrl-C, or pass --force";
const UPDATE_ACTIVE =
  "The host update-attempt lock at /Users/someone/.traycer/host/update-attempt.lock is held by pid 77 (update, since 2026-09-26T10:00:00Z); re-run with --force to stop anyway.";
const WRITE_FAILED_HOME =
  "The host lifecycle setting could not be saved: Error: EACCES: permission denied, open '/Users/someone/.traycer/host/lifecycle-policy.json'";

function localEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.5.0",
    transportDialability: "dialable",
  };
}

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
  // The card's home is Settings > General, so it renders admitted; the
  // signed-out gate has its own file (host-lifecycle-none-plan-gate-signed-out).
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "Test User",
      email: "user@example.invalid",
    },
    { userId: "user-1", username: "Test User" },
    [],
  );
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
  directoryListMock.current = { data: undefined };
  clientForHostIdMock.current = () => null;
  localHostQuitStatusMock.current = null;
  setMobileApp(false);
  useAuthStore.getState().setSubscriptionStatus(null);
  useAuthStore.getState().setSignedOut();
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

// The restart-host line's button runs
// `LocalHostRestartFlow` with `firstLeg="service"` - the lifecycle card's
// idle-gated SERVICE restart, never the cooperative `host.restart` RPC these
// other cards use. These tests mount the BOUND arm
// (`CooperativeFirstRestartFlow`), so they are the ones in this file that
// need `directoryListMock`/`clientForHostIdMock` set up.
describe("<HostLifecycleSettingsSection /> - restart-host line dispatches the SERVICE restart", () => {
  function restartHostLifecycleFixture() {
    return buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
  }

  it("Restart host -> confirm calls restartHostServiceIfHostIdle with the local host's id, never the cooperative host.restart RPC", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    // A working cooperative client IS resolvable here, deliberately - the
    // point is that the service leg never even tries it.
    const cooperativeFixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? cooperativeFixture.client : null;
    const restartHostServiceIfHostIdle = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const lifecycle = restartHostLifecycleFixture();
    renderSection(
      createFakeRunnerHost({
        hostLifecycle: lifecycle.host,
        hostManagement: buildOverviewManagement({
          restartHostServiceIfHostIdle,
        }),
      }),
    );

    await screen.findByTestId("host-lifecycle-applied-line");
    fireEvent.click(screen.getByTestId("host-lifecycle-restart-host"));
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(restartHostServiceIfHostIdle).toHaveBeenCalledWith({
        expectedHostId: "host-a",
      });
    });
    expect(cooperativeFixture.restartCalls()).toBe(0);
  });

  it('after the service restart resolves and the lifecycle view flips to pending:"none" via the host\'s own onChange, the applied line disappears without a remount', async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    clientForHostIdMock.current = () => null;
    const restartHostServiceIfHostIdle = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const lifecycle = restartHostLifecycleFixture();
    renderSection(
      createFakeRunnerHost({
        hostLifecycle: lifecycle.host,
        hostManagement: buildOverviewManagement({
          restartHostServiceIfHostIdle,
        }),
      }),
    );

    await screen.findByTestId("host-lifecycle-applied-line");
    // Reference identity, not just presence: a remount would swap this DOM
    // node for a new one, and `toBe` below would then fail even though a
    // fresh "host-lifecycle-card" still exists.
    const cardBeforeChange = screen.getByTestId("host-lifecycle-card");

    fireEvent.click(screen.getByTestId("host-lifecycle-restart-host"));
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(restartHostServiceIfHostIdle).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });

    // The lifecycle view's own transition to pending:"none" is a SEPARATE
    // event from the restart mutation settling - it arrives however the real
    // host later reports its supervisor as caught up, which this harness
    // models as an explicit onChange push.
    lifecycle.pushChange(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "none",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("host-lifecycle-applied-line")).toBeNull();
    });
    expect(screen.getByTestId("host-lifecycle-card")).toBe(cardBeforeChange);
  });
});

// A host started in a terminal is not governed by the mode, so the
// restart-host line's own button must never dispatch a restart over it - it
// disables itself and names why, rather than letting a click reach
// `LocalHostRestartFlow`.
describe("<HostLifecycleSettingsSection /> - restart-host line with a foreground-admitted host", () => {
  it("disables Restart host, names the reason via aria-describedby, and dispatches no restart on click", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    const cooperativeFixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? cooperativeFixture.client : null;
    const restartHostServiceIfHostIdle = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: "foreground",
        },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(
      createFakeRunnerHost({
        hostLifecycle: fixture.host,
        hostManagement: buildOverviewManagement({
          restartHostServiceIfHostIdle,
        }),
      }),
    );

    await screen.findByTestId("host-lifecycle-applied-line");
    const button = screen.getByTestId(
      "host-lifecycle-restart-host",
    ) as HTMLButtonElement;
    // Native property, not jest-dom's `toBeDisabled()`: this repo has no
    // jest-dom matchers wired in (see e.g. `host-doctor-card.test.tsx`).
    expect(button.disabled).toBe(true);

    expect(
      screen.getByText(
        "A host started in a terminal is running; restart it yourself to apply.",
      ),
    ).not.toBeNull();
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const reasonEl =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(reasonEl?.textContent).toBe(
      "A host started in a terminal is running; restart it yourself to apply.",
    );

    fireEvent.click(button);
    expect(restartHostServiceIfHostIdle).not.toHaveBeenCalled();
    expect(cooperativeFixture.restartCalls()).toBe(0);
  });

  it("control: admittedAs null keeps the button enabled with no reason text", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: null,
        },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await screen.findByTestId("host-lifecycle-applied-line");
    const button = screen.getByTestId(
      "host-lifecycle-restart-host",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      screen.queryByText(
        "A host started in a terminal is running; restart it yourself to apply.",
      ),
    ).toBeNull();
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
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: null,
        },
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
    // Not pending, so the button renders no PendingDots node - its
    // textContent should be exactly the stop label, nothing else.
    expect(screen.getByTestId("host-quit-stop").textContent).toBe(
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

  it("a stop-refused (host-busy) result shows curated copy (never the raw CLI text), and the NEXT Stop sends force", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    let attempt = 0;
    const fixture = buildLifecycleHost(view({}), () => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          kind: "stop-refused",
          reason: "host-busy",
          message: CLI_BUSY,
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
      expect(screen.getByTestId("host-quit-detail").textContent).toBe(
        HOST_BUSY_STOP_REFUSED_COPY,
      );
    });
    expect(screen.getByTestId("host-quit-detail").textContent).not.toContain(
      "--force",
    );
    expect(screen.getByTestId("host-quit-detail").textContent).not.toContain(
      "Re-run",
    );
    expect(screen.getByTestId("host-quit-dialog")).not.toBeNull();

    fireEvent.click(screen.getByTestId("host-quit-stop"));
    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "force",
      });
    });
  });

  it("a failed (write-failed) result shows curated copy and never leaks the raw path/error text", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "write-failed",
        message: WRITE_FAILED_HOME,
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toBe(
        WRITE_FAILED_COPY,
      );
    });
    expect(screen.getByTestId("host-quit-dialog")).not.toBeNull();
    expect(document.body.textContent).not.toContain("/Users/someone");
    expect(document.body.textContent).not.toContain("EACCES");
  });

  it("a stop-refused (update-active) result shows curated copy and never leaks the lock path", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "stop-refused",
        reason: "update-active",
        message: UPDATE_ACTIVE,
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toBe(
        UPDATE_ACTIVE_STOP_REFUSED_COPY,
      );
    });
    expect(document.body.textContent).not.toContain("/Users/someone");
  });

  it("a failed (stop-failed) result shows curated copy and never leaks --force", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "stop-failed",
        message: NOT_SERVICE_RUN,
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toBe(
        STOP_FAILED_COPY,
      );
    });
    expect(screen.getByTestId("host-quit-detail").textContent).not.toContain(
      "--force",
    );
  });

  it("a stop-refused (lock-busy) result shows curated copy", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "stop-refused",
        reason: "lock-busy",
        message: "Another Traycer process is managing the host.",
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-detail").textContent).toBe(
        LOCK_BUSY_STOP_REFUSED_COPY,
      );
    });
  });

  it("force is sent only when the verdict FIRST offered with Stop enabled was busy/unknown - an idle-then-busy flip still sends if-idle", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    await waitFor(() => {
      expect(screen.getByTestId("host-quit-dialog").textContent).toContain(
        HOST_NONE_CONFIRM_TITLE_IDLE,
      );
    });

    // Flip the mocked verdict, then force a re-render: `pushChange` writes a
    // fresh lifecycle view into the query cache, which re-renders the whole
    // settings section (including the still-open dialog), and the dialog
    // re-reads `useLocalHostQuitStatus()` - i.e. this mock - on every render.
    localHostQuitStatusMock.current = busyVerdict("host-a");
    // `view({})` alone is structurally identical to what is already cached,
    // and TanStack Query's `setQueryData` keeps the SAME reference (no
    // re-render) for a structurally-equal write - so this bumps `rev` to
    // force one, without changing the desired mode the dialog cares about.
    fixture.pushChange(
      view({
        desired: {
          mode: "background",
          rev: 2,
          updatedBy: null,
          updatedAt: null,
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("host-quit-dialog").textContent).toContain(
        HOST_NONE_CONFIRM_TITLE_BUSY,
      );
    });

    fireEvent.click(screen.getByTestId("host-quit-stop"));
    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "if-idle",
      });
    });
  });

  it("control: a verdict that is busy from the dialog's first render sends force", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = busyVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "force",
      });
    });
  });

  it("after a host-busy refusal on an idle verdict, the counts line must not still read idle", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "stop-refused",
        reason: "host-busy",
        message: CLI_BUSY,
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-dialog").textContent).toContain(
        HOST_NONE_CONFIRM_TITLE_BUSY,
      );
    });
    expect(screen.getByTestId("host-quit-counts").textContent).toBe(
      "The host reports it is busy. Shells and scheduled wakes: unknown on this host version.",
    );
  });

  it("an 'unknown' verdict sends stop:'force'", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: { kind: "unknown", reason: "unreachable" },
      liveLocalHostIdNow: () => "host-a",
      recheck: () => undefined,
    };
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "force",
      });
    });
  });

  it("a host changed under the open dialog refuses to stop, toasts, and rechecks instead", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    const recheck = vi.fn();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: null,
      },
      liveLocalHostIdNow: () => "host-b",
      recheck,
    };
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(HOST_QUIT_HOST_CHANGED_TITLE, {
        description: HOST_QUIT_HOST_CHANGED_DESCRIPTION,
      });
    });
    expect(fixture.setMock).not.toHaveBeenCalled();
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("the none-confirm opens with Cancel focused, and Enter closes it without calling set", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("host-quit-cancel"),
      );
    });

    const user = userEvent.setup();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });
    expect(fixture.setMock).not.toHaveBeenCalled();
  });

  // `not-running` - the local host is not serving - has nothing to list
  // and nothing to force.
  it("a 'not-running' verdict titles as the idle confirm and sends stop:'if-idle'", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    const notRunningVerdict: LocalHostQuitStatus = {
      localHostId: "host-a",
      verdict: { kind: "not-running" },
      liveLocalHostIdNow: () => "host-a",
      recheck: () => undefined,
    };
    localHostQuitStatusMock.current = notRunningVerdict;
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");

    await waitFor(() => {
      expect(screen.getByTestId("host-quit-dialog").textContent).toContain(
        "Stop the host on this machine?",
      );
    });
    fireEvent.click(screen.getByTestId("host-quit-stop"));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenLastCalledWith({
        mode: "none",
        stop: "if-idle",
      });
    });
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
        applied: {
          localHostCapability: "none",
          supervisor: "enforcing",
          admittedAs: null,
        },
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

// Main now COMMITS `set({mode:"none", stop})` during a foreground run -
// it refuses the stop as `not-service-run`, writes none, and leaves the
// terminal host running. So the confirm must not offer or claim a stop while
// `admittedAs === "foreground"`.
describe("<HostLifecycleSettingsSection /> - the none confirm during a foreground run", () => {
  it("shows the foreground-safe title/description and a Switch action, never Stop host", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(
      view({
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: "foreground",
        },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    const dialog = await screen.findByTestId("host-quit-dialog");

    expect(dialog.textContent).toContain("Switch to No local host?");
    expect(dialog.textContent).toContain(
      "A host started in a terminal is running. Traycer won't stop it: it keeps running until you stop it there. From the next launch, Traycer connects only to remote hosts.",
    );
    expect(
      screen.queryByRole("button", { name: HOST_NONE_CONFIRM_STOP_LABEL }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Switch" })).not.toBeNull();
  });

  it("clicking Switch calls set exactly once with {mode:'none', stop:'if-idle'} and closes on an applied result", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(
      view({
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: "foreground",
        },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    await screen.findByTestId("host-quit-dialog");

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledTimes(1);
    });
    expect(fixture.setMock).toHaveBeenCalledWith({
      mode: "none",
      stop: "if-idle",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });
  });

  it("control: admittedAs null keeps today's stop-only form (Stop host present, no Switch)", async () => {
    hostBindingMock.current = { directory: { getLocalEntry: () => null } };
    localHostQuitStatusMock.current = idleVerdict("host-a");
    const fixture = buildLifecycleHost(
      view({
        applied: {
          localHostCapability: "managed",
          supervisor: "enforcing",
          admittedAs: null,
        },
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[4].label }));
    const dialog = await screen.findByTestId("host-quit-dialog");

    expect(dialog.textContent).toContain(HOST_NONE_CONFIRM_TITLE_IDLE);
    expect(
      screen.getByRole("button", { name: HOST_NONE_CONFIRM_STOP_LABEL }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Switch" })).toBeNull();
  });
});

describe("<HostLifecycleSettingsSection /> - the settings card's own inline error uses result.reason, not raw message", () => {
  it("a failed (write-failed) result on a direct mode change shows curated copy and never leaks the raw path/error text", async () => {
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "write-failed",
        message: WRITE_FAILED_HOME,
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[3].label }));

    await waitFor(() => {
      expect(screen.getByTestId("host-lifecycle-error").textContent).toBe(
        WRITE_FAILED_COPY,
      );
    });
    expect(document.body.textContent).not.toContain("/Users/someone");
  });

  it("a failed (confirmation-required) result on a direct mode change shows its curated copy", async () => {
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "confirmation-required",
        message:
          "Turning off the local host stops Traycer Host. Confirm the stop to continue.",
        view: view({}),
      }),
    );
    renderSection(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    fireEvent.click(screen.getByRole("radio", { name: OPTION_COPY[3].label }));

    await waitFor(() => {
      expect(screen.getByTestId("host-lifecycle-error").textContent).toBe(
        CONFIRMATION_REQUIRED_COPY,
      );
    });
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

// The host's Scheduled Task is another Windows user's: the last ensure was
// refused `E_SERVICE_TASK_NOT_OWNED` and `HostControllerStatus.lastEnsureFailure`
// carries it. The card says why, holds the modes that would run a host here
// (the service refresh a switch between them makes would be refused), keeps
// `none` and the mode already chosen, and offers no restart.
describe("<HostLifecycleSettingsSection /> - another Windows user's task", () => {
  function managementWithEnsureFailure(code: string | null, message: string) {
    return buildOverviewManagement({
      getHostControllerStatus: vi.fn(() =>
        Promise.resolve({
          download: null,
          mutation: null,
          installedVersion: "1.5.0",
          latestVersion: "1.5.0",
          stagedVersion: null,
          installedRuntimeVersion: "1.5.0",
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "unavailable" as const,
          reachable: false,
          localAttempt: null,
          removedByUser: false,
          checkedAt: "2026-08-12T00:00:00Z",
          lastEnsureFailure: code === null ? null : { message, code },
          updateDeferral: null,
        }),
      ),
    });
  }

  it("shows the notice, holds every mode but the chosen one and none with the reason, and offers no Restart host", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(
      createFakeRunnerHost({
        hostLifecycle: fixture.host,
        hostManagement: managementWithEnsureFailure(
          SERVICE_TASK_NOT_OWNED_CODE,
          SERVICE_TASK_NOT_OWNED_MESSAGE,
        ),
      }),
    );

    const notice = await screen.findByTestId("host-lifecycle-task-not-owned");
    expect(notice.textContent).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
    for (const option of OPTION_COPY) {
      const heldByTask = option.mode !== "linked" && option.mode !== "none";
      expect({
        mode: option.mode,
        disabled: radioDisabled(option.label),
      }).toEqual({ mode: option.mode, disabled: heldByTask });
    }
    expect(
      screen
        .getAllByTestId("host-lifecycle-none-plan-reason")
        .map((el) => el.textContent),
    ).toEqual(
      OPTION_COPY.filter((o) => o.mode !== "linked" && o.mode !== "none").map(
        () => HOST_LIFECYCLE_TASK_NOT_OWNED_REASON,
      ),
    );
    // The line still says what is pending, but no restart is offered: it would
    // be refused before touching anything.
    const line = screen.getByTestId("host-lifecycle-applied-line");
    expect(line.textContent).toContain("Set to Linked");
    expect(screen.queryByTestId("host-lifecycle-restart-host")).toBeNull();
    expect(document.body.textContent).not.toMatch(/S-1-\d/);
  });

  // T08 ruling 13: the same refusal over a task whose owner could not be
  // confirmed holds the card the same way, but says so in its own words -
  // nothing on the card calls the task another user's.
  it("an owner that could not be confirmed: the card shows that copy, holds the same modes, and never says another Windows user", async () => {
    const UNCONFIRMED =
      "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.";
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderSection(
      createFakeRunnerHost({
        hostLifecycle: fixture.host,
        hostManagement: managementWithEnsureFailure(
          SERVICE_TASK_NOT_OWNED_CODE,
          UNCONFIRMED,
        ),
      }),
    );

    const notice = await screen.findByTestId("host-lifecycle-task-not-owned");
    expect(notice.textContent).toBe(UNCONFIRMED);
    for (const option of OPTION_COPY) {
      const heldByTask = option.mode !== "linked" && option.mode !== "none";
      expect(radioDisabled(option.label)).toBe(heldByTask);
    }
    expect(document.body.textContent).not.toContain("another Windows user");
    expect(screen.queryByTestId("host-lifecycle-restart-host")).toBeNull();
  });

  it("control: any other ensure failure (or none) leaves the card as it was - no notice, every mode selectable, Restart host offered", async () => {
    for (const code of ["E_SERVICE_REGISTRATION_DISABLED", null]) {
      const fixture = buildLifecycleHost(
        view({
          desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
          pending: "restart-host",
        }),
        () => Promise.resolve({ kind: "applied", view: view({}) }),
      );
      renderSection(
        createFakeRunnerHost({
          hostLifecycle: fixture.host,
          hostManagement: managementWithEnsureFailure(code, "refused"),
        }),
      );
      await screen.findByTestId("host-lifecycle-restart-host");
      await waitFor(() => {
        expect(
          screen.queryByTestId("host-lifecycle-task-not-owned"),
        ).toBeNull();
      });
      for (const option of OPTION_COPY) {
        expect(radioDisabled(option.label)).toBe(false);
      }
      cleanup();
    }
  });
});
