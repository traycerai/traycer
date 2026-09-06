// The Overview re-provides a scoped STREAM binding beside its unary one (for
// the Data & migration group), and the real hook reads `useAuthService` -
// which this suite deliberately does not stand up. `null` keeps the panel on
// the ambient stream, the arrangement every assertion below already assumed.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

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

import type { ReactNode } from "react";
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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusUpdateOperation } from "@traycer/protocol/host/status/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostGetInstallationInfoResponseV11 } from "@traycer/protocol/host/maintenance/index";
import type {
  HostInstallRecord,
  HostStagedRecord,
} from "@traycer/protocol/config/installation-records";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

// G5: `HostOverviewOperationCard` renders measured byte progress
// (`host-overview-operation-bytes`) independently of percentage — the
// counterpart to the landing banner's own bytes coverage, since both surfaces
// share `operationProgressBytes`/`showsProgressBar`.

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

// Same `QueryClient`/tree kept alive across a `rerender` - the shape
// `host-overview-lifecycle-gate.test.tsx`'s `renderPanelPersistent` uses -
// so a later mutation of `scopeOverrides.current`/`hostBindingMock.current`
// (a Settings host swap) is observed by the SAME mounted subtree rather than
// torn down and rebuilt with it. A fresh element on every call, not a
// captured/reused one: React bails out of re-rendering a subtree entirely
// when the SAME element reference is passed to `rerender` twice.
function renderPanelPersistent(): { rerender: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = makeRunnerHost();
  const buildTree = (): ReactNode => (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(buildTree());
  return { rerender: () => rerender(buildTree()) };
}

function attemptOperation(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    trigger: "manual",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: null,
    busyBreakdown: null,
    error: null,
    ...overrides,
  };
}

function statusWith(
  operation: HostStatusUpdateOperation,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  };
}

// Same as `statusWith`, but lets the coarse `updateProgress` marker vary
// independently of the attempt record - the shipped legacy `traycer host
// update` path reports `updateOperation: {kind:"none"}` with the marker
// carrying the whole signal, and that is exactly the shape this suite's
// coarse-progress tests below exercise.
function statusWithCoarseProgress(
  operation: HostStatusUpdateOperation,
  updateProgress: ResponseOfMethod<
    HostRpcRegistry,
    "host.status"
  >["updateProgress"],
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return { ...statusWith(operation), updateProgress };
}

// Same shape as `statusWith`, but with `hostVersion`/`busy`/`busySessionCount`
// all explicit - `statusWith` hardcodes `hostVersion: "1.5.0"`, which the
// staged-wait fixture below must NOT inherit: the facts read `busy` and
// `busySessionCount` off this SAME `host.status` reply, and reusing
// `statusWith`'s fixed version would mismatch the fixture's own installed
// record and manufacture a spurious activation debt.
function statusWithBusy(
  hostVersion: string,
  operation: HostStatusUpdateOperation,
  busy: boolean,
  busySessionCount: number,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion,
    protocolVersion: { major: 1, minor: 3 },
    busy,
    busySessionCount,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  };
}

// A pre-@1.3 peer: `updateOperation: null`, exactly what such a host sends -
// it cannot report an attempt record at all, only the coarse marker (unused
// here) and, since this feature, the install/staged records beside it.
function statusOperationNull(
  hostVersion: string,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion,
    protocolVersion: { major: 1, minor: 0 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: null,
    updateTransaction: null,
  };
}

/**
 * The minimum-viable `HostInstallRecord`/`HostStagedRecord` pair for the
 * record-derived park suite below - every field the wire schema requires
 * (`protocol/src/config/installation-records.ts`), populated with benign
 * placeholders except `version`/`runtimeVersion`, which each test varies.
 */
function installRecord(
  version: string,
  runtimeVersion: string | null,
): HostInstallRecord {
  return {
    installId: "install-1",
    version,
    runtimeVersion,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-08-10T00:00:00Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    signatureKeyId: "key-1",
    sizeBytes: 1024,
    executablePath: `/tmp/traycer/${version}/host`,
    executableSha256: "b".repeat(64),
  };
}

