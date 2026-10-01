// While THIS machine's host was started in a terminal, the
// OS-service "register" controls are disabled - and, for the OS service
// section's own Deregister, the confirm copy stops claiming a stop the
// foreground run makes false. Same boundaries as
// `host-overview-foreground-run.test.tsx` (that file, read for the harness,
// not edited): the scoped stream binding, `useHostScope` and `@/lib/host`'s
// `useHostBinding` are mocked so `HostSettingsPanel` renders without a real
// host runtime.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  HostDoctorIssue,
  HostServiceDeregisterResponse,
  HostServiceRegisterResponse,
} from "@traycer/protocol/host/maintenance/index";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  openHostOverviewMenu,
  selectHostOverviewTab,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

const SERVICE_METHODS = [
  "host.service.status",
  "host.service.register",
  "host.service.deregister",
] as const;

// The constant doesn't exist yet - this exact literal is pinned.
const REGISTER_FOREGROUND_REASON =
  "A host you started in a terminal is running; stop it, then register the service.";

// The new confirm copy for Deregister during a LOCAL foreground run - also
// not a constant yet.
function foregroundDeregisterDescription(hostName: string): string {
  return (
    `This removes the registration that starts ${hostName} at login. ` +
    "The host you started in a terminal keeps running until you stop it " +
    "there. Nothing is uninstalled and no data is deleted — but Traycer " +
    "cannot start this host again from here, so bringing it back means " +
    "running 'traycer host service install' on the machine itself."
  );
}

function todaysDeregisterDescription(hostName: string): string {
  return `This stops ${hostName} and removes the registration that starts it again at login. Nothing is uninstalled and no data is deleted — but Traycer cannot start this host again from here, so bringing it back means running 'traycer host service install' on the machine itself.`;
}

function lifecycleView(
  admittedAs: HostLifecycleRunAdmission | null,
): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: admittedAs === null ? "not-running" : "enforcing",
      admittedAs,
    },
    pending: "none",
  };
}

interface LifecycleFixture {
  readonly host: IHostLifecycleHost;
  pushChange(next: HostLifecycleView): void;
}

function buildLifecycleHost(initial: HostLifecycleView): LifecycleFixture {
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const host: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  return {
    host,
    pushChange(next) {
      for (const handler of changeHandlers) handler(next);
    },
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
}

function renderInstallation(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
}): {
  readonly fixture: OverviewHostFixture;
  readonly lifecycle: LifecycleFixture;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, [
    ...OVERVIEW_METHODS,
    ...SERVICE_METHODS,
  ]);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const lifecycle = buildLifecycleHost(lifecycleView(options.admittedAs));
  const runnerHost = createFakeRunnerHost({ hostLifecycle: lifecycle.host });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, lifecycle };
}

function renderPanel(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly management?: IHostManagement | null;
}): {
  readonly fixture: OverviewHostFixture;
  readonly lifecycle: LifecycleFixture;
} {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, [
    ...OVERVIEW_METHODS,
    ...SERVICE_METHODS,
  ]);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const lifecycle = buildLifecycleHost(lifecycleView(options.admittedAs));
  const runnerHost = createFakeRunnerHost({
    hostLifecycle: lifecycle.host,
    hostManagement: options.management ?? null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, lifecycle };
}

async function openDoctorSheet(): Promise<void> {
  await openHostOverviewMenu();
  fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
}

function serviceNotRegisteredIssue(): HostDoctorIssue {
  return {
    code: "SERVICE_NOT_REGISTERED",
    severity: "warning",
    title: "Host service isn't registered",
    message: "The host has no OS service registration.",
    fixAction: "service-install",
    terminalCommand: "traycer host service register",
    details: null,
  };
}

function serviceRefreshIssue(): HostDoctorIssue {
  return {
    code: "SERVICE_DEFINITION_STALE",
    severity: "warning",
    title: "Host service definition is out of date",
    message: "The registered service points at an old install path.",
    fixAction: "service-refresh",
    terminalCommand: "traycer host service refresh",
    details: null,
  };
}

function describedReasonText(button: HTMLElement): string | null {
  const describedBy = button.getAttribute("aria-describedby");
  if (describedBy === null) return null;
  const reasonEl = document.getElementById(describedBy);
  return reasonEl?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  // Otherwise a register/deregister DISPATCH in one test (which arms a
  // module-scoped, host-keyed latch with a real 60s timer) leaks into the
  // next test reusing the same host id, silently disabling that test's
  // button before it ever clicks.
  resetHostServiceWriteLatchesForTest();
});

