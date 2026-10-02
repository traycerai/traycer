// Same boundary as `host-lifecycle-settings-section.test.tsx`: mock
// `@/lib/host`'s `useHostBinding` narrowly so the `→ none` confirm dialog can
// take its unbound or bound branch without a real host runtime.
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
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostLifecycleMode,
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { LocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import type { HostRpcRegistry } from "@/lib/host";
import { HostLifecycleSettingsRow } from "@/components/settings/host-lifecycle-settings-section";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";
import type { HostLifecycleSetInput } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import {
  HOST_LIFECYCLE_NONE_PLAN_REASON,
  HOST_LIFECYCLE_PENDING_RESTART_HOST,
  HOST_LIFECYCLE_TASK_NOT_OWNED_REASON,
  hostLifecycleCardSubtitle,
  hostLifecycleModeName,
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

const WRITE_FAILED_COPY =
  "Couldn't save this setting. Try again, or change it from the command line with `traycer host lifecycle set <mode>`.";
const WRITE_FAILED_HOME =
  "The host lifecycle setting could not be saved: Error: EACCES: permission denied, open '/Users/someone/.traycer/host/lifecycle-policy.json'";

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

function buildLifecycleHost(
  initial: HostLifecycleView,
  setImpl: (
    request: HostLifecycleSetRequest,
  ) => Promise<HostLifecycleSetResult>,
): LifecycleHostFixture {
  const setMock = vi.fn(setImpl);
  const host: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: setMock,
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
  return { host, setMock };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  const holder: { resolve: (value: T) => void } = {
    resolve: (value: T) => {
      void value;
      throw new Error("deferred resolve used before executor ran");
    },
  };
  const promise = new Promise<T>((resolve) => {
    holder.resolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      holder.resolve(value);
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderRow(runnerHost: IRunnerHost | null): QueryClient {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "Test User",
      email: "user@example.invalid",
    },
    { userId: "user-1", username: "Test User" },
    [],
  );
  const queryClient = makeQueryClient();
  const tree: ReactNode =
    runnerHost === null ? (
      <HostLifecycleSettingsRow />
    ) : (
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostLifecycleSettingsRow />
      </RunnerHostProvider>
    );
  render(
    <QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>,
  );
  return queryClient;
}

async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByTestId("host-lifecycle-select").hasAttribute("disabled"),
    ).toBe(false);
  });
}

/** Radix's select: open with the keyboard, as fallback-tier-group-card does. */
function openSelect(trigger: HTMLElement): void {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

function chooseMode(mode: HostLifecycleMode): void {
  const item = screen.getByTestId(`host-lifecycle-option-${mode}`);
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
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

function managementWithEnsureFailure(code: string, message: string) {
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
        lastEnsureFailure: { message, code },
        updateDeferral: null,
      }),
    ),
  });
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
  vi.restoreAllMocks();
});

