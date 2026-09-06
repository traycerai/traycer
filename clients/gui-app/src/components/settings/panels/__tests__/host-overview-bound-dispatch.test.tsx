// Ticket 06 D8/D17: the bound update dispatches (`host.update.activate` /
// `host.update.continue`), dispatch OWNERSHIP (the per-host `updateDispatch`
// slot), and the one-shot activation dialog auto-open.
//
// A SIBLING to `host-overview-updates.test.tsx` rather than an addition to
// it: that file is already ~2850 lines and organised around the legacy
// install/picker surface, while every pin here is about the newer bound-
// dispatch machinery (`host-overview-rpc.ts`'s `useHostUpdateActivate` /
// `useHostUpdateContinue`, `host-service-write-latch-store.ts`'s dispatch
// slot, and `host-overview-panel.tsx`'s `deriveActivationAutoOpen` /
// `deriveAttemptControl`). Keeping it separate means a reader chasing one
// mechanism does not have to wade through the other's fixtures.
//
// Harness lifted from the throwaway `zz-smoke-tmp.test.tsx` proof (now
// deleted) and from `host-overview-updates.test.tsx`'s `renderPanel` /
// `panelElement` split, which pin (h) below needs to remount over the SAME
// `QueryClient`.

vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostScope: () => hostScopeFixture(scopeOverrides.current) };
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

import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/index";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusUpdateOperation } from "@traycer/protocol/host/status/index";
import type { HostGetInstallationInfoResponseV11 } from "@traycer/protocol/host/maintenance/index";
import type {
  HostInstallRecord,
  HostStagedRecord,
} from "@traycer/protocol/config/installation-records";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostQueryKeys } from "@/lib/query-keys";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  resetHostServiceWriteLatchesForTest,
  useHostServiceWriteLatchStore,
} from "@/components/settings/panels/host-service-write-latch-store";
import * as latchStoreModule from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  openHostOverviewMenu,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

/** Every method the Overview reads, PLUS the two bound update dispatches. */
const METHODS_WITH_BOUND = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "host.update.activate",
  "host.update.continue",
  "diagnostics.logs.tail",
] as const;

/** The pre-cutover manifest — no `host.update.activate` / `.continue`. */
const METHODS_WITHOUT_BOUND = [
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

function record(hostId: string, methods: readonly string[]): void {
  recordNegotiatedHostMethods(hostId, methods);
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of methods) manifest[method] = { major: 1, minor: 0 };
  manifest["host.update.install"] = { major: 1, minor: 2 };
  recordNegotiatedHostManifest(hostId, manifest);
}

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

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function panelElement(client: QueryClient): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

function renderPanel(): RenderResult & { readonly queryClient: QueryClient } {
  const queryClient = newQueryClient();
  return { ...render(panelElement(queryClient)), queryClient };
}