function stagedRecord(version: string): HostStagedRecord {
  return {
    schemaVersion: 1,
    stageId: null,
    version,
    runtimeVersion: null,
    archiveSha256: "a".repeat(64),
    sizeBytes: 1024,
    source: { kind: "registry", value: version },
    signatureKeyId: "key-1",
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    platform: "darwin",
    arch: "arm64",
    executableSha256: "b".repeat(64),
  };
}

function managedInstallation(
  install: HostInstallRecord,
  staged: HostStagedRecord | null,
): HostGetInstallationInfoResponseV11 {
  return {
    status: "managed",
    installRecord: install,
    stagedRecord: staged,
    cliManifest: null,
  };
}

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.useRealTimers();
});

describe("HostOverviewOperationCard — measured byte progress (G5)", () => {
  it("bytes-only (percent absent) renders host-overview-operation-bytes and keeps the bar indeterminate", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(
            attemptOperation({
              progress: {
                percent: null,
                bytes: 80_000_000,
                totalBytes: 200_000_000,
              },
            }),
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    const bytesEl = await screen.findByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    await screen.findByTestId("update-progress-indeterminate");
  });

  it("percent + bytes both present render together", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(
            attemptOperation({
              progress: {
                percent: 40,
                bytes: 80_000_000,
                totalBytes: 200_000_000,
              },
            }),
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    const bytesEl = await screen.findByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-card").textContent,
      ).toContain("40%");
    });
    await screen.findByTestId("update-progress-determinate");
  });

  it("a RETAINED (stale) attempt shows no bar at all once the read goes unhealthy, even though it still carries measured bytes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            return statusWith(
              attemptOperation({
                progress: {
                  percent: null,
                  bytes: 80_000_000,
                  totalBytes: 200_000_000,
                },
              }),
            );
          }
          throw new Error("host unreachable");
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The live baseline: the bar IS present while the read is healthy, so the
    // retained case below is a genuine transition rather than a card that
    // never draws a bar at all.
    await screen.findByTestId("update-progress-indeterminate");

    // Advance past the 10s `host.status` poll so the same query refetches and
    // fails, retaining the last (active) response.
    await vi.advanceTimersByTimeAsync(11_000);

    await waitFor(() => {
      expect(screen.queryByTestId("update-progress-indeterminate")).toBeNull();
      expect(screen.queryByTestId("update-progress-determinate")).toBeNull();
    });
    // The measured bytes are a claim about the past ("Last seen: …") and stay
    // on screen; only the animated bar withdraws.
    const bytesEl = screen.getByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    vi.useRealTimers();
  });
});

