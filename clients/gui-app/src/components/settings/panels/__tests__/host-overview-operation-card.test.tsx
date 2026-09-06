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
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
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

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
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

function clearStagedManifest(version: string): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-06T00:00:00Z",
    latest: version,
    versions: [
      {
        version,
        releasedAt: "2026-09-06T00:00:00Z",
        releaseNotesUrl: "https://example.invalid/notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: "https://example.invalid/host.tar.gz",
            sizeBytes: 1024,
            sha256: "a".repeat(64),
            signatureUrl: "https://example.invalid/host.tar.gz.minisig",
            signatureAlgorithm: "minisign",
            publicKeyId: "key-1",
          },
        },
      },
    ],
  };
}

function floorStagedManifest(version: string): HostAvailableManifest {
  const manifest = clearStagedManifest(version);
  return {
    ...manifest,
    versions: manifest.versions.map((entry) => ({
      ...entry,
      requiredCliVersion: "1.3.0",
      platforms: {
        "darwin-arm64": {
          ...entry.platforms["darwin-arm64"],
          available: false,
          unavailableReason:
            "Needs Traycer CLI 1.3.0 or newer (this host's CLI is 1.2.0).",
        },
      },
    })),
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

  it("a TERMINAL superseded attempt beside real debt still renders the debt sentence AND Restart (D-49)", async () => {
    // The mounted end of `fleet-update-view.test.ts`'s D-49 pins, and the
    // state D-47 produces: another actor delivered rc.3, this host is still
    // running rc.2, and the executor ended ITS attempt `superseded` - no
    // error, nothing owed on the attempt. The records are the only thing that
    // knows a restart is owed.
    //
    // Falsification: drop the terminal fall-through in `fleet-update-view.ts`
    // and the attempt arm takes the frame, `superseded` projects `idle`,
    // `isQuietUpdateView` hides the card, and BOTH assertions below go red -
    // which is the "nothing on screen after an Updating… toast" outcome the
    // rule exists to prevent.
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
          updateOperation: {
            kind: "attempt" as const,
            attemptId: "a-superseded",
            generation: 1,
            sequence: 4,
            targetVersion: "1.3.0-rc.3",
            trigger: "manual" as const,
            phase: "superseded" as const,
            execution: "terminal" as const,
            continuation: null,
            progress: null,
            liveness: "terminal" as const,
            livenessCause: null,
            busySessionCount: null,
            busyBreakdown: null,
            error: null,
          },
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The card exists at all, which `superseded` -> `idle` would not produce:
    // `idle` is quiet and the Overview renders nothing for it.
    await screen.findByTestId("host-overview-operation-card");
    // And it is the DEBT park's sentence, not the attempt's.
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toBe("Update installed — restart host to finish");
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
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          // Conservative staged-floor gating needs positive evidence for the
          // staged version; an empty manifest means the entry is unknown.
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
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
    expect(card.textContent).toContain("Update waits for 2 sessions to finish");
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
    // Force UPDATE, not the header's force restart: this page can open
    // either verdict in the same dialog, and the purpose attribute is how
    // a pin on the shared test id tells them apart.
    expect(busyDialog.dataset.purpose).toBe("update");
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(installCalls).toEqual([{ version: "1.3.0-rc.3", force: true }]);
    });
  });

  it("hides both force controls when the staged version is explicitly floored", async () => {
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
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: floorStagedManifest("1.3.0-rc.3"),
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByText(
      "Traycer couldn't determine how its command-line tools were installed on host-a.",
    );
    await screen.findByTestId("host-overview-operation-card");
    // The negatives below are half a pin on their own: a card rendered in some
    // other view would also have no force controls. Anchor them to the
    // staged-wait phase they are about.
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toBe("Update waits for 2 sessions to finish");
    // Removing `!updates.stagedEntryOfferable` from the panel's Force gate
    // would expose Force update for this CLI-floor refusal (the floored
    // staged version is not offerable); this negative affordance pin must
    // turn RED under that ablation.
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    // Restoring a non-null onForceRestart for a staged wait would offer a
    // fallback restart control that cannot activate the floored stage; this
    // negative no-restart pin must turn RED under that ablation.
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("hides both force controls when the staged version is absent from the check manifest", async () => {
    let checkCalls = 0;
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
        "host.update.check": () => {
          checkCalls += 1;
          return {
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "explicit-include" as const,
            manifest: {
              ...clearStagedManifest("1.3.0-rc.2"),
              latest: "1.3.0-rc.2",
            },
          };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    await screen.findByText("This host is running the latest version.");
    await waitFor(() => expect(checkCalls).toBeGreaterThan(0));
    // Same anchor as above: the absent controls must be absent FROM the
    // staged-wait card, not from some other view.
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toBe("Update waits for 2 sessions to finish");
    // Treating an absent staged entry as clear would make Force reachable while
    // its floor is unknown; this negative unknown-evidence pin must turn RED.
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
    // Restoring a non-null onForceRestart for a staged wait would offer a
    // fallback restart control that cannot activate the absent stage; this
    // negative no-restart pin must turn RED under that ablation.
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("revalidates a changed staged entry at confirmation and settles refusal synchronously", async () => {
    let checkCalls = 0;
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
        "host.update.check": () => {
          checkCalls += 1;
          return {
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "explicit-include" as const,
            manifest:
              checkCalls === 1
                ? clearStagedManifest("1.3.0-rc.3")
                : floorStagedManifest("1.3.0-rc.3"),
          };
        },
        "host.update.install": (req) => {
          installCalls.push({ version: req.version, force: req.force });
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const queryClient = renderPanel();

    const forceButton = await screen.findByTestId(
      "host-overview-operation-force-update",
    );
    fireEvent.click(forceButton);
    await screen.findByTestId("host-busy-force-defer-dialog");
    await queryClient.invalidateQueries();
    await waitFor(() => expect(checkCalls).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId("host-busy-force"));
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    await waitFor(() => {
      // Removing click-time revalidation would dispatch the stale staged
      // version; this negative mutation pin must turn RED under that ablation.
      expect(installCalls).toEqual([]);
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
      expect(
        screen.getByTestId("host-overview-update-attempt-failed").textContent,
      ).toContain("v1.3.0-rc.3 needs Traycer CLI 1.3.0 or newer on host-a.");
    });
  });

  it("refuses and closes when the staged entry disappears before confirmation", async () => {
    let checkCalls = 0;
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
        "host.update.check": () => {
          checkCalls += 1;
          return {
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "explicit-include" as const,
            manifest:
              checkCalls === 1
                ? clearStagedManifest("1.3.0-rc.3")
                : clearStagedManifest("1.3.0-rc.2"),
          };
        },
        "host.update.install": (req) => {
          installCalls.push({ version: req.version, force: req.force });
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const queryClient = renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    await queryClient.invalidateQueries();
    await waitFor(() => expect(checkCalls).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      // Bypassing describeForceUpdateRefusal would dispatch stale force:true;
      // this no-mutation pin and closed-dialog assertion redden that ablation.
      expect(installCalls).toEqual([]);
      expect(
        screen.getByTestId("host-overview-update-attempt-failed").textContent,
      ).toContain(
        "Traycer couldn't verify that v1.3.0-rc.3 can be installed on host-a.",
      );
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
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
        // Force update renders only once the check proves the staged entry
        // clear of the CLI floor (`stagedEntryOfferable`), same as the positive
        // Force fixture above; without it the button never appears.
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
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
      ).toMatch(/^Last seen: Update waits for/);
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
        // Force update renders only once the check proves the staged entry
        // clear of the CLI floor (`stagedEntryOfferable`), same as the positive
        // Force fixture above; without it the button never appears.
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
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
    const installationReadsByStatusCall: number[] = [];
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
          // WHICH running version this read was issued under, which is the
          // property the pin is actually about. A raw call COUNT is not: the
          // old key has its own 10 s poll, and whether that fires before or
          // after the status response re-keys the query is timer-interleaving,
          // not behaviour — an extra read on a key the observer is about to
          // abandon changes nothing on screen.
          installationReadsByStatusCall.push(statusCalls);
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
    // AT LEAST two, not exactly two: the installation query's own 10 s poll
    // and the status poll that re-keys it fire from the same tick, and their
    // order is not this pin's to assume - when the installation poll lands
    // first it is the second call (served the pending read below) and the
    // re-key is the third. Every call past the first returns the still-pending
    // read, so the count says only that the re-key asked afresh; the
    // load-bearing assertions are the two card checks below.
    await waitFor(() => {
      // A read issued UNDER the new running version — the re-key actually
      // happened — rather than "exactly two reads have happened", which the
      // old key's own poll can make false without changing anything the pin
      // is about.
      expect(
        installationReadsByStatusCall.filter((call) => call > 1),
      ).not.toHaveLength(0);
    });
    expect(installationCalls).toBeGreaterThanOrEqual(2);

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

  it("a failed installation read withdraws the activation-debt park and its Restart - the status leg alone is projected", async () => {
    // Falsification: drop `!installationLive` from the `legacyFacts`
    // derivation in `host-overview-panel.tsx` (back to a bare data check)
    // and the card keeps showing the LAST successful record's debt, with a
    // live Restart, through a read that has since started failing.
    // `canonicalReadIsLive` withdraws on `isError` too, so this pin
    // exercises that arm specifically; the "activation debt + staged wait:
    // an UNUSABLE scope…" pin above exercises the status-leg demotion via
    // `usable`, which is the one that keeps a qualified sentence.
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

    // Debt visible: record rc.3 ahead of the running rc.2 - live, unqualified.
    await screen.findByTestId("host-overview-operation-restart");
    expect(
      screen.getByTestId("host-overview-operation-card").textContent,
    ).not.toContain("Last seen:");

    // The next installation poll throws - the status read keeps succeeding
    // beside it, so this failure is the installation leg's alone. The
    // record leg is WITHDRAWN, not demoted: `host.status` reports no
    // operation, so with no facts there is nothing for the card to show -
    // no "Last seen" sentence, no Restart. (An UNUSABLE scope is the case
    // that keeps the sentence qualified; that demotion travels through the
    // status leg - see the unusable-scope pins. Expiring the whole
    // observation here instead would demote a live attempt on one failed
    // record read.)
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => expect(installationCalls).toBe(2));
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();

    // The next successful poll restores the live park and its control.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toBe("Update installed — restart host to finish");
    });
    await screen.findByTestId("host-overview-operation-restart");

    vi.useRealTimers();
  });

  it("a failed STATUS read withdraws the debt park's Restart while its last-known sentence stays - the offer needs a live status read, the projection keeps the evidence", async () => {
    // The status leg's twin of the installation-read pin above. `legacyFacts`
    // keeps the retained status payload on purpose - its `hostVersion` is
    // what lets the projection render the park qualified - but the OFFERS
    // are gated on `statusLive` (`canonicalReadIsLive` over the status
    // read's health, `usable` included): a Restart pressed off an old
    // `hostVersion` would restart a host that may already have activated.
    // Falsification: gate `onRestart` on `usable` alone again and the
    // Restart below stays pressable under the "Last seen:" sentence.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      overrideHandlers: {
        "host.status": () => {
          statusCalls += 1;
          if (statusCalls > 1) {
            throw new Error("host unreachable");
          }
          return statusWithBusy("1.3.0-rc.2", { kind: "none" }, false, 0);
        },
        "host.getInstallationInfo": () =>
          managedInstallation(installRecord("1.3.0-rc.3", null), null),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Debt visible and live: record rc.3 ahead of the running rc.2.
    await screen.findByTestId("host-overview-operation-restart");
    expect(
      screen.getByTestId("host-overview-operation-card").textContent,
    ).not.toContain("Last seen:");

    // The next status poll throws; the installation read keeps succeeding
    // beside it, so this is the status leg's own failure. The park is
    // DEMOTED, not withdrawn - the retained payload still says what was last
    // seen - and the control that would act on it is gone.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => expect(statusCalls).toBe(2));
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Last seen:");
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();

    vi.useRealTimers();
  });

  it("a failed installation read withdraws the staged-wait park and Force update…, not merely the debt row", async () => {
    // The sibling of the activation-debt pin above, for the OTHER row
    // `legacyFacts` feeds: `deriveLegacyUpdateFacts` computes `activationDebt`
    // and `stagedWait` off the SAME object, so an isError read must withdraw
    // both, not just whichever one an earlier pin happened to check.
    // `host.status` keeps answering the whole time - the busy/session-count
    // sentence and the Force offer both come from ONE `legacyFacts`
    // derivation, so this is still the installation leg's own
    // `!installationLive` gate, not a `host.status`-side demotion (the
    // production doc's other two `canonicalReadIsLive` arms - `paused` and
    // `isStale` - are exercised directly against the function in
    // `canonical-status-observation.test.ts`; this app's queries run with
    // `networkMode: "always"`, so a real installation-read outage always
    // surfaces as `isError` here, per the production comment above
    // `installationLive`).
    //
    // Falsification: drop `!installationLive` from the `legacyFacts`
    // derivation and the card keeps offering Force update… through a read
    // that has started failing.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let installationCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      overrideHandlers: {
        "host.status": () =>
          statusWithBusy("1.3.0-rc.2", { kind: "none" }, true, 2),
        "host.getInstallationInfo": () => {
          installationCalls += 1;
          if (installationCalls === 2) {
            throw new Error("host unreachable");
          }
          return managedInstallation(
            installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
            stagedRecord("1.3.0-rc.3"),
          );
        },
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Positive control: the installation read is fresh, the staged-wait
    // park and Force update… both show, live and unqualified.
    await screen.findByTestId("host-overview-operation-force-update");
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toBe("Update waits for 2 sessions to finish");

    // The next installation poll throws - `host.status` keeps succeeding
    // beside it, so this failure is the installation leg's alone. The
    // sentence is retained and qualified; Force update… is withdrawn.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => expect(installationCalls).toBe(2));
    // Withdrawn, not demoted - see the sibling pin above.
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();

    // The next successful poll restores the live park and Force update….
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toBe("Update waits for 2 sessions to finish");
    });
    await screen.findByTestId("host-overview-operation-force-update");

    vi.useRealTimers();
  });

  it("an OPEN force-update offer stays open while the installation read is merely unobserved - only an OBSERVED record leg that drops the stage closes it", async () => {
    // Companion to "(c4)" (which closes the dialog on `!usable`): a demoted
    // installation read is a DIFFERENT signal from scope reachability. The
    // panel's close guard is `legacyFacts !== null && stagedVersion
    // mismatch` - an unobserved read (`legacyFacts === null`) fails that
    // first clause and leaves the dialog alone, because "we don't know
    // right now" is not "the stage is gone".
    //
    // "Unobserved" is `installationQuery.data === undefined` - which, per
    // the production comment above `installationLive`
    // (`host-overview-panel.tsx`), only arises on first load or when the
    // RUNNING version moves and the install query re-keys onto a fresh,
    // still-pending read (`cacheKeyIdentity: [runningVersion]`). A read that
    // has merely started failing is NOT this: `canonicalReadIsLive` demotes
    // it, but the cache still carries its last successful payload, so
    // `legacyFacts` stays non-null (retained) - the case the sibling pins
    // above pin as a DEMOTION of the sentence, not an absence of facts. This
    // pin therefore drives "unobserved" through a running-version bump
    // whose fresh key is left pending, not through an `isError` read.
    //
    // Falsification: drop the `legacyFacts !== null` guard (close whenever
    // `(legacyFacts?.stagedWait ?? null)?.stagedVersion !== offer.stagedVersion`,
    // treating null facts as a mismatch) and the dialog closes as soon as
    // the running version moves, before the fresh read ever answers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    let installationCalls = 0;
    const installationReadsByStatusCall: number[] = [];
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
            true,
            2,
          );
        },
        "host.getInstallationInfo": () => {
          installationCalls += 1;
          // See the sibling pin above: WHICH running version the read was
          // issued under is the property, not how many reads there were.
          installationReadsByStatusCall.push(statusCalls);
          if (installationCalls === 1) {
            return managedInstallation(
              installRecord("1.3.0-rc.2", "1.3.0-rc.2"),
              stagedRecord("1.3.0-rc.3"),
            );
          }
          // The running version moved (rc.2 -> rc.3) - the install query
          // re-keys onto a fresh key with no cached data, and this read is
          // left pending: "not observed", not failed.
          return secondRead.promise;
        },
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: clearStagedManifest("1.3.0-rc.3"),
        }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");

    // The next `host.status` poll reports the running version moved - the
    // install query re-keys onto a fresh, still-pending read. The dialog
    // stays open through it.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        installationReadsByStatusCall.filter((call) => call > 1),
      ).not.toHaveLength(0);
    });
    // Give any (incorrect) close a render cycle to have taken effect
    // before asserting the dialog is still there.
    await waitFor(() => {
      expect(screen.getByTestId("host-busy-force-defer-dialog")).toBeTruthy();
    });

    // The pending read now answers - an OBSERVED record leg, under the new
    // running version, that no longer carries the offer's stage. THIS is
    // what closes the dialog.
    await act(async () => {
      secondRead.resolve(
        managedInstallation(installRecord("1.3.0-rc.3", "1.3.0-rc.3"), null),
      );
      await secondRead.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    vi.useRealTimers();
  });
});