function attempt(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "a1",
    generation: 1,
    sequence: 1,
    targetVersion: "1.6.0",
    trigger: "manual",
    phase: "preparing",
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

/** The (a)/(b)/(c) sequence's three `host.status` frames, by phase. */
function sequencePinOperation(
  phase: "idle" | "preparing" | "parked",
): HostStatusUpdateOperation {
  if (phase === "idle") return { kind: "none" };
  if (phase === "preparing") return attempt({});
  return attempt({
    phase: "waiting-to-activate",
    execution: "parked",
    sequence: 4,
    busySessionCount: 2,
  });
}

/** Pin (d)'s three `host.status` frames: idle, a stale a0, then a1 parked. */
function ackRaceOperation(
  phase: "idle" | "a0" | "a1-parked",
): HostStatusUpdateOperation {
  if (phase === "idle") return { kind: "none" };
  if (phase === "a0") return attempt({ attemptId: "a0", phase: "preparing" });
  return attempt({
    attemptId: "a1",
    phase: "waiting-to-activate",
    execution: "parked",
    sequence: 4,
    busySessionCount: 2,
  });
}

function installRecord(version: string): HostInstallRecord {
  return {
    installId: "install-1",
    version,
    runtimeVersion: null,
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

async function restartMenuButton(): Promise<HTMLElement> {
  await openHostOverviewMenu();
  return screen.getByTestId("host-overview-restart");
}

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HostOverviewPanel — bound-dispatch sequence: accept, park, auto-open, Defer, Restart (a/b/c)", () => {
  it("accepted a1 -> preparing (latch released) -> waiting-to-activate a1 opens the dialog with no click; Defer keeps it closed on the next identical poll; the card's Restart reopens it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase: "idle" | "preparing" | "parked" = "idle";
    const activateCalls: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          // ⚠ THE PIN: the preparing frames MUST also carry the coarse
          // `updateProgress: {state:"updating"}` marker. Falsifies: dropping
          // this from the fixture would leave `updateInstallAcceptedAt`
          // armed (no `view.updateProgress.state === "updating"` frame ever
          // releases it — see `host-overview-panel.tsx`'s effect beside that
          // latch), so "preparing frames released the latch" reddens exactly
          // as the ticket's own ablation names it.
          updateProgress:
            phase === "preparing"
              ? { state: "updating" as const, error: null }
              : null,
          busyBreakdown: null,
          updateOperation: sequencePinOperation(phase),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.install": () => {
          phase = "preparing";
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
        "host.update.activate": (req) => {
          activateCalls.push(req);
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    // (a), first half: the preparing frames release the accepted latch and
    // the page keeps polling — no dialog yet, nothing parked.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Preparing");
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // (a), second half: parked — the dialog opens WITH NO CLICK.
    phase = "parked";
    await vi.advanceTimersByTimeAsync(11_000);
    await screen.findByTestId("host-busy-force-defer-dialog");

    // (b): Defer, then the next poll with the SAME `waiting-to-activate a1`
    // frame — stays closed. Falsifies: dropping the `autoOpenedFor` write
    // (the ticket's own first ablation) — without it this poll would
    // re-satisfy `deriveActivationAutoOpen` and reopen the dialog.
    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // (c): the card's own Restart reopens it — `attemptControl.intent ===
    // "activate"` routes `onRestart` to `openBoundOffer`, which does not
    // consult `autoOpenedFor` at all (that guard is the AUTO-open's alone).
    fireEvent.click(screen.getByTestId("host-overview-operation-restart"));
    await screen.findByTestId("host-busy-force-defer-dialog");

    // Force from THIS reopened dialog dispatches the bound activate.
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(activateCalls).toEqual([{ attemptId: "a1", force: true }]);
    });
  });
});