// The coarse `updateProgress` marker, carried BESIDE `updateOperation:
// {kind:"none"}` - the shipped legacy `traycer host update` path's whole
// vocabulary for "in flight" or "just failed". Before this field was wired
// through, a @1.3 host running that path rendered as "Host is up to date"
// (the pre-fix `idle` card) on the very Overview whose Update had just
// started - the incident `isQuietUpdateView`'s gate exists to prevent.
describe("HostOverviewOperationCard - the coarse updateProgress marker beside {kind:'none'}", () => {
  it("updateOperation:{kind:'none'} with no coarse marker renders no card and no stale 'Host is up to date' text", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        // The live version differs from the registry copy (`1.5.0`) on
        // purpose: the header renders the process's own answer once
        // `host.status` has settled, so its appearance is the proof that
        // the SAME reply carrying `{kind:"none"}` + no marker is on screen.
        "host.status": () => ({
          ...statusWithCoarseProgress({ kind: "none" }, null),
          hostVersion: "1.5.0-live",
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The card is also absent while the status query is still loading, so
    // the absence is asserted only after a render derived from the status
    // reply is on screen. (The fixture's own call counter is bypassed by an
    // overridden handler, and a counted call proves the request, not the
    // render.)
    await screen.findByText(/1\.5\.0-live/);
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    expect(screen.queryByText(/Host is up to date/i)).toBeNull();
  });

  it("updateOperation:{kind:'none'} + coarse {state:'updating'} renders the card with 'Updating host' and an indeterminate bar", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWithCoarseProgress(
            { kind: "none" },
            { state: "updating", error: null },
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain("Updating host");
    await screen.findByTestId("update-progress-indeterminate");
  });

  it("updateOperation:{kind:'none'} + coarse {state:'failed', error} renders the card with 'Update failed: <error>'", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWithCoarseProgress(
            { kind: "none" },
            { state: "failed", error: "health probe failed" },
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain("Update failed: health probe failed");
  });
});

// The two record-derived parks (`legacy-update-facts.ts`), mounted end to
// end through `HostSettingsPanel`: the Overview derives `legacyFacts` from
// `host.getInstallationInfo` beside `host.status`, and the card renders
// exactly one control per park - Restart for activation debt, Force update…
// for a staged wait blocked on live work.
describe("HostOverviewOperationCard — record-derived parks", () => {
  it("activation debt (kind:'none' peer) renders the restart sentence and ONLY the Restart control", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.3", null),
        null,
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, false, 0),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain(
      "Update installed — restart host to finish",
    );
    await screen.findByTestId("host-overview-operation-restart");
    // Falsification: gating `onForceUpdate` on the view kind instead of the
    // `stagedWait` fact, or gating `onForceRestart`'s button on the wrong
    // predicate, would put one of these on screen beside Restart.
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("host-overview-operation-restart"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restart host?");
  });

  it("SAME activation debt under a pre-1.3 peer (updateOperation: null) - Restart still renders", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.3", null),
        null,
      ),
      overrideHandlers: {
        "host.status": () => statusOperationNull("1.3.0-rc.2"),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain(
      "Update installed — restart host to finish",
    );
    await screen.findByTestId("host-overview-operation-restart");

    fireEvent.click(screen.getByTestId("host-overview-operation-restart"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restart host?");
  });

  it("a coarse 'failed' marker beside debt keeps the failure text AND still offers Restart - real evidence is not papered over", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.3", null),
        null,
      ),
      overrideHandlers: {
        "host.status": () => ({
          ...statusWithBusy("1.3.0-rc.2", { kind: "none" }, false, 0),
          updateProgress: { state: "failed", error: "health probe failed" },
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain("Update failed: health probe failed");
    // Falsification: keying `onRestart` off `view.kind === "waiting-to-activate"`
    // instead of the `activationDebt` fact would make this null once the
    // coarse marker outranked the park's own kind.
    await screen.findByTestId("host-overview-operation-restart");
  });

  it("staged wait renders the blocked-sessions sentence and Force update…, dispatching host.update.install with force:true on confirm", async () => {
    const installCalls: Array<{ version: string; force: boolean }> = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
        stagedRecord("1.3.0-rc.3"),
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, true, 2),
        "host.update.install": (req) => {
          installCalls.push({ version: req.version, force: req.force });
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain(
      "Update will continue when 2 sessions finish",
    );
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    const busyDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(busyDialog).toBeTruthy();
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(installCalls).toEqual([{ version: "1.3.0-rc.3", force: true }]);
    });
  });

  it("no park (install matches running, host idle, nothing staged) - no card at all", async () => {
    // Regression pin. Falsification: `legacyFactsView` (or the panel's own
    // `legacyFacts` derivation) returning a non-null park here would put the
    // card back on screen for a host with nothing to report.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      installation: managedInstallation(installRecord("1.5.0", "1.5.0"), null),
      overrideHandlers: {
        "host.status": () => statusWith({ kind: "none" }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Wait for a render derived from the status/installation reply before
    // asserting absence, exactly as the sibling "no coarse marker" test above
    // does - otherwise the assertion would pass vacuously during the loading
    // frame.
    await screen.findByText(/1\.5\.0/);
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
  });

  it("activation debt + staged wait: an UNUSABLE scope keeps the sentence (qualified as retained) but withdraws Restart", async () => {
    // Mirrors `host-overview-lifecycle-gate.test.tsx`'s (c2): the retained
    // record-derived facts survive an unusable scope (nothing about the
    // READ changes - same cached `host.status`/`host.getInstallationInfo`
    // responses), but `hasLiveSource`/`connected` (both wired to `usable`)
    // demote the projection to `unknown` with a retained `lastKnownKind`,
    // which `describeUpdateOperation` renders as an inline "Last seen: …"
    // qualification (`carriesQualificationInline`) rather than the separate
    // `(last known)` marker - so the phase sentence itself is the proof of
    // qualification here, exactly as (c2) reads it for the live attempt. The
    // panel's own `!usable` guard on `onRestart` (`host-overview-panel.tsx`)
    // withdraws the control entirely rather than merely disabling it - the
    // same rule (c2) pins for the header actions.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.3", null),
        null,
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, false, 0),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanelPersistent();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain(
      "Update installed — restart host to finish",
    );
    expect(card.textContent).not.toContain("Last seen:");
    await screen.findByTestId("host-overview-operation-restart");

    // Nothing about the read changes - only the scope stops being usable,
    // the way a negotiated peer going unreachable would leave it.
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "unreachable",
    };
    panel.rerender();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toBe("Last seen: Update installed — restart host to finish");
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
  });

  it("staged wait: an UNUSABLE scope keeps the sentence (qualified as retained) but withdraws Force update…", async () => {
    // Doubly guaranteed here, unlike the Restart case above: `offersForceRestart`
    // (`fleet-update-view.ts`) requires `view.kind === "waiting-for-work"`,
    // and the SAME demotion that qualifies the sentence also flips `view.kind`
    // to `unknown` - so the button's absence is not a clean isolation of the
    // panel's own `!usable` guard on `onForceUpdate` the way the Restart
    // button's absence isolates its `!usable` guard (that one has no
    // `view.kind`-based gate of its own). Both guards agree here; this pins
    // the observable requirement (no dispatch route on an unusable scope),
    // not which of the two guards is doing the work for THIS control.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
        stagedRecord("1.3.0-rc.3"),
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, true, 2),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanelPersistent();

    await screen.findByTestId("host-overview-operation-force-update");

    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "unreachable",
    };
    panel.rerender();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toMatch(/^Last seen: Update will continue when/);
    });
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
  });

  it("(c4) an OPEN force-update offer CLOSES when the scope turns unusable — the withdrawal of the Force update… control, one commit late", async () => {
    // Companion to `host-overview-lifecycle-gate.test.tsx`'s (c3), for the
    // OTHER dialog `host-overview-panel.tsx`'s `!usable` rule closes:
    // `if (!usable && forceUpdateOffer !== null) setForceUpdateOffer(null);`.
    // The sibling test above ("staged wait ... withdraws Force update…")
    // pins that the CONTROL disappears on an unusable scope; this pins the
    // stronger claim - an offer already OPEN before the scope turned
    // unusable does not survive either, because confirming it would dispatch
    // `host.update.install {force: true}` over a client the scope no longer
    // vouches for. Falsification: comment out that `if` in the panel and the
    // final `waitFor` below goes red while the dialog stays on screen.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: managedInstallation(
        installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
        stagedRecord("1.3.0-rc.3"),
      ),
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, true, 2),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanelPersistent();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");

    // Control: rerendering with the scope still usable keeps the dialog
    // open — otherwise the assertion below would prove nothing about
    // `usable` specifically.
    panel.rerender();
    expect(screen.getByTestId("host-busy-force-defer-dialog")).toBeTruthy();

    // THE FIX: the scope turns unusable — same predicate the sibling test
    // above demotes the phase sentence and withdraws the control on — and
    // the already-open offer closes, one commit late.
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "unreachable",
    };
    panel.rerender();

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
  });
});