// `HostOverviewOperationCard` — `onForceRestart` (an ATTEMPT park's Force
// restart…, as opposed to a legacy staged wait's Force update…): gated on
// `legacyFacts !== null && legacyFacts.stagedWait === null` in
// `host-overview-panel.tsx` - an attempt park offers no route to activate a
// stage the records still describe, and an UNOBSERVED record leg does not
// vouch that no stage waits either.
describe("HostOverviewOperationCard — onForceRestart (attempt park)", () => {
  function attemptParkStatus(
    busySessionCount: number,
  ): ResponseOfMethod<HostRpcRegistry, "host.status"> {
    return statusWith(
      attemptOperation({
        phase: "waiting-for-work",
        execution: "active",
        liveness: "active",
        busySessionCount,
      }),
    );
  }

  it("an attempt park with an UNOBSERVED installation read offers no Force restart…", async () => {
    // Falsification: drop the `legacyFacts !== null` half of the gate
    // (offer whenever `stagedWait === null`, treating an unobserved read as
    // "no stage") and the button below appears despite the installation
    // read never having answered.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.status": () => attemptParkStatus(2),
        // Never answers - `legacyFacts` stays "not observed" (`undefined`
        // data), same gate `installationQuery.data === undefined` already
        // gives it, no isError/isStale needed to prove this half.
        "host.getInstallationInfo": () => new Promise(() => {}),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });

  it("an attempt park with an OBSERVED installation read carrying no staged wait offers Force restart…", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      // Default `host.getInstallationInfo` answers `{status: "unmanaged"}` -
      // an OBSERVED read whose `deriveLegacyUpdateFacts` carries a null
      // `stagedWait` (nothing to force-activate a stage into).
      overrideHandlers: {
        "host.status": () => attemptParkStatus(2),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-force-restart");
  });

  it("an attempt park with an OBSERVED staged wait offers no Force restart… - Restart cannot activate a stage", async () => {
    // The staged wait is a LEGACY fact from the records, independent of
    // this attempt's own park - Force restart would relaunch the host
    // without ever installing what the stage still waits to apply.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      installation: managedInstallation(
        installRecord("1.5.0", "1.5.0"),
        stagedRecord("1.6.0"),
      ),
      overrideHandlers: {
        "host.status": () => attemptParkStatus(2),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    expect(
      screen.queryByTestId("host-overview-operation-force-restart"),
    ).toBeNull();
  });
});