describe("HostOverviewPanel — dispatch ownership: ACK racing the cache, an un-owned park, and already-updating (d/e/f)", () => {
  it("(d) an ACK for a1 while host.status still reports a DIFFERENT attempt (a0) keeps the slot — the dialog opens once a1 is later seen parked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Falsifies: clearing the slot on ANY different attempt id regardless of
    // `seen` (the ticket's own ablation) — that would drop the a1 slot the
    // moment the a0 frame arrived and this test's final `findByTestId` would
    // time out.
    //
    // Starts `idle` so `host.status` reports nothing active — a live a0
    // attempt from the very first render would hold the lifecycle gate and
    // DISABLE "Update now" before this test ever gets to click it. `a0` only
    // appears in the poll AFTER the dispatch, standing in for the ordinary
    // race between an accept and a `staleTime`-cached read of a DIFFERENT,
    // pre-existing attempt.
    let phase: "idle" | "a0" | "a1-parked" = "idle";
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          // Releases the accepted latch the moment a0 is observed, exactly
          // as the (a) sequence's own preparing frames do — otherwise
          // `updateGatePending` stays true for the full 60s bounded timer
          // and `deriveActivationAutoOpen`'s `gateArmed` check refuses the
          // eventual a1 park regardless of the slot.
          updateProgress:
            phase === "a0" ? { state: "updating" as const, error: null } : null,
          busyBreakdown: null,
          updateOperation: ackRaceOperation(phase),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        // The ACK names a1 while `host.status` keeps answering a0 for the
        // next polls — the ordinary race between the accept and the poll.
        "host.update.install": () => {
          phase = "a0";
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateDispatch,
      ).not.toBeNull();
    });
    // Two polls still serving a0 — the slot (attemptId a1, seen:false) must
    // survive both, since a0 is "old news" until a1 is seen.
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // a1 is finally observed, parked — the slot's `seen` flips and the
    // auto-open condition is satisfied for the FIRST time.
    phase = "a1-parked";
    await vi.advanceTimersByTimeAsync(11_000);
    await screen.findByTestId("host-busy-force-defer-dialog");
  });

  it("(e) a park for an attempt this page never dispatched (b2) opens no dialog", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: attempt({
            attemptId: "b2",
            phase: "waiting-to-activate",
            execution: "parked",
            busySessionCount: 2,
          }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Falsifies: `deriveActivationAutoOpen` reached without a `dispatch !==
    // null` guard — this page never dispatched anything (`updateDispatch`
    // stays null for host-a), so a park that was already there on load must
    // never open a modal nobody asked for.
    await screen.findByTestId("host-overview-operation-phase");
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });

  it("(f) already-updating {attemptId: a1} records no slot — a1 later parking still opens nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase: "idle" | "a1-parked" = "idle";
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation:
            phase === "idle"
              ? { kind: "none" as const }
              : attempt({
                  attemptId: "a1",
                  phase: "waiting-to-activate",
                  execution: "parked",
                  busySessionCount: 2,
                }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.install": () => ({
          outcome: "already-updating" as const,
          attemptId: null,
        }),
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateDispatch ?? null,
      ).toBeNull();
    });

    // a1 later parks anyway (someone else's dispatch, or a pre-existing
    // park) — with no slot recorded for it, nothing opens.
    phase = "a1-parked";
    await vi.advanceTimersByTimeAsync(11_000);
    await screen.findByTestId("host-overview-operation-phase");
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });
});