/**
 * A settable promise, so a fixture handler can hold `host.getInstallationInfo`
 * pending until the test is ready to resolve it - the deferred install read
 * these two pins each gate on a call count.
 */
function deferredInstallationResponse(): {
  readonly promise: Promise<HostGetInstallationInfoResponseV11>;
  readonly resolve: (value: HostGetInstallationInfoResponseV11) => void;
} {
  let resolve: (value: HostGetInstallationInfoResponseV11) => void = () => {
    throw new Error("resolve called before assignment");
  };
  const promise = new Promise<HostGetInstallationInfoResponseV11>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// `useHostInstallationInfoQuery` (`host-overview-rpc.ts`): keyed by the
// RUNNING version the caller has observed (`cacheKeyIdentity: [runningVersion]`)
// and disabled until one is known. Both pins ablate by reverting to the OLD
// shape - no key, no gate - which is exactly what let a record fetched under
// the PREVIOUS running version answer a comparison against a version that has
// since moved.
describe("HostOverviewOperationCard — installation query keyed by running version", () => {
  it("a running-version change does not compare the OLD install record against the NEW version", async () => {
    // Falsification: drop `cacheKeyIdentity: [runningVersion]` from
    // `useHostInstallationInfoQuery` (set `undefined`) and the SAME query
    // keeps serving the rc.2 install record while `host.status` already
    // reports rc.3 - the debt card renders "v1.3.0-rc.2 is installed" for a
    // host that has already moved past it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    let installationCalls = 0;
    const secondRead = deferredInstallationResponse();
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => {
          statusCalls += 1;
          return statusWithBusy(
            statusCalls === 1 ? "1.3.0-rc.2" : "1.3.0-rc.3",
            { kind: "none" },
            false,
            0,
          );
        },
        "host.getInstallationInfo": () => {
          installationCalls += 1;
          if (installationCalls === 1) {
            return managedInstallation(installRecord("1.3.0-rc.2", null), null);
          }
          // The read for the NEW key (running = rc.3) is slow/pending -
          // exactly the window a stale, unkeyed cache entry would otherwise
          // paper over with the rc.2 answer.
          return secondRead.promise;
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Baseline: install matches the running rc.2 - no debt.
    await screen.findByText(/1\.3\.0-rc\.2/);
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();

    // Advance past the 10s `host.status` poll: the host reports rc.3, and the
    // installation query re-keys onto a fresh, still-pending read.
    await vi.advanceTimersByTimeAsync(11_000);
    await screen.findByText(/1\.3\.0-rc\.3/);
    await waitFor(() => expect(installationCalls).toBe(2));

    // While that fresh read is pending, there is nothing to compare against -
    // "not observed", never a debt derived from the OLD rc.2 record.
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();

    // Resolve it with the record a real host would now report - matching the
    // new running version - and the card stays absent.
    await act(async () => {
      secondRead.resolve(
        managedInstallation(installRecord("1.3.0-rc.3", null), null),
      );
      await secondRead.promise;
    });
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();

    vi.useRealTimers();
  });

  it("a failed installation read hides the record-derived facts", async () => {
    // Falsification: remove `|| installationQuery.isError` from the
    // `legacyFacts` gate in `host-overview-panel.tsx` and the card keeps
    // showing the LAST successful record's debt through a read that has
    // since started failing.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let installationCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, false, 0),
        "host.getInstallationInfo": () => {
          installationCalls += 1;
          if (installationCalls === 2) {
            throw new Error("host unreachable");
          }
          return managedInstallation(installRecord("1.3.0-rc.3", null), null);
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Debt visible: record rc.3 ahead of the running rc.2.
    await screen.findByTestId("host-overview-operation-restart");

    // The next installation poll throws - the status read keeps succeeding
    // beside it, so this failure is the installation leg's alone.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => expect(installationCalls).toBe(2));
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });

    // The next successful poll brings the debt card back.
    await vi.advanceTimersByTimeAsync(11_000);
    await screen.findByTestId("host-overview-operation-restart");

    vi.useRealTimers();
  });
});
