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
  act,
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
import { STALE_ATTEMPT_CLOSED_SUFFIX } from "@traycer/protocol/config/host-update-ack-reason";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { BoundDispatchResponse } from "@/components/settings/panels/host-overview-rpc";
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
  openHostOverviewAdvanced,
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
  // BOTH, and in this order. `restoreAllMocks` undoes spies (pin (g)'s
  // `newOverviewIncarnation`), but the `toast` doubles come from this file's
  // `vi.mock` factory — they are plain `vi.fn()`s that no restore touches, so
  // their call history would otherwise accumulate across the whole suite and a
  // "was never called" assertion would be reading the previous test's toast.
  vi.clearAllMocks();
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
    // retired mount: unmounting ran the panel's incarnation DISPOSER, which
    // retires the token from `liveOverviewIncarnations`, so
    // `settleUpdateDispatch`'s `isLiveOverviewIncarnation` check refuses it.
    // (Nothing here concerns `host.service.deregister`, which is a different
    // mechanism that clears the slot for its own reason — see the pin for it.)
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

describe("HostOverviewPanel — an accepted host-service deregister clears the dispatch slot (cold review C, F2)", () => {
  it("clears the slot, so a re-register under the same hostId does not inherit the removed service's activation offer", async () => {
    // THE PIN. The slot's fourth clear. `host.service.deregister` removes the
    // service the dispatch was made about; `hostId` is a stable string, so
    // installing the service again reuses it — and without this clear the
    // freshly registered service's first `waiting-to-activate a1` frame is
    // read as this page's own dispatch parking, and opens a dialog about an
    // attempt belonging to a service that no longer exists.
    //
    // Falsifies: dropping the `clearUpdateDispatch` from
    // `useHostServiceDeregister`'s accepted arm (`host-overview-rpc.ts`).
    // Without it the slot survives, `seen` flips on the frame below, and the
    // dialog opens.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Four phases, and the middle two are what make the page ANSWERABLE when
    // the deregister is clicked. `preparing` carries the coarse marker that
    // releases the accepted latch and flips the slot's `seen`; `quiet` then
    // reports `{kind: "none"}`, which drops the lifecycle gate — an active
    // attempt disables the service controls, exactly as it should — while
    // deliberately PRESERVING the slot, since a frame naming no attempt is not
    // a different attempt (`nextDispatchSlot`). So by the deregister the slot
    // is armed, seen, and the only thing standing between this page and an
    // auto-open is the clear under test.
    let phase: "idle" | "preparing" | "quiet" | "parked" = "idle";
    const statusOperation = (): HostStatusUpdateOperation => {
      if (phase === "quiet") return { kind: "none" };
      return sequencePinOperation(phase);
    };
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
          updateOperation: statusOperation(),
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
      },
    });
    record("host-a", [
      ...METHODS_WITH_BOUND,
      "host.service.status",
      "host.service.register",
      "host.service.deregister",
    ]);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateDispatch ?? null,
      ).not.toBeNull();
    });

    // Let the preparing frame land (latch released, `seen` flipped), then let
    // the attempt fall quiet so the page is not gated by a live update.
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateDispatch?.seen,
      ).toBe(true);
    });
    phase = "quiet";
    await vi.advanceTimersByTimeAsync(11_000);

    await openHostOverviewAdvanced();
    fireEvent.click(
      await screen.findByTestId("host-overview-service-deregister"),
    );
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateDispatch ?? null,
      ).toBeNull();
    });

    // The service comes back under the same id and its attempt parks. With no
    // slot there is nothing to own it, so nothing opens.
    phase = "parked";
    await vi.advanceTimersByTimeAsync(11_000);
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
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

  it("(m2) the BOUND dispatch's own indeterminate and already-updating arms toast info, not the cli-failed error, and release the latch", async () => {
    // Pin (m) below drives every reason through `host.update.install`, which
    // reaches `classifyInstallOutcome` — a different function from the one the
    // bound methods use. So deleting `handleBoundDispatchOutcome`'s
    // `dispatch-indeterminate` / `already-updating` arms left nothing red:
    // both outcomes would fall through to the `cli-failed` tail below them and
    // toast an ERROR with `response.reason` read off an arm that has none.
    //
    // Falsifies: exactly that deletion. Both arms are routed through
    // `host.update.activate` here, and the assertions separate `toast.info`
    // from `toast.error` rather than just checking a string.
    const scenarios: ReadonlyArray<{
      readonly label: string;
      readonly response: BoundDispatchResponse;
      readonly expected: string;
      /**
       * Whether this outcome RELEASES the page-wide accepted latch, which is a
       * real difference between the two and not incidental: an indeterminate
       * dispatch means nothing is known to be running, so holding lifecycle
       * controls shut would be locking the page on a guess; `already-updating`
       * means an update genuinely IS running, and the latch stays armed until
       * a coarse `updating` frame supersedes it exactly as an accept's would.
       */
      readonly releasesLatch: boolean;
    }> = [
      {
        label: "dispatch-indeterminate",
        response: {
          outcome: "dispatch-indeterminate" as const,
          reason: "recovered-complete",
        },
        expected: "The last update already finished.",
        releasesLatch: true,
      },
      {
        // Q26, on the BOUND arm. Pin (m) drives the install call site; this
        // row is the only one that shows the bound one strips too, which is
        // the difference between one shared decider and a second copy of the
        // arms that would pass (m) while reading
        // "Couldn't confirm the update started on host-a:
        // nothing-to-do-stale-attempt-closed" here.
        label: "dispatch-indeterminate, suffixed",
        response: {
          outcome: "dispatch-indeterminate" as const,
          reason: `nothing-to-do${STALE_ATTEMPT_CLOSED_SUFFIX}`,
        },
        expected:
          "host-a is already up to date. An interrupted update record was also cleaned up.",
        releasesLatch: true,
      },
      {
        label: "already-updating",
        response: { outcome: "already-updating" as const, attemptId: "a1" },
        expected: "host-a is already installing an update.",
        releasesLatch: false,
      },
    ];

    for (const scenario of scenarios) {
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
          "host.update.activate": () => scenario.response,
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
        expect(toast.info).toHaveBeenCalledWith(scenario.expected);
      });
      // The arm below these two in `handleBoundDispatchOutcome` is
      // `cli-failed`, and falling into it is the precise regression — so the
      // absence of an error toast is half of what this pin asserts.
      expect(vi.mocked(toast.error).mock.calls).toEqual([]);
      const latchAfter = (): number | null =>
        useHostServiceWriteLatchStore.getState().byHost["host-a"]
          ?.updateInstallAcceptedAt ?? null;
      if (scenario.releasesLatch) {
        await waitFor(() => {
          expect(latchAfter()).toBeNull();
        });
      } else {
        expect(latchAfter()).not.toBeNull();
      }

      cleanup();
      resetHostServiceWriteLatchesForTest();
      resetNegotiatedManifests();
      scopeOverrides.current = {};
      hostBindingMock.current = null;
      vi.clearAllMocks();
    }
  });

  /**
   * Q26. The copy is decided on the BASE reason, so a decline that also closed
   * a stranded attempt reads as the same answer it would have read without the
   * closure, plus at most one clause.
   *
   * WHAT THE SUFFIXED HALF OF THIS TABLE IS. It tests the DECISION FUNCTION,
   * not a census of what hosts emit. Only `nothing-to-do` is producible
   * suffixed today: the suffix rides the selector's reason on a `released`
   * outcome, and the other five bases are minted on paths that structurally
   * refuse it (the `recovered-*` pair is projected from a `terminalized`
   * segment, which is the other outcome kind; the `refused-*` three are minted
   * under conditions that are the negation of the gate that appends). That
   * census is the CLI's, at `44d4b9615` — it is not a promise about a host,
   * and the grammar permits the suffix on any base, which is why every base is
   * pinned. Do not read these rows as evidence that those declines arrive
   * suffixed in production.
   *
   * Same distinction the null-target rows in `host-update-operation-copy` had
   * to be retitled for: a pin can have correct coverage and a false
   * description, and the description is what the next reader reasons from.
   */
  it("(m) copy is decided on the base reason — each base reads the same plain or suffixed — and a suffixed decline adds the closure clause except where the lead sentence is already about a concluded record", async () => {
    const HOST_CHANGED =
      "The host changed while the update was being prepared. Try again.";
    const CLOSURE_CLAUSE = "An interrupted update record was also cleaned up.";
    const bases: ReadonlyArray<{
      readonly base: string;
      readonly lead: string;
      /**
       * Whether the suffixed form appends the closure clause. False on the two
       * recovery arms and only there: their lead sentence is already about a
       * record being concluded, so the clause would narrate one event twice.
       */
      readonly clauseOnSuffix: boolean;
    }> = [
      {
        base: "nothing-to-do",
        lead: "host-a is already up to date.",
        clauseOnSuffix: true,
      },
      {
        base: "recovered-complete",
        lead: "The last update already finished.",
        clauseOnSuffix: false,
      },
      {
        base: "recovered-failed",
        lead: "The last update failed.",
        clauseOnSuffix: false,
      },
      {
        base: "refused-attempt-gone",
        lead: HOST_CHANGED,
        clauseOnSuffix: true,
      },
      {
        base: "refused-unverifiable",
        lead: HOST_CHANGED,
        clauseOnSuffix: true,
      },
      {
        base: "refused-install-changed",
        lead: HOST_CHANGED,
        clauseOnSuffix: true,
      },
    ];

    const scenarios: ReadonlyArray<{
      readonly reason: string;
      readonly expected: string;
      /** Whether this sentence is allowed to show the wire suffix. */
      readonly showsSuffix: boolean;
    }> = [
      ...bases.flatMap((row) => [
        { reason: row.base, expected: row.lead, showsSuffix: false },
        {
          reason: `${row.base}${STALE_ATTEMPT_CLOSED_SUFFIX}`,
          expected: row.clauseOnSuffix
            ? `${row.lead} ${CLOSURE_CLAUSE}`
            : row.lead,
          showsSuffix: false,
        },
      ]),
      // The DIAGNOSTIC arm, both forms. An unenumerated reason keeps the
      // generic sentence with the reason named — and names it UNSTRIPPED,
      // which is the one place the suffix is meant to reach the eye: this
      // sentence exists to be pasted into a support thread, so it reports the
      // raw vocabulary the host used. It adds no clause either, for the same
      // reason the recovery arms do not: the string already says it.
      {
        reason: "refused-something-else",
        expected:
          "Couldn't confirm the update started on host-a: refused-something-else. Watching for progress.",
        showsSuffix: false,
      },
      {
        reason: `refused-something-else${STALE_ATTEMPT_CLOSED_SUFFIX}`,
        expected: `Couldn't confirm the update started on host-a: refused-something-else${STALE_ATTEMPT_CLOSED_SUFFIX}. Watching for progress.`,
        showsSuffix: true,
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
        expect(vi.mocked(toast.info).mock.calls.length).toBeGreaterThan(0);
      });
      const message = vi.mocked(toast.info).mock.calls.at(-1)?.[0];

      // Asserted BEFORE the sentence, because it is the fact that separates a
      // decided sentence from the generic one, and it is the whole signature
      // of the regression this pin watches: comparing the raw reason drops
      // every suffixed decline into the diagnostic arm, where the suffix
      // reaches the eye. A row that only compared the full string would go red
      // there too, but would not say WHY.
      expect(
        typeof message === "string" &&
          message.includes(STALE_ATTEMPT_CLOSED_SUFFIX),
      ).toBe(scenario.showsSuffix);
      expect(message).toBe(scenario.expected);

      cleanup();
      resetHostServiceWriteLatchesForTest();
      resetNegotiatedManifests();
      scopeOverrides.current = {};
      hostBindingMock.current = null;
      vi.clearAllMocks();
    }
  });

  it("(m3) the imported suffix constant IS the wire string, so a protocol rename reddens here rather than in production", () => {
    // Pin (m) builds every suffixed reason FROM the constant, which is what
    // keeps a second spelling of the suffix out of gui-app — and is also why
    // pin (m) alone cannot tell a rename from a rewrite: rename the constant
    // and those rows agree with the new value while a real host keeps sending
    // the old one. This row is the other half. It is the only place in gui-app
    // that spells the suffix out.
    expect(STALE_ATTEMPT_CLOSED_SUFFIX).toBe("-stale-attempt-closed");
  });
});

