import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScope,
  HostScopeSelection,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeStatus } from "@/components/settings/host-scope/host-scope-status";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SessionImportScanHandle } from "@/components/session-import/use-session-import-scan";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";

/**
 * The wizard is stubbed exactly as `onboarding-page.test.tsx` and
 * `session-import-wizard.test.tsx` do it: this suite is about which surface
 * (wizard vs. notice) the dialog chooses and what it hands `useSessionImportScan`,
 * not about the wizard's own row/selection behaviour (covered by
 * `session-import-wizard.test.tsx`).
 */
vi.mock("@/components/session-import/session-import-wizard", () => ({
  SessionImportWizard: (props: { readonly scan: SessionImportScanHandle }) => (
    <div
      data-testid="session-import-wizard-stub"
      data-scan-state={props.scan.state.phase}
    />
  ),
}));

/**
 * A recording stub rather than a bare mock: the dialog's own gate
 * (`runIdle && hostReady && scanSupported`) is exactly what this suite has to
 * prove, and the only way to see it from outside is the `active` argument this
 * hook was last called with.
 */
const scanTrackerMock = vi.hoisted(() => {
  const calls: boolean[] = [];
  return {
    calls,
    reset(): void {
      calls.length = 0;
    },
  };
});

vi.mock("@/components/session-import/use-session-import-scan", () => ({
  useSessionImportScan: (active: boolean) => {
    scanTrackerMock.calls.push(active);
    return {
      state: { kind: "scan-stub" },
      dispatch: () => undefined,
    };
  },
}));

/** Driven directly, per host, rather than through the stream transport. */
const scanSupportedMock = vi.hoisted(() => ({ value: true }));

vi.mock("@/hooks/session-import/use-session-import-available", () => ({
  useSessionImportAvailableFor: () => scanSupportedMock.value,
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auth/use-registered-hosts-query")
  >()),
  useRegisteredHostsPollLiveness: () => undefined,
}));

/**
 * The scope the dialog sees, over the selection the dialog itself owns — so a
 * pick made through the real `HostSwitcher` really does re-point the dialog,
 * the same shape `onboarding-page.test.tsx`'s `tourScope` uses.
 */
const hostsMock = vi.hoisted(() => ({
  hosts: [{ hostId: "host-a", connectable: true }] as ReadonlyArray<{
    readonly hostId: string;
    readonly connectable: boolean;
  }>,
  activeHostId: "host-a" as string | null,
}));

/** Overrides the derived status for an explicit pick, for the vanished/unreachable cases. */
const scopeStatusOverrideMock = vi.hoisted(() => ({
  value: null as HostScopeStatus | null,
}));

const hostScopeCallsMock = vi.hoisted(() => ({
  scopedHostIds: [] as Array<string | null>,
}));

/** The status the fixture reports for a pick: the same ladder the real scope walks. */
function scopeStatusFor(
  explicitPick: boolean,
  picked: HostScopeOption | null,
): HostScopeStatus {
  if (!explicitPick) return "following";
  if (picked === null) return "vanished";
  if (scopeStatusOverrideMock.value !== null) {
    return scopeStatusOverrideMock.value;
  }
  return picked.connectable ? "ready" : "unreachable";
}

/** What the picker strip prints: the host's name, or the id a vanished pick still names. */
function scopeLabelFor(
  picked: HostScopeOption | null,
  scopedHostId: string | null,
): string {
  if (picked !== null) return picked.name;
  return scopedHostId ?? "No host";
}