describe("HostOverviewPanel — dispatch ownership: unusable scope and unmount-before-settle (g/h)", () => {
  it("(g) an otherwise-qualifying slot (seen, matching incarnation) opens nothing while the scope is unreachable", async () => {
    // The auto-open decision is `deriveActivationAutoOpen`, a private
    // function of `host-overview-panel.tsx` with no export — so the slot's
    // OWN half of "otherwise qualifying" (seen, this mount's incarnation) is
    // set up directly against the exported dispatch store rather than
    // through a real dispatch, and `newOverviewIncarnation` is pinned so the
    // manufactured slot names the SAME incarnation the mounted panel
    // registers.
    //
    // ⚠ HONEST LIMIT, stated so nobody later reads more into this pin than it
    // carries: `deriveActivationAutoOpen`'s `!input.usable` clause is NOT
    // independently falsifiable through the mounted panel, and deleting that
    // clause alone leaves this test green. `usable` is
    // `isHostScopeUsable(scope.status) && client !== null`, and the same
    // predicate gates the `host.status` query, so an unusable scope has no
    // live view to offer either — while the record leg, which IS still read
    // for a local host, can only ever project `restarting` or `unknown` and
    // never the `waiting-to-activate` the auto-open requires. The clause is
    // defence in depth over a state the wiring already forecloses. What this
    // pin does hold is the OUTCOME the ticket's invariant names — no bound
    // dispatch surfaces on an unusable scope — against the compound
    // condition, which is what would actually regress if either half moved.
    const FIXED_INCARNATION = "fixed-incarnation-g";
    vi.spyOn(latchStoreModule, "newOverviewIncarnation").mockReturnValue(
      FIXED_INCARNATION,
    );
    useHostServiceWriteLatchStore.getState().armUpdateDispatch("host-a", {
      attemptId: "a1",
      incarnation: FIXED_INCARNATION,
    });
    useHostServiceWriteLatchStore
      .getState()
      .observeUpdateDispatchFrame("host-a", {
        attemptId: "a1",
        terminal: false,
      });
    expect(
      useHostServiceWriteLatchStore.getState().byHost["host-a"]?.updateDispatch
        ?.seen,
    ).toBe(true);

    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => {
          throw new Error("host unreachable — no live route in this fixture");
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "unreachable",
    };
    renderPanel();

    await screen.findByTestId("host-overview-edit-name").catch(() => {
      // An unreachable scope withdraws the header entirely — absence here is
      // itself part of what this pin proves, so a missing element is not an
      // error to surface, only a fact to not wait forever on.
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });

  it("(h) unmounting before host.update.install settles, then remounting: no auto-open, the latch still settles, the reads still invalidate, and Restart still works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    interface AcceptedInstallResponse {
      readonly outcome: "accepted";
      readonly attemptId: string;
    }
    const deferredInstall: {
      resolve: ((value: AcceptedInstallResponse) => void) | null;
    } = { resolve: null };
    const install = new Promise<AcceptedInstallResponse>((resolve) => {
      deferredInstall.resolve = resolve;
    });
    let phase: "idle" | "preparing" = "idle";
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress:
            phase === "preparing"
              ? { state: "updating" as const, error: null }
              : null,
          busyBreakdown: null,
          updateOperation:
            phase === "idle" ? { kind: "none" as const } : attempt({}),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.install": () => install,
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    // A real `gcTime`, unlike every other pin's `newQueryClient()`: this test
    // needs the `host.status` / `host.getInstallationInfo` queries to SURVIVE
    // the unmount below long enough for the settle's invalidation to have
    // something to mark. `gcTime: 0` (this suite's usual default, for fast
    // cleanup between tests) would garbage-collect them the instant the last
    // observer unsubscribes, which is exactly what this pin's own unmount
    // does — and the assertion would pass or fail for the wrong reason.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstMount = render(panelElement(queryClient));

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    // Dispatched, still pending — `host.update.install` has not answered.
    firstMount.unmount();

    // Falsifies: gating the latch settlement / read invalidation on the
    // incarnation (the ticket's own ablation) — that would leave both
    // stranded when the settle for a retired mount runs, which is exactly
    // what this resolves next.
    phase = "preparing";
    deferredInstall.resolve?.({ outcome: "accepted", attemptId: "a1" });
    await waitFor(() => {
      const statusQueries = queryClient.getQueryCache().findAll({
        queryKey: hostQueryKeys.methodScope("host-a", "host.status"),
      });
      expect(statusQueries.some((query) => query.state.isInvalidated)).toBe(
        true,
      );
    });

    // The ownership WRITE, in contrast, must NOT have happened for the
    // retired mount: its incarnation was deregistered on unmount, so
    // `settleUpdateDispatch`'s `isLiveOverviewIncarnation` check refuses it.
    expect(
      useHostServiceWriteLatchStore.getState().byHost["host-a"]
        ?.updateDispatch ?? null,
    ).toBeNull();

    // Remount over the SAME query client — a fresh incarnation, the same
    // cache. No auto-open: the slot the first mount would have owned was
    // never armed.
    render(panelElement(queryClient));
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Preparing");
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // The latch itself settles on the remount's own effect (a fresh
    // `updating` frame releases it — see `host-overview-panel.tsx`).
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateInstallAcceptedAt ?? null,
      ).toBeNull();
    });

    // The page's Restart still works: the incarnation gate is scoped to the
    // dispatch SLOT alone, exactly as the ticket's scope table states. The
    // attempt itself finishing is what releases the LIFECYCLE gate (a
    // `preparing` attempt legitimately disables the header while it runs,
    // same as G1's own matrix) — clear it here to prove the page as a whole
    // is not bricked by the earlier unmount, not to re-test the gate itself.
    phase = "idle";
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(async () => {
      expect(
        (await screen.findByTestId("host-overview-edit-name")).hasAttribute(
          "disabled",
        ),
      ).toBe(false);
    });
    fireEvent.click(await restartMenuButton());
    await screen.findByTestId("confirm-destructive-dialog");
  });
});