describe("HostOverviewOperationCard — capability gates", () => {
  it("Restart is withheld when host.restart is not negotiated, and an OPEN confirm closes the moment it drops out", async () => {
    // The card's controls sit behind the same capability gates as the
    // header's Restart: a method the handshake declined is not offered from
    // the card either. Two halves, two falsifications: drop
    // `restartDegrade === null` from the card's `onRestart` gate in
    // `host-overview-panel.tsx` and the button survives the drop; drop the
    // render-time close on `restartDegrade !== null` and the confirm stays
    // open over a control the page no longer offers.
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

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    await screen.findByTestId("confirm-destructive-dialog");

    // The negotiated set is a subscribed store (`useHostMethodSupport`), so
    // re-recording it under the mounted page is the same signal a
    // re-handshake sends.
    act(() => {
      recordNegotiatedHostMethods(
        "host-a",
        ALL_OVERVIEW_METHODS.filter((method) => method !== "host.restart"),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    // The park itself is still reported - the evidence stays, the dispatch
    // does not.
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toBe("Update installed — restart host to finish");
  });

  it("Force update… is withheld when host.update.install is not negotiated, while the check still runs and the staged entry is offerable", async () => {
    // `installDegrade` retires the updates REGION but leaves the check
    // query enabled, so the manifest still lists the staged version and
    // `stagedEntryOfferable` is true - the only thing between this button
    // and a dispatch the host would refuse is the card's own
    // `updates.degrade !== null` gate. Falsification: drop it from
    // `onForceUpdate` in `host-overview-panel.tsx` and the button renders.
    let checks = 0;
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
        "host.update.check": () => {
          checks += 1;
          return {
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "explicit-include" as const,
            manifest: clearStagedManifest("1.3.0-rc.3"),
          };
        },
      },
    });
    recordNegotiatedHostMethods(
      "host-a",
      ALL_OVERVIEW_METHODS.filter((method) => method !== "host.update.install"),
    );
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain("Update waits for 2 sessions to finish");
    // Wait for the check to answer so the absence is the gate's, not the
    // loading frame's: the same fixture WITH the install method negotiated
    // renders the button once this manifest lands (the dispatch pin above).
    await waitFor(() => expect(checks).toBeGreaterThan(0));
    expect(
      screen.queryByTestId("host-overview-operation-force-update"),
    ).toBeNull();
  });
});