function dialogScope(selection: HostScopeSelection): HostScope {
  hostScopeCallsMock.scopedHostIds.push(selection.scopedHostId);
  const hosts: HostScopeOption[] = hostsMock.hosts.map((entry) =>
    hostScopeOptionFixture({
      hostId: entry.hostId,
      name: entry.hostId,
      connectable: entry.connectable,
    }),
  );
  const activeHostId = hostsMock.activeHostId;
  const explicitPick = selection.scopedHostId !== null;
  const pickedId = explicitPick ? selection.scopedHostId : activeHostId;
  const picked = hosts.find((host) => host.hostId === pickedId) ?? null;
  const status = scopeStatusFor(explicitPick, picked);

  return hostScopeFixture({
    hosts,
    host: picked,
    hostId: picked?.hostId ?? null,
    hostLabel: scopeLabelFor(picked, selection.scopedHostId),
    vanishedHostId: status === "vanished" ? selection.scopedHostId : null,
    activeHostId,
    activeHost: hosts.find((host) => host.hostId === activeHostId) ?? null,
    isViewingActive: !explicitPick || picked?.hostId === activeHostId,
    status,
    setHostId: selection.setScopedHostId,
  });
}

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    useHostScopeFor: (selection: HostScopeSelection) => dialogScope(selection),
  }),
);

// The unary half needs no client here: nothing in this suite reads
// `HostRuntimeContext` beneath the dialog's own re-provider.
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => null,
}));

/**
 * The stream half is this suite's subject alongside the scan gate: it answers
 * only once the transport genuinely names the picked host — `null` (still
 * "connecting", from the picker's point of view) otherwise, reproducing the
 * commit-after-a-pick gap `scoped-host-readiness.ts` documents.
 */
const streamOnHostMock = vi.hoisted(() => ({ hostId: null as string | null }));

const streamBindings = new Map<string, StreamRuntimeBinding>();

function streamBindingFor(hostId: string): StreamRuntimeBinding {
  const existing = streamBindings.get(hostId);
  if (existing !== undefined) return existing;
  const created: StreamRuntimeBinding = {
    wsStreamClient: fakeWsStreamClient(hostId),
    hostId,
    retain: null,
  };
  streamBindings.set(hostId, created);
  return created;
}

function fakeWsStreamClient(
  hostId: string,
): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("not exercised by this suite");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this suite");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    instanceId: `fake-ws-stream-client:${hostId}`,
    onClosed: () => () => undefined,
  };
}

vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: (scope: HostScope) =>
    scope.hostId !== null && scope.hostId === streamOnHostMock.hostId
      ? streamBindingFor(scope.hostId)
      : null,
}));

// Import after every mock is registered.
import { SessionImportDialog } from "@/components/session-import/session-import-dialog";

function renderDialog(props: {
  readonly initialHostId: string | null;
  readonly onClose: (() => void) | undefined;
}) {
  return renderUi(
    <SessionImportDialog
      onClose={props.onClose ?? (() => undefined)}
      initialHostId={props.initialHostId}
    />,
    { wrapper: WithTestQueryClient },
  );
}

function pickHost(hostId: string): void {
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
  fireEvent.click(
    screen.getByTestId(`settings-host-switcher-option-${hostId}`),
  );
}

function lastScanCall(): boolean {
  const last = scanTrackerMock.calls.at(-1);
  if (last === undefined) {
    throw new Error("useSessionImportScan was never called");
  }
  return last;
}

