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

import {
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
    ).toBe("Update will continue when 2 sessions finish");
    // Removing the stagedFloor gate would expose Force update for a CLI-floor
    // refusal; this negative affordance pin must turn RED under that ablation.
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
    ).toBe("Update will continue when 2 sessions finish");
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
});