/**
 * The bound control behind the page's OWN gates (ticket 08).
 *
 * `main` gave the card's three legacy controls a live status read plus the
 * two page-wide gates the header's Restart and the region's Update now take
 * (`restartDegrade` / `updates.degrade`, `anyPending`); the reconciliation
 * puts the bound control behind the same two, because a control whose confirm
 * the render-time rules would close in the same commit is not a control.
 *
 * A live STATUS read is deliberately not pinned here as a fourth case: the
 * projector already demotes a stale wire observation to `unknown`, so
 * `deriveAttemptControl` finds no `waiting-to-activate` kind to key on and
 * the control is gone before `statusLive` is consulted. Passing `statusLive`
 * rather than `usable` is the uniform statement of a rule the view enforces,
 * not an independently falsifiable guard, and a pin claiming otherwise would
 * be green under its own ablation.
 */
describe("HostOverviewPanel — the bound control takes the page's gates (ticket 08)", () => {
  /** The parked `waiting-to-activate` frame these three pins all render. */
  function parkedActivationFixture(
    overrides: Record<string, unknown>,
  ): OverviewHostFixture {
    return buildOverviewHostFixture({
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
        ...overrides,
      },
    });
  }

  it("(n1) the page-wide gate WITHDRAWS the bound Restart while it is armed, and the control returns when it clears", async () => {
    // `anyPending`, reached through the accepted latch — the same gate that
    // freezes Check now, Update now and the header's Restart. Falsification:
    // drop `|| anyPending` from `openBoundOffer` in `host-overview-panel.tsx`
    // and the second assertion below stays green with a button on screen
    // whose confirm the stale-open rule closes in the commit it opens.
    const fixture = parkedActivationFixture({});
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Control: the same park, same host, gate clear — the button IS offered,
    // so the absence below is the gate's and not the fixture's.
    await screen.findByTestId("host-overview-operation-restart");

    act(() => {
      useHostServiceWriteLatchStore
        .getState()
        .armUpdateInstallAccepted("host-a");
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("host-overview-operation-restart"),
      ).toBeNull();
    });
    // The park itself is still reported — the evidence stays, the dispatch
    // does not — which is what makes this a withdrawal rather than the card
    // disappearing for some other reason.
    expect(
      screen.getByTestId("host-overview-operation-phase").textContent,
    ).toContain("Update installed");

    act(() => {
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted("host-a");
    });
    await screen.findByTestId("host-overview-operation-restart");
  });

  it("(n2) a RETIRED updates region withdraws the bound Restart, and closes an offer that is already open", async () => {
    // The region gate `main` put on the card's Force update…, applied to the
    // bound control and to the offer it opens. Two halves, two
    // falsifications: drop `updates.degrade !== null` from `openBoundOffer`
    // and the button survives the withdrawal of `host.update.install`; drop
    // the `boundOffer !== null && updates.degrade !== null` close rule and
    // the dialog stays answerable over a region that renders a notice in
    // place of the card's controls.
    //
    // `host.update.install` is deliberately the method withdrawn rather than
    // `host.update.activate`: withdrawing the bound method itself would take
    // the control away through `deriveAttemptControl`'s own `canActivate`
    // gate (pin (k) covers that route) and prove nothing about the region.
    const fixture = parkedActivationFixture({});
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    await screen.findByTestId("host-busy-force-defer-dialog");

    // The negotiated set is a subscribed store, so re-recording it under the
    // mounted page is the same signal a re-handshake sends. Recorded as a
    // MANIFEST rather than through this file's `record` helper, which pins
    // `host.update.install`'s version unconditionally and so would put the
    // method straight back into the negotiated set.
    act(() => {
      const manifest: Record<string, ManifestMethodEntry> = {};
      for (const method of METHODS_WITH_BOUND) {
        if (method === "host.update.install") continue;
        manifest[method] = { major: 1, minor: 0 };
      }
      recordNegotiatedHostManifest("host-a", manifest);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-operation-restart")).toBeNull();
  });

  it("(n3) the bound confirmation marks itself as an UPDATE, like the region's force and unlike the force-restart beside it", async () => {
    // `HostBusyForceDeferDialog` grew a `purpose` in `main` precisely because
    // one page can mount more than one of these and a pin on the shared test
    // id cannot tell them apart. Force here dispatches a bound UPDATE method
    // on both legs — an activation's restart is the update finishing, not a
    // `host.restart` — so this dialog is an update's. Falsification: pass
    // `purpose="restart"` at the bound dialog in `host-overview-panel.tsx`
    // and the assertion below reddens.
    const fixture = parkedActivationFixture({});
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.getAttribute("data-purpose")).toBe("update");
    // And the heading is the bound offer's own, not the "Host is busy" the
    // two legacy confirmations state: this park is typically an idle host
    // waiting to be restarted.
    expect(dialog.textContent).toContain("Restart to finish the update");
  });
});