describe("HostOverviewPanel — the dialog's Force bypasses the catalog gate (i), and a stage-less waiting-for-work Force (j)", () => {
  it("(i) the dialog's Force dispatches host.update.activate {attemptId: a1, force: true} even though the catalog lacks the attempt's target version", async () => {
    const activateCalls: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: attempt({
            phase: "waiting-to-activate",
            execution: "parked",
            targetVersion: "1.6.0",
            busySessionCount: 2,
          }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        // The catalog does NOT list "1.6.0" — the attempt's own target.
        // Falsifies: routing the dialog's Force through `installForce`
        // (the ticket's own ablation) — `installForce` would call
        // `describeForceUpdateRefusal`, find no entry for "1.6.0", and show
        // #1756's refusal notice instead of dispatching.
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("9.9.9"),
        }),
        "host.update.activate": (req) => {
          activateCalls.push(req);
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // This park was never dispatched by this page (`updateDispatch` is
    // null), so no dialog opens by itself — reached instead via the card's
    // own Restart, which routes through `attemptControl` regardless of
    // ownership (see the (a)/(c) pin for the auto-open path).
    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(screen.queryByText(/Traycer couldn't verify/)).toBeNull();

    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(activateCalls).toEqual([{ attemptId: "a1", force: true }]);
    });
  });

  it("(j) a waiting-for-work attempt with NO staged record and a positive busySessionCount shows Force update… and dispatches host.update.continue", async () => {
    const continueCalls: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      // Unmanaged: no staged record at all — the case `installForce` cannot
      // express, which is the whole reason `continueAttempt` exists.
      installation: { status: "unmanaged" as const },
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: true,
          // ⚠ THE PIN: a POSITIVE reported count. Falsifies: forgetting that
          // `offersForceRestart` still gates the control on a positive
          // host-reported count — the ticket's own note that this rule was
          // NOT changed by this cutover. A `null` or zero count here would
          // hide "Force update…" even though `attemptControl` names the
          // continuation.
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: attempt({
            phase: "waiting-for-work",
            execution: "parked",
            targetVersion: "1.6.0",
            busySessionCount: 2,
          }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.continue": (req) => {
          continueCalls.push(req);
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(continueCalls).toEqual([{ attemptId: "a1", force: true }]);
    });
  });
});

describe("HostOverviewPanel — a host without the two methods keeps the legacy routes (k)", () => {
  it("activation debt still opens the cooperative restart confirmation, never the bound dialog", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.2.0",
      installation: managedInstallation(installRecord("1.2.1"), null),
    });
    record("host-a", METHODS_WITHOUT_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // No auto-open and no bound dispatch reachable: `updates.activate` /
    // `updates.continueAttempt` are both `null` for this host, and this
    // legacy-facts park carries no `attemptId` at all, so
    // `deriveAttemptControl` returns `null` regardless.
    await screen.findByText("v1.2.1 is installed — restart host to finish.");
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("host-overview-operation-restart"));
    await screen.findByTestId("confirm-destructive-dialog");
  });

  it("an ATTEMPT-reporting host whose manifest lacks the methods offers NO activation route at all — no control, no dialog, no dispatch", async () => {
    // The cohort the method gate actually exists for, and the one the two
    // pins around it cannot reach: a host new enough to report a schema-v2
    // attempt (so `deriveAttemptControl` HAS an `attemptId` to work with) but
    // whose handshake never negotiated `host.update.activate`. The
    // legacy-facts cases beside this one return `null` from
    // `deriveAttemptControl` before the gate is consulted at all, so they stay
    // green whether or not it exists.
    //
    // What this host correctly offers is NOTHING. The frame declares
    // `authority: "attempt"`, which suppresses the legacy activation-debt
    // route the previous pin uses (the install record below is present and
    // deliberately ignored), and the bound route is gated off — so the card
    // renders no Restart control rather than one that leads somewhere the
    // transport would refuse.
    //
    // Falsifies: carrying the intent as a REQUEST FIELD instead of as its own
    // method (the ticket's own ablation). With nothing to negotiate, every
    // host reads as capable, `deriveAttemptControl` names the activation, and
    // `onRestart` becomes `openBoundOffer` — the control reappears and this
    // pin's first assertion reddens.
    const activateCalls: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.2.0",
      installation: managedInstallation(installRecord("1.2.1"), null),
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.2.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: attempt({
            phase: "waiting-to-activate",
            execution: "parked",
            targetVersion: "1.2.1",
            busySessionCount: 2,
          }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        // Registered so "never called" is a fact about the page's routing and
        // not about a handler that was missing anyway.
        "host.update.activate": (request) => {
          activateCalls.push(request);
          return { outcome: "accepted" as const, attemptId: "a1" };
        },
      },
    });
    record("host-a", METHODS_WITHOUT_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-phase");
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    expect(activateCalls).toEqual([]);
  });

  it("a staged wait still dispatches host.update.install {force: true} through the legacy Force route", async () => {
    // The WHOLE request, not a projection of it. `toEqual` against the exact
    // two-field shape is what makes this pin falsify "carry the intent as a
    // request field instead of a method": an added `intent` (or any other
    // field smuggled onto the legacy install) reddens here, where recording
    // only `version` and `force` would have swallowed it.
    const installCalls: unknown[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      busy: true,
      busySessionCount: 1,
      hostVersion: "1.2.0",
      installation: managedInstallation(
        installRecord("1.2.0"),
        stagedRecord("1.3.0"),
      ),
      overrideHandlers: {
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.3.0"),
        }),
        "host.update.install": (request) => {
          installCalls.push(request);
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    record("host-a", METHODS_WITHOUT_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(installCalls).toEqual([{ version: "1.3.0", force: true }]);
    });
  });
});

