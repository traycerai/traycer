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
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  openHostOverviewAdvanced,
  openHostOverviewMenu,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
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

async function waitForButton(name: string | RegExp): Promise<HTMLElement> {
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
// B. Sticky updates degrade — the whole region retires
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
    // The check TRACKS the install's discovery. Discovering the refusal kicks
    // an immediate re-check whose fresh answer owns recovery, so a fixture
    // whose check kept answering ok would model an impossible host — install
    // and check shell the same CLI — and that re-check's ok would then
    // LEGITIMATELY un-retire the region, turning this pin into a race on
    // whether the assertion or the refetch settles first.
    let cliGone = false;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve(
            cliGone
              ? { outcome: "cli-unavailable" as const }
              : {
                  outcome: "ok" as const,
                  effectiveIncludePreReleases: false,
                  includePreReleasesSource: "stable-default" as const,
                  manifest: updateCheckManifest("1.6.0"),
                },
          ),
        "host.update.install": () => {
          cliGone = true;
          return Promise.resolve({ outcome: "cli-unavailable" as const });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    await openHostOverviewAdvanced();
    fireEvent.click(await waitForButton(/^Install \d/));

    expect(
      await screen.findByTestId("host-overview-updates-degraded"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
      expect(screen.queryByTestId("host-overview-version-picker")).toBeNull();
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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
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
    await openHostOverviewAdvanced();
    fireEvent.click(await waitForButton(/^Install \d/));

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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
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
    await openHostOverviewAdvanced();
    fireEvent.click(await waitForButton(/^Install \d/));

    expect(
      await screen.findByTestId("host-overview-update-attempt-failed"),
    ).toBeTruthy();
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();
    expect(screen.getByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.getByTestId("host-overview-update-check")).toBeTruthy();
    expect(screen.getByTestId("host-overview-version-picker")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// C. Labeled-host no-op rename
// ---------------------------------------------------------------------------

describe("<HostSettingsPanel /> Overview rename — a labeled host's untouched draft is not dirty", () => {
  it("an untouched draft issues no write, and typing the systemName stores an override rather than clearing", async () => {
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
    const input = await screen.findByTestId<HTMLInputElement>(
      "host-overview-name-input",
    );
    // Seeded with the LABEL (`effectiveName`), not the systemName — a
    // `TRAYCER_HOST_LABEL` host has no override, so the draft opens on the
    // label the host is actually showing.
    expect(input.value).toBe("Build Box");

    // COMMITTING AN UNTOUCHED DRAFT WRITES NOTHING. This is what the disabled
    // Save button used to assert, and it survived the editor becoming an inline
    // input — it is now enforced twice over, by `useInlineRename` skipping an
    // unchanged commit and by `submitRename`'s own no-op guard. Worth keeping
    // because the write is not harmless: storing the current effective name as
    // an explicit `customName` FREEZES a label that would otherwise keep
    // tracking the host.
    fireEvent.keyDown(input, { key: "Enter" });
    // The absence must not be read in the same tick it was created: the write
    // path runs through a mutation, so a regressed guard's `host.identity.set`
    // reaches the fixture a task later. Settle the editor close, then flush a
    // full macrotask so a queued write would have LANDED before the zero-read.
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-name-input")).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.identitySetCalls()).toBe(0);

    // Must not regress: a genuinely different name writes.
    fireEvent.click(await waitForButton("Edit name"));
    const changed = await screen.findByTestId<HTMLInputElement>(
      "host-overview-name-input",
    );
    fireEvent.change(changed, { target: { value: "Studio Two" } });
    fireEvent.keyDown(changed, { key: "Enter" });
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
    const reopened = await screen.findByTestId<HTMLInputElement>(
      "host-overview-name-input",
    );
    fireEvent.change(reopened, { target: { value: "buildbox-01" } });
    fireEvent.keyDown(reopened, { key: "Enter" });
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
    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
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

  // Rewritten when `host.update.check` became a QUERY that fires on mount.
  //
  // The old pin was `otherHostCalls === 0` — no second call at all — which only
  // held because the check was imperative and nothing but a click could start
  // one. Under an automatic read, host-b asking for itself is the FEATURE, so
  // that assertion would now fail for the right reason, and asserting it still
  // would pin the page shut against the change it was rewritten for.
  //
  // What survives is the invariant the arm-time capture actually protects: one
  // host's answer must never be displayed under another host's name. The two
  // fixtures return DIFFERENT versions so the rendered sentence names which host
  // answered, and host-a's parked reply is released LAST, after the page has
  // already moved on.
  it("host.update.check: a late answer never lands on the host the page moved to", async () => {
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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.7.0"),
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

    // No click: mounting the page IS the request now. It parks on the gate.
    await screen.findByText("Checking for updates…");
    expect(armedHostCalls).toBe(0);

    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    // host-b asks for ITSELF, which is the whole point of an automatic check.
    await waitFor(() => {
      expect(otherHostCalls).toBe(1);
    });
    await screen.findByText("v1.7.0 is available.");

    // Now let host-a reply, long after the page stopped being about host-a.
    await act(async () => {
      releaseCheck?.();
      await gate;
    });
    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    // THE PIN: host-a's manifest is not on screen, and host-b's still is.
    expect(screen.queryByText("v1.6.0 is available.")).toBeNull();
    expect(screen.getByText("v1.7.0 is available.")).toBeTruthy();
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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
          }),
        "host.update.install": async () => {
          await gate;
          armedHostCalls += 1;
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.install": () => {
          otherHostCalls += 1;
          return Promise.resolve({
            outcome: "accepted" as const,
            attemptId: null,
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
    await openHostOverviewAdvanced();
    fireEvent.click(await waitForButton(/^Install \d/));
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

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
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