/**
 * WHAT DEFER PROMISES, by park (ticket 08, coordinator item 2).
 *
 * Round 11 rewrote the staged-wait force's Defer because a stage on disk has
 * nobody scheduled to install it. The rule it established is about EVIDENCE,
 * not phrasing, so the three dialogs land differently and nothing pinned that:
 * the `waiting-for-work` park is resumed by the reconciler and keeps the
 * promise; the `waiting-to-activate` park is resumed by nobody and must not.
 */
describe("HostOverviewPanel — the Defer promise follows the continuation (ticket 08)", () => {
  it("(n4) the ACTIVATION dialog promises no continuation; the BUSY-PARK dialog does", async () => {
    // Falsification, both halves at once: give `boundDispatchMessage`'s
    // `activate` arm the continue arm's Defer sentence (or hoist one sentence
    // for both intents) and the first `not.toContain` reddens; take the
    // promise off the `continue` arm and the second assertion reddens.
    const PROMISE = "continue on its own once the host is idle";

    const activateFixture = buildOverviewHostFixture({
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
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: activateFixture.client };
    scopeOverrides.current = scopeFrom("host-a", activateFixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-restart"),
    );
    const activateDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    // Anchor first: this IS the activation dialog and it IS counting the
    // park's work, so the absence below is about the Defer sentence and not
    // about having found some other dialog.
    expect(activateDialog.textContent).toContain(
      "Restart to finish the update",
    );
    expect(activateDialog.textContent).toContain("Defer to restart later.");
    expect(activateDialog.textContent).not.toContain(PROMISE);

    cleanup();
    resetHostServiceWriteLatchesForTest();
    resetNegotiatedManifests();

    const continueFixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.5.0",
          protocolVersion: { major: 1, minor: 3 },
          busy: true,
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
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: continueFixture.client };
    scopeOverrides.current = scopeFrom("host-a", continueFixture);
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );
    const continueDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(continueDialog.textContent).toContain("Finish the update now");
    expect(continueDialog.textContent).toContain(PROMISE);
  });
});