describe("<SessionImportDialog />", () => {
  beforeEach(() => {
    hostsMock.hosts = [{ hostId: "host-a", connectable: true }];
    hostsMock.activeHostId = "host-a";
    scopeStatusOverrideMock.value = null;
    streamOnHostMock.hostId = null;
    scanSupportedMock.value = true;
    scanTrackerMock.reset();
    hostScopeCallsMock.scopedHostIds = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the picker strip and the wizard, and scans immediately, when opened with no pick on a two-host account", () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: true },
    ];

    renderDialog({ initialHostId: null, onClose: undefined });

    expect(screen.getByTestId("session-import-host-picker-row")).not.toBeNull();
    expect(screen.getByTestId("session-import-wizard-stub")).not.toBeNull();
    expect(lastScanCall()).toBe(true);
  });

  it("starts the scope selection on the initialHostId when it names a host other than the active one", () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: true },
    ];
    hostsMock.activeHostId = "host-a";

    renderDialog({ initialHostId: "host-b", onClose: undefined });

    expect(hostScopeCallsMock.scopedHostIds[0]).toBe("host-b");
    expect(screen.getByTestId("settings-host-switcher").textContent).toContain(
      "host-b",
    );
  });

  it("withholds the wizard and shows the connecting notice for the new host while the stream still names the previous one", async () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: true },
    ];
    hostsMock.activeHostId = "host-a";
    // The ambient/scoped stream never catches up to host-a either, matching a
    // dialog that opened following the active host with no transport of its own.
    streamOnHostMock.hostId = null;

    renderDialog({ initialHostId: null, onClose: undefined });
    expect(screen.getByTestId("session-import-wizard-stub")).not.toBeNull();

    pickHost("host-b");

    await waitFor(() => {
      expect(screen.getByTestId("host-scope-connecting")).not.toBeNull();
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
    expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
      "host-b",
    );
    expect(lastScanCall()).toBe(false);
  });

  it("returns the wizard and resumes the active scan once the stream binding names the picked host", async () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: true },
    ];
    hostsMock.activeHostId = "host-a";
    streamOnHostMock.hostId = null;

    const view = renderDialog({ initialHostId: null, onClose: undefined });
    pickHost("host-b");
    await waitFor(() => {
      expect(screen.getByTestId("host-scope-connecting")).not.toBeNull();
    });

    streamOnHostMock.hostId = "host-b";
    view.rerender(
      <SessionImportDialog onClose={() => undefined} initialHostId={null} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("session-import-wizard-stub")).not.toBeNull();
    });
    expect(lastScanCall()).toBe(true);
  });

  it('shows "Can\'t reach <host>" for a picked host whose scope status is unreachable', async () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: false },
    ];
    hostsMock.activeHostId = "host-a";

    // Reached the way Settings' Host Overview opens this dialog directly on a
    // machine, not through the switcher — a non-connectable row is refused
    // there (see the refusal test below), so `initialHostId` is the only path
    // onto an explicitly-picked host that is not reachable.
    renderDialog({ initialHostId: "host-b", onClose: undefined });

    await waitFor(() => {
      expect(
        screen.getByTestId("session-import-host-unavailable").textContent,
      ).toContain("Can't reach host-b");
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
  });

  it('shows "<host> is no longer connected" for a picked host whose scope status is vanished', async () => {
    hostsMock.hosts = [{ hostId: "host-a", connectable: true }];
    hostsMock.activeHostId = "host-a";
    scopeStatusOverrideMock.value = "vanished";

    renderDialog({ initialHostId: "host-b", onClose: undefined });

    await waitFor(() => {
      expect(
        screen.getByTestId("session-import-host-unavailable").textContent,
      ).toContain("host-b is no longer connected");
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
  });

  it('shows "<host> can\'t import sessions" and stops scanning for a ready host whose client does not support session import', async () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: true },
    ];
    hostsMock.activeHostId = "host-a";
    streamOnHostMock.hostId = "host-b";
    scanSupportedMock.value = false;

    renderDialog({ initialHostId: null, onClose: undefined });
    pickHost("host-b");

    await waitFor(() => {
      expect(
        screen.getByTestId("session-import-host-unavailable").textContent,
      ).toContain("host-b can't import sessions");
    });
    expect(screen.queryByTestId("session-import-wizard-stub")).toBeNull();
    expect(lastScanCall()).toBe(false);
  });

  it("calls onClose when the dialog's own close control is used", () => {
    const onClose = vi.fn();
    renderDialog({ initialHostId: null, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("passes every non-connectable host to the switcher as refused, disabling its row", () => {
    hostsMock.hosts = [
      { hostId: "host-a", connectable: true },
      { hostId: "host-b", connectable: false },
    ];
    hostsMock.activeHostId = "host-a";

    renderDialog({ initialHostId: null, onClose: undefined });

    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    const refusedRow = screen.getByTestId(
      "settings-host-switcher-option-host-b",
    );
    expect(refusedRow.getAttribute("aria-disabled")).toBe("true");
    const connectableRow = screen.getByTestId(
      "settings-host-switcher-option-host-a",
    );
    expect(connectableRow.getAttribute("aria-disabled")).not.toBe("true");
  });
});