describe("<HostLifecycleSettingsRow />", () => {
  it("renders nothing without the lifecycle bridge", () => {
    renderRow(createFakeRunnerHost({ hostLifecycle: null }));
    expect(screen.queryByTestId("host-lifecycle-select")).toBeNull();
    expect(screen.queryByText("When you quit Traycer")).toBeNull();
  });

  it("renders nothing with no runner host at all", () => {
    renderRow(null);
    expect(screen.queryByTestId("host-lifecycle-select")).toBeNull();
  });

  it("shows Loading then the short name, and the description is the chosen mode's sentence", async () => {
    const initial = view({});
    const deferred = createDeferred<HostLifecycleView>();
    const host: IHostLifecycleHost = {
      get: () => deferred.promise,
      set: () => Promise.resolve({ kind: "applied", view: initial }),
      onChange: () => ({ dispose: () => undefined }),
      quit: null,
    };
    renderRow(createFakeRunnerHost({ hostLifecycle: host }));

    const trigger = screen.getByTestId("host-lifecycle-select");
    expect(trigger.textContent).toContain("Loading");
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("host-lifecycle-row-description").textContent,
    ).toBe(hostLifecycleCardSubtitle(MACHINE));

    deferred.resolve(initial);

    await waitForReady();
    expect(trigger.textContent).toContain(hostLifecycleModeName("background"));
    expect(trigger.textContent).not.toContain("Loading");
    expect(
      screen.getByTestId("host-lifecycle-row-description").textContent,
    ).toBe(OPTION_COPY[0].description);
  });

  it("picking another mode calls the set mutation with { request, source: settings }", async () => {
    const applied = view({
      desired: { mode: "ask", rev: 2, updatedBy: null, updatedAt: null },
    });
    const deferred = createDeferred<HostLifecycleSetResult>();
    const fixture = buildLifecycleHost(view({}), () => deferred.promise);
    const queryClient = renderRow(
      createFakeRunnerHost({ hostLifecycle: fixture.host }),
    );

    await waitForReady();
    openSelect(screen.getByTestId("host-lifecycle-select"));
    chooseMode("ask");

    await waitFor(() => {
      expect(screen.getByTestId("host-lifecycle-row-pending")).toBeTruthy();
    });
    expect(
      screen.getByTestId("host-lifecycle-select").hasAttribute("disabled"),
    ).toBe(true);

    const mutations = queryClient.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    const expected: HostLifecycleSetInput = {
      request: { mode: "ask", stop: null },
      source: "settings",
    };
    expect(mutations[0].state.variables).toEqual(expected);

    deferred.resolve({ kind: "applied", view: applied });

    await waitFor(() => {
      expect(fixture.setMock).toHaveBeenCalledWith({
        mode: "ask",
        stop: null,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("host-lifecycle-row-description").textContent,
      ).toBe(OPTION_COPY[1].description);
    });
    expect(screen.queryByTestId("host-lifecycle-row-pending")).toBeNull();
  });

  it("picking none on a managed launch opens the confirm dialog and writes nothing", async () => {
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
    renderRow(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    openSelect(screen.getByTestId("host-lifecycle-select"));
    chooseMode("none");

    expect(await screen.findByTestId("host-quit-dialog")).not.toBeNull();
    expect(fixture.setMock).not.toHaveBeenCalled();
  });

  it("disables none with the plan reason on an unpaid plan", async () => {
    useAuthStore.getState().setSubscriptionStatus("FREE");
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderRow(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    openSelect(screen.getByTestId("host-lifecycle-select"));
    const none = await screen.findByTestId("host-lifecycle-option-none");
    expect(none.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByTestId("host-lifecycle-none-plan-reason").textContent,
    ).toBe(HOST_LIFECYCLE_NONE_PLAN_REASON);
    expect(none.textContent).toContain(OPTION_COPY[4].label);
    expect(none.textContent).toContain(OPTION_COPY[4].description);
  });

  it("a refused write shows the inline error", async () => {
    const fixture = buildLifecycleHost(view({}), () =>
      Promise.resolve({
        kind: "failed",
        reason: "write-failed",
        message: WRITE_FAILED_HOME,
        view: view({}),
      }),
    );
    renderRow(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    await waitForReady();
    openSelect(screen.getByTestId("host-lifecycle-select"));
    chooseMode("linked");

    await waitFor(() => {
      expect(screen.getByTestId("host-lifecycle-error").textContent).toBe(
        WRITE_FAILED_COPY,
      );
    });
    expect(document.body.textContent).not.toContain("/Users/someone");
  });

  it("pending restart-host state shows the applied line with the Restart host button", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderRow(createFakeRunnerHost({ hostLifecycle: fixture.host }));

    const line = await screen.findByTestId("host-lifecycle-applied-line");
    expect(line.textContent).toContain("Set to Linked");
    expect(line.textContent).toContain(HOST_LIFECYCLE_PENDING_RESTART_HOST);
    expect(screen.getByTestId("host-lifecycle-restart-host")).not.toBeNull();
    const row = screen
      .getByTestId("host-lifecycle-select")
      .closest("[data-settings-anchor]");
    expect(row instanceof HTMLElement).toBe(true);
    if (!(row instanceof HTMLElement)) return;
    expect(row.contains(line)).toBe(true);
  });

  it("shows the task-not-owned notice as the row hint", async () => {
    const fixture = buildLifecycleHost(
      view({
        desired: { mode: "linked", rev: 2, updatedBy: null, updatedAt: null },
        pending: "restart-host",
      }),
      () => Promise.resolve({ kind: "applied", view: view({}) }),
    );
    renderRow(
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
    const row = screen
      .getByTestId("host-lifecycle-select")
      .closest("[data-settings-anchor]");
    expect(row instanceof HTMLElement).toBe(true);
    if (!(row instanceof HTMLElement)) return;
    expect(row.contains(notice)).toBe(true);
    expect(notice.closest("p")?.className).toContain("text-warning-foreground");

    openSelect(screen.getByTestId("host-lifecycle-select"));
    const background = await screen.findByTestId(
      "host-lifecycle-option-background",
    );
    expect(background.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getAllByTestId("host-lifecycle-none-plan-reason")
        .map((el) => el.textContent),
    ).toEqual(
      OPTION_COPY.filter(
        (option) => option.mode !== "linked" && option.mode !== "none",
      ).map(() => HOST_LIFECYCLE_TASK_NOT_OWNED_REASON),
    );
  });
});