describe("HostOverviewPanel — the bound methods' cli-failed and dispatch-indeterminate copy (l/m)", () => {
  it("(l) cli-failed {reason: cli-too-old} toasts the CLI-too-old copy and releases the accepted latch", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: false,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: attempt({
            phase: "waiting-to-activate",
            execution: "parked",
            busySessionCount: 2,
          }),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
        "host.update.activate": () => ({
          outcome: "cli-failed" as const,
          reason: "cli-too-old" as const,
        }),
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "This computer's Traycer CLI is too old to resume the update. Update the CLI, then try again.",
      );
    });
    // The page-wide gate is not held by a refusal: `settleUpdateDispatch`'s
    // `refused` arm releases `updateInstallAcceptedAt` unconditionally, so
    // the version rows / Update now are not disabled by it.
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateInstallAcceptedAt ?? null,
      ).toBeNull();
    });
    expect(
      screen
        .queryByRole("button", { name: "Update now" })
        ?.hasAttribute("disabled"),
    ).not.toBe(true);
  });

  it("(m) dispatch-indeterminate reasons map to their own sentences, and an unknown reason keeps the generic one with the reason named", async () => {
    const scenarios: ReadonlyArray<{
      readonly reason: string;
      readonly expected: string;
    }> = [
      { reason: "nothing-to-do", expected: "host-a is already up to date." },
      {
        reason: "recovered-complete",
        expected: "The last update already finished.",
      },
      { reason: "recovered-failed", expected: "The last update failed." },
      {
        reason: "refused-attempt-gone",
        expected:
          "The host changed while the update was being prepared. Try again.",
      },
      {
        reason: "refused-something-else",
        expected:
          "Couldn't confirm the update started on host-a: refused-something-else. Watching for progress.",
      },
    ];

    for (const scenario of scenarios) {
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        overrideHandlers: {
          "host.update.check": () => ({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
          }),
          "host.update.install": () => ({
            outcome: "dispatch-indeterminate" as const,
            reason: scenario.reason,
          }),
        },
      });
      record("host-a", METHODS_WITH_BOUND);
      hostBindingMock.current = { hostClient: fixture.client };
      scopeOverrides.current = scopeFrom("host-a", fixture);
      renderPanel();

      fireEvent.click(
        await screen.findByRole("button", { name: "Update now" }),
      );
      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith(scenario.expected);
      });

      cleanup();
      resetHostServiceWriteLatchesForTest();
      resetNegotiatedManifests();
      scopeOverrides.current = {};
      hostBindingMock.current = null;
      vi.clearAllMocks();
    }
  });
});
