// Drives `HostUpdateBusyDialog` (and the base dialog's `idleAction` arm) with a
// host.status-shaped answer fed through the real `decideVerdict`, a fake
// `IHostManagement` on the runner host, and the same narrow `@/lib/host` /
// focus-model boundary the quit dialog suite draws.
const statusMock = vi.hoisted((): { current: LocalHostQuitStatus } => ({
  current: {
    localHostId: "host-a",
    verdict: { kind: "checking" },
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  },
}));
vi.mock(
  "@/components/host/use-local-host-quit-status",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/host/use-local-host-quit-status")
      >();
    return { ...actual, useLocalHostQuitStatus: () => statusMock.current };
  },
);

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: {
    info: toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

interface HostBindingFixture {
  readonly directory: { readonly getLocalEntry: () => null };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({
    current: { directory: { getLocalEntry: () => null } },
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActivateInstalledOk,
  IHostManagement,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import {
  decideVerdict,
  type LocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";
import {
  HostUpdateBusyDialog,
  type HostUpdateBusyDialogProps,
} from "@/components/host/host-update-busy-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { hostQuitCountsLine } from "@/lib/host/host-lifecycle-copy";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

type Outcome = MutationOutcome<ActivateInstalledOk>;

const BREAKDOWN: HostBusyBreakdownV2 = {
  workingAgents: 2,
  activeTerminalAgents: 0,
  busyTerminals: 1,
  shells: 3,
  scheduledWakes: 1,
};

/** The verdict the real hook would build from this `host.status` answer. */
function setHostStatus(
  busyBreakdown: HostBusyBreakdownV2 | null,
  statusMinor: number,
): { readonly line: string } {
  const verdict = decideVerdict({
    hasLocalEntry: true,
    dialable: true,
    canAsk: true,
    freshData: { busy: true, busySessionCount: 3, busyBreakdown },
    freshError: false,
    timedOut: false,
    statusMinor,
  });
  statusMock.current = {
    localHostId: "host-a",
    verdict,
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  };
  return {
    line: hostQuitCountsLine({
      busy: true,
      busySessionCount: 3,
      breakdown: busyBreakdown,
      statusMinor,
    }),
  };
}

function renderDialog(
  overrides: Partial<HostUpdateBusyDialogProps>,
  management: IHostManagement,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props: HostUpdateBusyDialogProps = {
    busy: { continuation: "activate", message: "Work is in progress." },
    isForcing: false,
    onForce: vi.fn(),
    onDefer: vi.fn(),
    onActivateOutcome: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider
        runnerHost={createFakeRunnerHost({ hostManagement: management })}
      >
        <HostUpdateBusyDialog {...props} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function activateManagement(outcome: Outcome) {
  const activateInstalled = vi.fn((_force: boolean, _retryWhenIdle: boolean) =>
    Promise.resolve(outcome),
  );
  return {
    activateInstalled,
    management: buildOverviewManagement({ activateInstalled }),
  };
}

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
  hostBindingMock.current = { directory: { getLocalEntry: () => null } };
  statusMock.current = {
    localHostId: "host-a",
    verdict: { kind: "checking" },
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  };
});

describe("<HostUpdateBusyDialog />", () => {
  it("activate continuation: message, work counts, sessions section and three buttons", async () => {
    const { line } = setHostStatus(BREAKDOWN, 6);
    renderDialog(
      {},
      activateManagement({ kind: "ok", value: { activated: true } }).management,
    );

    expect(await screen.findByText("Work is in progress.")).toBeTruthy();
    expect(screen.getByTestId("host-busy-work-counts").textContent).toBe(line);
    expect(screen.getByLabelText("Running sessions")).toBeTruthy();
    expect(screen.getByTestId("host-busy-defer").textContent).toBe("Defer");
    expect(screen.getByTestId("host-busy-when-idle").textContent).toBe(
      "Restart when idle",
    );
    expect(screen.getByTestId("host-busy-force").textContent).toBe(
      "Force restart",
    );
  });

  it("retry-with-force continuation: no when-idle button, Force reads 'Force update'", async () => {
    setHostStatus(BREAKDOWN, 6);
    renderDialog(
      { busy: { continuation: "retry-with-force", message: "Busy." } },
      activateManagement({ kind: "ok", value: { activated: true } }).management,
    );

    await screen.findByText("Busy.");
    expect(screen.queryByTestId("host-busy-when-idle")).toBeNull();
    expect(screen.getByTestId("host-busy-force").textContent).toBe(
      "Force update",
    );
  });

  it("an older host without the shell and wake counts still renders its own line", async () => {
    const older: HostBusyBreakdownV2 = {
      ...BREAKDOWN,
      shells: null,
      scheduledWakes: null,
    };
    const { line } = setHostStatus(older, 5);
    renderDialog(
      {},
      activateManagement({ kind: "ok", value: { activated: true } }).management,
    );

    expect(
      (await screen.findByTestId("host-busy-work-counts")).textContent,
    ).toBe(line);
  });

  it("Restart when idle calls activateInstalled(false, true); a busy outcome defers without reporting an outcome", async () => {
    setHostStatus(BREAKDOWN, 6);
    const { activateInstalled, management } = activateManagement({
      kind: "busy",
      continuation: "activate",
      message: "scheduled",
    });
    const onDefer = vi.fn();
    const onActivateOutcome = vi.fn();
    renderDialog({ onDefer, onActivateOutcome }, management);

    await userEvent.click(await screen.findByTestId("host-busy-when-idle"));

    await waitFor(() => {
      expect(onDefer).toHaveBeenCalledTimes(1);
    });
    expect(activateInstalled).toHaveBeenCalledWith(false, true);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(onActivateOutcome).not.toHaveBeenCalled();
  });

  it("Restart when idle hands an ok outcome to onActivateOutcome", async () => {
    setHostStatus(BREAKDOWN, 6);
    const outcome: Outcome = { kind: "ok", value: { activated: true } };
    const onDefer = vi.fn();
    const onActivateOutcome = vi.fn();
    renderDialog(
      { onDefer, onActivateOutcome },
      activateManagement(outcome).management,
    );

    await userEvent.click(await screen.findByTestId("host-busy-when-idle"));

    await waitFor(() => {
      expect(onActivateOutcome).toHaveBeenCalledWith(outcome);
    });
    expect(onDefer).not.toHaveBeenCalled();
  });

  it("without a host binding it still shows the message and buttons, and no counts line", async () => {
    hostBindingMock.current = null;
    renderDialog(
      {},
      activateManagement({ kind: "ok", value: { activated: true } }).management,
    );

    expect(await screen.findByText("Work is in progress.")).toBeTruthy();
    expect(screen.queryByTestId("host-busy-work-counts")).toBeNull();
    expect(screen.getByTestId("host-busy-defer")).toBeTruthy();
    expect(screen.getByTestId("host-busy-when-idle")).toBeTruthy();
    expect(screen.getByTestId("host-busy-force")).toBeTruthy();
  });
});

describe("<HostBusyForceDeferDialog /> idleAction", () => {
  function renderBase(
    idleAction: {
      readonly label: string;
      readonly isPending: boolean;
      readonly onClick: () => void;
    } | null,
  ): void {
    render(
      <HostBusyForceDeferDialog
        purpose="update"
        detail={null}
        open
        title="Host is busy"
        message="Busy."
        isForcing={false}
        forceLabel="Force restart"
        forceDestructive
        onForce={vi.fn()}
        onDefer={vi.fn()}
        idleAction={idleAction}
      />,
    );
  }

  it("null renders no when-idle button", async () => {
    renderBase(null);
    await screen.findByText("Busy.");
    expect(screen.queryByTestId("host-busy-when-idle")).toBeNull();
  });

  it("a pending idle action disables all three buttons", async () => {
    renderBase({
      label: "Restart when idle",
      isPending: true,
      onClick: vi.fn(),
    });
    await screen.findByText("Busy.");
    for (const id of [
      "host-busy-defer",
      "host-busy-when-idle",
      "host-busy-force",
    ]) {
      expect(screen.getByTestId(id).hasAttribute("disabled")).toBe(true);
    }
  });
});