/**
 * H1 (cold review C, round 3): the region-retire close must not SPEND the
 * one-shot auto-open.
 *
 * The close rule and the auto-open resolve the same question forty lines
 * apart, and `updates.degrade` is recoverable — `check.sticky` is derived from
 * the latest answer, `installDiscovered` is cleared by refutation, and
 * `UPDATE_CHECK_CLI_RECOVERY_POLL_LANE` re-asks at 5 s so a reinstalled CLI
 * revives the region unprompted. So a retirement that lasts a few seconds was
 * consuming a one-shot that exists for the life of the park.
 */
describe("HostOverviewPanel — a RECOVERABLE region retirement does not spend the one-shot (H1)", () => {
  it("an owned park that arrives while the region is retired auto-opens when the region recovers, and exactly once", async () => {
    // Falsification: restore `gateArmed: anyPending` at
    // `host-overview-panel.tsx`'s `deriveActivationAutoOpen` call and the
    // first `findByTestId` below times out — the dialog was armed and closed
    // in the same render pass while `cli-unavailable` held, `autoOpenedFor`
    // was recorded, and the recovery finds the shot already spent.
    const FIXED_INCARNATION = "fixed-incarnation-h1";
    vi.spyOn(latchStoreModule, "newOverviewIncarnation").mockReturnValue(
      FIXED_INCARNATION,
    );
    // The slot's own half of "otherwise qualifying", set up directly against
    // the store as pin (g) does: this page dispatched a1, and the host has
    // published it at least once (`seen`).
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

    // The RECOVERABLE retirement, through the path the review names: one
    // `cli-unavailable` check answer retires the region (`check.sticky`), and
    // the next `ok` answer un-retires it. Nothing else about the fixture
    // changes across the transition.
    let checkCalls = 0;
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
            attemptId: "a1",
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
        "host.update.check": () => {
          checkCalls += 1;
          if (checkCalls === 1) {
            return { outcome: "cli-unavailable" as const };
          }
          return {
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.6.0"),
          };
        },
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanel();

    // The park is on screen and the region is retired, so nothing has opened.
    await screen.findByTestId("host-overview-operation-card");
    await waitFor(() => expect(checkCalls).toBeGreaterThan(0));
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();

    // The region recovers: the next check answers `ok`, `check.sticky` clears,
    // and the one shot — held rather than spent — fires.
    await act(async () => {
      await panel.queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope("host-a", "host.update.check"),
      });
    });
    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.textContent).toContain("Restart to finish the update");

    // EXACTLY once: Defer records the shot, and a further recovery pass must
    // not re-open it. This is the half that keeps the fix from turning the
    // one-shot into a modal that returns on every poll.
    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    await act(async () => {
      await panel.queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope("host-a", "host.update.check"),
      });
    });
    panel.rerender(panelElement(panel.queryClient));
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });
});

