// Same boundary as the sibling Overview suites: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up a host runtime.
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

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
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

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

const ALL_OVERVIEW_METHODS = [
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

function scopeFrom(
  hostId: string,
  fixture: OverviewHostFixture,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
}

function makeRunnerHost(): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

async function waitForButton(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name });
}

function renderPanel(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// B. Sticky cloud-pin-only updates degrade — the whole region retires
// ---------------------------------------------------------------------------

describe("<HostSettingsPanel /> Overview updates region — sticky vs transient degrade", () => {
  it("check-side cli-unavailable retires the WHOLE region, Check-now included", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({ outcome: "cli-unavailable" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));

    expect(
      await screen.findByTestId("host-overview-updates-degraded"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-updates")).toBeNull();
  });

  it("install-side cli-unavailable retires the region too — Check-now disappears with it", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          }),
        "host.update.install": () =>
          Promise.resolve({ outcome: "cli-unavailable" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    fireEvent.click(await waitForButton("Update to v1.6.0"));

    expect(
      await screen.findByTestId("host-overview-updates-degraded"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
      expect(screen.queryByTestId("host-overview-update-install")).toBeNull();
    });
  });

  it("externally-managed on install retires the region the same way", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          }),
        "host.update.install": () =>
          Promise.resolve({ outcome: "externally-managed" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    fireEvent.click(await waitForButton("Update to v1.6.0"));

    expect(
      await screen.findByTestId("host-overview-updates-degraded"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    });
  });

  it("counter-pin: cli-failed on install is a bad ATTEMPT, not a sticky degrade — region and controls stay", async () => {
    // Without this, a "retire the region on any non-ok outcome" implementation
    // would pass all three cases above just as well as the correct one.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          }),
        "host.update.install": () =>
          Promise.resolve({ outcome: "cli-failed" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    fireEvent.click(await waitForButton("Update to v1.6.0"));

    expect(
      await screen.findByTestId("host-overview-update-attempt-failed"),
    ).toBeTruthy();
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();
    expect(screen.getByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.getByTestId("host-overview-update-check")).toBeTruthy();
    expect(screen.getByTestId("host-overview-update-install")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// C. Labeled-host no-op rename
// ---------------------------------------------------------------------------

describe("<HostSettingsPanel /> Overview rename — a labeled host's untouched draft is not dirty", () => {
  it("Save stays disabled on an untouched draft, issues no write, and typing the systemName stores an override rather than clearing", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      systemName: "buildbox-01",
      customName: null,
      effectiveName: "Build Box",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByText("Build Box");
    fireEvent.click(await waitForButton("Edit name"));
    const input = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Display Name",
    });
    // Seeded with the LABEL (`effectiveName`), not the systemName — a
    // `TRAYCER_HOST_LABEL` host has no override, so the draft opens on the
    // label the host is actually showing.
    expect(input.value).toBe("Build Box");
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);

    // Belt and braces on the disabled button: clicking it anyway must not
    // issue a write. jsdom already refuses the click on a disabled control,
    // so this mostly documents the invariant the disabled state exists for.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fixture.identitySetCalls()).toBe(0);

    // Must not regress: a genuinely different name enables Save and writes.
    fireEvent.change(input, { target: { value: "Studio Two" } });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fixture.identitySetCalls()).toBe(1);
    });
    expect(fixture.identity().customName).toBe("Studio Two");
    expect(fixture.identity().effectiveName).toBe("Studio Two");

    // The pin: typing the machine's own SYSTEM name must not be treated as
    // "clear the override" the way the local CLI-bridge rule treats it — the
    // host owns the label, and `customNameFromIdentityDraft` stores it as a
    // real override instead.
    fireEvent.click(await waitForButton("Edit name"));
    const reopened = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Display Name",
    });
    fireEvent.change(reopened, { target: { value: "buildbox-01" } });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fixture.identitySetCalls()).toBe(2);
    });
    expect(fixture.identity().customName).toBe("buildbox-01");
  });
});

// ---------------------------------------------------------------------------
// D. Arm-time capture pins — the four RPCs the mutations suite left uncovered
// ---------------------------------------------------------------------------