describe("Overview ▸ Installation ▸ OS service ▸ Re-register during a foreground run", () => {
  it("RED: foreground + local disables the button, names the reason, and dispatches nothing", async () => {
    let registerCalls = 0;
    renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      overrideHandlers: {
        "host.service.register": (): HostServiceRegisterResponse => {
          registerCalls += 1;
          return { outcome: "ok" as const };
        },
      },
    });
    await selectHostOverviewTab("installation");
    await screen.findByTestId("host-overview-service-register");

    // Positive first: only true once the lifecycle query has resolved, which
    // settles the render for the reason-text read right after it.
    await waitFor(() => {
      const button = screen.getByTestId(
        "host-overview-service-register",
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    const button = screen.getByTestId(
      "host-overview-service-register",
    ) as HTMLButtonElement;
    expect(describedReasonText(button)).toBe(REGISTER_FOREGROUND_REASON);

    fireEvent.click(button);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(registerCalls).toBe(0);
  });

  it("RED: opening the confirm while idle, then a foreground push, closes it and dispatches nothing", async () => {
    let registerCalls = 0;
    const { lifecycle } = renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
      overrideHandlers: {
        "host.service.register": (): HostServiceRegisterResponse => {
          registerCalls += 1;
          return { outcome: "ok" as const };
        },
      },
    });
    await selectHostOverviewTab("installation");
    const button = await screen.findByTestId("host-overview-service-register");
    fireEvent.click(button);

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Re-register this host's OS service?");

    act(() => {
      lifecycle.pushChange(lifecycleView("foreground"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(registerCalls).toBe(0);
  });

  it("GREEN control: admittedAs null — enabled with no reason", async () => {
    renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
    });
    await selectHostOverviewTab("installation");

    const button = (await screen.findByTestId(
      "host-overview-service-register",
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });

  it("GREEN control: a remote host stays enabled even though THIS machine is foreground", async () => {
    renderInstallation({
      hostId: "host-remote",
      isLocalMachine: false,
      admittedAs: "foreground",
    });
    await selectHostOverviewTab("installation");

    const button = (await screen.findByTestId(
      "host-overview-service-register",
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });
});

describe("Overview ▸ Installation ▸ OS service ▸ Deregister's confirm copy during a foreground run", () => {
  it("RED: local + foreground — the confirm's description is the foreground-safe sentence, never 'This stops', and Deregister stays enabled", async () => {
    renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
    });
    await selectHostOverviewTab("installation");

    const deregisterButton = (await screen.findByTestId(
      "host-overview-service-deregister",
    )) as HTMLButtonElement;
    expect(deregisterButton.disabled).toBe(false);

    fireEvent.click(deregisterButton);
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      foregroundDeregisterDescription("host-local"),
    );
    expect(dialog.textContent).not.toContain("This stops");
  });

  it("GREEN control: confirming under foreground still dispatches host.service.deregister once", async () => {
    let deregisterCalls = 0;
    renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      overrideHandlers: {
        "host.service.deregister": (): HostServiceDeregisterResponse => {
          deregisterCalls += 1;
          return { outcome: "accepted" as const };
        },
      },
    });
    await selectHostOverviewTab("installation");

    fireEvent.click(
      await screen.findByTestId("host-overview-service-deregister"),
    );
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(deregisterCalls).toBe(1);
    });
  });

  it("GREEN control: admittedAs null — today's copy, starting 'This stops'", async () => {
    renderInstallation({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
    });
    await selectHostOverviewTab("installation");

    fireEvent.click(
      await screen.findByTestId("host-overview-service-deregister"),
    );
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      todaysDeregisterDescription("host-local"),
    );
  });

  it("GREEN control: a remote host stays on today's copy even though THIS machine is foreground", async () => {
    renderInstallation({
      hostId: "host-remote",
      isLocalMachine: false,
      admittedAs: "foreground",
    });
    await selectHostOverviewTab("installation");

    fireEvent.click(
      await screen.findByTestId("host-overview-service-deregister"),
    );
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      todaysDeregisterDescription("host-remote"),
    );
  });
});

describe("the RPC Doctor sheet's Register service fix during a foreground run", () => {
  it("RED: foreground + local disables the fix, names the reason, and never calls runDoctorRepairIfIdle", async () => {
    const runDoctorRepairIfIdle = vi.fn(() =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    );
    const management = buildOverviewManagement({ runDoctorRepairIfIdle });
    renderPanel({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [serviceNotRegisteredIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();

    await waitFor(() => {
      const button = screen.getByTestId(
        `host-doctor-fix-${serviceNotRegisteredIssue().code}`,
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    const button = screen.getByTestId(
      `host-doctor-fix-${serviceNotRegisteredIssue().code}`,
    ) as HTMLButtonElement;
    expect(describedReasonText(button)).toBe(REGISTER_FOREGROUND_REASON);

    fireEvent.click(button);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(runDoctorRepairIfIdle).not.toHaveBeenCalled();
  });

  it("GREEN control: admittedAs null — the fix is enabled", async () => {
    const management = buildOverviewManagement({});
    renderPanel({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: null,
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [serviceNotRegisteredIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();

    const button = (await screen.findByTestId(
      `host-doctor-fix-${serviceNotRegisteredIssue().code}`,
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });

  it("GREEN control: foreground + local — the service-refresh (Update service) fix stays enabled with no reason", async () => {
    const management = buildOverviewManagement({});
    renderPanel({
      hostId: "host-local",
      isLocalMachine: true,
      admittedAs: "foreground",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [serviceRefreshIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();

    const button = (await screen.findByTestId(
      `host-doctor-fix-${serviceRefreshIssue().code}`,
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });
});