/**
 * CodeRabbit #1773 round 2: an update dispatch's `onError` released the
 * page-wide accepted latch for EVERY error, transport drops included.
 *
 * A `HostTransportFailureError` is not a refusal — it is the answer going
 * missing, and for an update that is the likeliest shape there is: the swap is
 * detached and outlives the request by design, and the process that would have
 * answered is the one being replaced. Releasing there re-enables Restart and
 * the service verbs over a swap that is already running, and no observation is
 * coming to correct it, because the socket the page would observe over is the
 * one that just dropped.
 *
 * The same file already holds its latch on exactly this error for
 * `host.service.register` and `host.service.deregister`, whose comment states
 * the rule these two sites were breaking: "Only an error that definitively
 * PRECEDED execution refutes the dispatch."
 *
 * BOTH sites get their own case, not just the flagged one. The bound
 * dispatch's `onError` was copied from the install's, which is how they came
 * to share the defect — and an install-only pin stays green when the bound
 * guard is deleted, which is measured, not assumed: removing the bound guard
 * with only the INSTALL cases present left all 22 tests passing.
 */
describe("update dispatch onError — a transport drop keeps the accepted latch armed", () => {
  function latch(): number | null {
    return (
      useHostServiceWriteLatchStore.getState().byHost["host-a"]
        ?.updateInstallAcceptedAt ?? null
    );
  }

  const transportDrop = (): never => {
    throw new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "socket closed before the response arrived",
      requestId: "req-1",
      method: "host.update.install",
      fatalDetails: null,
    });
  };
  const plainFailure = (): never => {
    throw new Error("host refused the request");
  };

  for (const scenario of [
    { label: "transport drop", handler: transportDrop, armed: true },
    { label: "ordinary error", handler: plainFailure, armed: false },
  ] as const) {
    it(`INSTALL — ${scenario.label}: latch ${scenario.armed ? "stays armed" : "releases"}`, async () => {
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        hostVersion: "1.2.0",
        installation: managedInstallation(installRecord("1.2.0"), null),
        overrideHandlers: {
          "host.update.check": () => ({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: updateCheckManifest("1.3.0"),
          }),
          "host.update.install": scenario.handler,
        },
      });
      record("host-a", METHODS_WITHOUT_BOUND);
      hostBindingMock.current = { hostClient: fixture.client };
      scopeOverrides.current = scopeFrom("host-a", fixture);
      const panel = renderPanel();

      fireEvent.click(
        await screen.findByRole("button", { name: "Update now" }),
      );

      // THE BARRIER, and the whole pin turns on it. `onMutate` arms the latch
      // before the request goes out, so "still armed" is trivially true until
      // the error has actually settled — an earlier draft asserted it straight
      // after the click and passed under BOTH ablations, proving nothing. The
      // The MUTATION CACHE is the barrier, not the error toast: a transport
      // drop is deliberately not toasted (`host-error-toast.ts` treats it as
      // the expected shape of a host going away), so a toast barrier would
      // hang on exactly the case this pin is about. `status === "error"` is
      // set after the hook-level `onError` has run, which is the decision
      // under test.
      await waitFor(() => {
        expect(
          panel.queryClient
            .getMutationCache()
            .getAll()
            .some(
              (mutation) =>
                // SCOPED to the dispatch under test, not "something errored".
                // All three update dispatches share this one mutation key, so
                // it covers the install and both bound methods and nothing
                // else. Unscoped, a future fixture that lets any other
                // mutation fail would satisfy the barrier before this one
                // settled and restore the vacuity this pin already had once.
                mutation.options.mutationKey?.[0] === "host.update.install" &&
                mutation.state.status === "error",
            ),
        ).toBe(true);
      });
      if (scenario.armed) {
        expect(latch()).not.toBeNull();
      } else {
        expect(latch()).toBeNull();
      }
    });
  }

  for (const scenario of [
    { label: "transport drop", handler: transportDrop, armed: true },
    { label: "ordinary error", handler: plainFailure, armed: false },
  ] as const) {
    it(`BOUND — ${scenario.label}: latch ${scenario.armed ? "stays armed" : "releases"}`, async () => {
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
          "host.update.activate": scenario.handler,
        },
      });
      record("host-a", METHODS_WITH_BOUND);
      hostBindingMock.current = { hostClient: fixture.client };
      scopeOverrides.current = scopeFrom("host-a", fixture);
      const panel = renderPanel();

      fireEvent.click(
        await screen.findByTestId("host-overview-operation-restart"),
      );
      await screen.findByTestId("host-busy-force-defer-dialog");
      fireEvent.click(screen.getByTestId("host-busy-force"));

      await waitFor(() => {
        expect(
          panel.queryClient
            .getMutationCache()
            .getAll()
            .some(
              (mutation) =>
                // SCOPED to the dispatch under test, not "something errored".
                // All three update dispatches share this one mutation key, so
                // it covers the install and both bound methods and nothing
                // else. Unscoped, a future fixture that lets any other
                // mutation fail would satisfy the barrier before this one
                // settled and restore the vacuity this pin already had once.
                mutation.options.mutationKey?.[0] === "host.update.install" &&
                mutation.state.status === "error",
            ),
        ).toBe(true);
      });
      if (scenario.armed) {
        expect(latch()).not.toBeNull();
      } else {
        expect(latch()).toBeNull();
      }
    });
  }
});