describe("<HostSettingsPanel /> Overview arm-time capture — the remaining RPCs", () => {
  it("host.doctor: a scope move mid-flight does not redirect the request to the new host", async () => {
    let releaseDoctor: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseDoctor = resolve;
    });
    let armedHostCalls = 0;
    let otherHostCalls = 0;
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.doctor": async () => {
          await gate;
          armedHostCalls += 1;
          return {
            status: "ok" as const,
            issues: [],
            triviallyGreenIssueCodes: [],
          };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "host.doctor": () => {
          otherHostCalls += 1;
          return Promise.resolve({
            status: "ok" as const,
            issues: [],
            triviallyGreenIssueCodes: [],
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    // Opening the sheet IS the request: `HostDoctorRpcCard` runs Doctor once
    // on mount.
    fireEvent.click(await waitForButton("Run doctor"));
    await screen.findByText("Running Doctor…");

    // Move the scope to another host WHILE the request is still parked.
    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseDoctor?.();
      await gate;
    });

    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    expect(otherHostCalls).toBe(0);
  });

  it("host.update.check: a scope move mid-flight does not redirect the request to the new host", async () => {
    let releaseCheck: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let armedHostCalls = 0;
    let otherHostCalls = 0;
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.check": async () => {
          await gate;
          armedHostCalls += 1;
          return {
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.check": () => {
          otherHostCalls += 1;
          return Promise.resolve({
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    fireEvent.click(await waitForButton("Check now"));
    await waitFor(() => {
      expect(armedHostCalls).toBe(0); // still parked on the gate
    });

    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseCheck?.();
      await gate;
    });

    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    expect(otherHostCalls).toBe(0);
  });

  it("host.update.install: a scope move mid-flight does not redirect the request to the new host", async () => {
    let releaseInstall: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    let armedHostCalls = 0;
    let otherHostCalls = 0;
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            manifest: {
              schemaVersion: 1 as const,
              generatedAt: "2026-08-12T00:00:00Z",
              latest: "1.6.0",
              versions: [],
            },
          }),
        "host.update.install": async () => {
          await gate;
          armedHostCalls += 1;
          return { outcome: "accepted" as const };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.install": () => {
          otherHostCalls += 1;
          return Promise.resolve({ outcome: "accepted" as const });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    fireEvent.click(await waitForButton("Check now"));
    fireEvent.click(await waitForButton("Update to v1.6.0"));
    await waitFor(() => {
      expect(armedHostCalls).toBe(0); // still parked on the gate
    });

    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseInstall?.();
      await gate;
    });

    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    expect(otherHostCalls).toBe(0);
  });

  it("diagnostics.logs.tail (Doctor's Show-logs fix): a scope move mid-flight does not redirect the request to the new host", async () => {
    const logsIssue: HostDoctorIssue = {
      code: "STALE_LOG_CHECK",
      severity: "info",
      title: "Check the host's own log",
      message: "Nothing wrong yet — this just offers the tail.",
      fixAction: "host-logs",
      terminalCommand: null,
      details: null,
    };
    let releaseLogs: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseLogs = resolve;
    });
    let armedHostCalls = 0;
    let otherHostCalls = 0;
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.doctor": () =>
          Promise.resolve({
            status: "ok" as const,
            issues: [logsIssue],
            triviallyGreenIssueCodes: [],
          }),
        "diagnostics.logs.tail": async () => {
          await gate;
          armedHostCalls += 1;
          return {
            status: "available" as const,
            target: "host" as const,
            path: "/tmp/host-a.log",
            lines: ["host-a line"],
            truncated: false,
          };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "diagnostics.logs.tail": () => {
          otherHostCalls += 1;
          return Promise.resolve({
            status: "available" as const,
            target: "host" as const,
            path: "/tmp/host-b.log",
            lines: ["host-b line"],
            truncated: false,
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    fireEvent.click(await waitForButton("Run doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-STALE_LOG_CHECK"),
    );
    await waitFor(() => {
      expect(armedHostCalls).toBe(0); // still parked on the gate
    });

    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseLogs?.();
      await gate;
    });

    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    expect(otherHostCalls).toBe(0);
    // No DOM assertion beyond this: `HostSettingsPanelInner` is keyed by
    // `scope.hostId` (clone-not-migrate), so the scope move above already
    // unmounted the tree that armed this request — the same reason the
    // `host.restart` and `host.identity.set` pins in
    // `host-overview-mutations.test.tsx` stop at their call counters instead
    // of asserting on post-move UI. What matters, and what the counters
    // above prove, is that the already-in-flight request stayed bound to the
    // client it was armed against and never reached host-b's handler.
  });
});
