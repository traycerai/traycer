// T2: the Status tab and the header's live update pill. Three layers, tested
// at the layer that actually decides the thing:
//  - pure model (`host-overview-status-model.ts`): `inFlightUpdateKind`,
//    `deriveHostOverviewVersionTag`, `describeHostOfflineNotice`;
//  - standalone components, rendered with hand-built props rather than
//    through the whole panel, for a mechanism a single component owns
//    (the version card's in-flight button hiding, the destructive-styled
//    force controls);
//  - the full panel, through the same harness `host-overview-tabs.test.tsx`
//    uses, for a decision only the panel makes (the pill's placement and
//    absence, the drain-gate/operation-card "one wait" rule, the completion
//    acknowledgement living above the tab that mounts the card).

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

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly getLocalEntry: () => { readonly hostId: string } | null;
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
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

import type { ComponentProps, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/index";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  buildOverviewHostFixture,
  selectHostOverviewTab,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import { HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS } from "@/stores/settings/host-update-banner-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
} from "@/stores/tabs/settings-open-intent-store";
import {
  deriveHostOverviewVersionTag,
  describeHostOfflineNotice,
  inFlightUpdateKind,
  type HostOverviewVersionTag,
} from "@/components/settings/panels/host-overview-status-model";
import { describeLastSeenUpdateClause } from "@/components/home/host-update-operation-copy";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
  type FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostOverviewAnswerKind } from "@/components/settings/panels/host-overview-updates-state";
import { HostOverviewVersionCard } from "@/components/settings/panels/host-overview-updates";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import {
  HostAutoUpdateRow,
  HostUpdateDrainGateRow,
} from "@/components/settings/host-scope/host-registry-updates";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import type {
  HostVersionPolicyResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { HostUpdateCompletion } from "@/hooks/host/use-host-update-completion";

afterEach(() => {
  cleanup();
  // Two tests below switch to fake timers; without this every later test
  // would inherit them and its result would depend on file order.
  vi.useRealTimers();
});

/**
 * A genuine `UseMutationResult`, idle and never fired, for a component test
 * that only reads `mutate`/`isPending` and never wants the mutation to
 * actually run. A real `useMutation` instance rather than a hand-cast object:
 * the type is a large TanStack shape this file has no business re-typing.
 */
function policyMutationFixture(): UpdateHostVersionPolicyMutation {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  function wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }
  const { result } = renderHook(
    () =>
      useMutation<HostVersionPolicyResult, Error, UpdateHostVersionPolicyInput>(
        {
          mutationFn: () =>
            Promise.reject(new Error("not dispatched by this fixture")),
        },
      ),
    { wrapper },
  );
  return result.current;
}

// -----------------------------------------------------------------------------
// SECTION A — pure model
// -----------------------------------------------------------------------------

const ALL_KINDS: ReadonlyArray<FleetUpdateViewKind> = [
  "unknown",
  "idle",
  "updating",
  "downloading",
  "preparing",
  "applying",
  "waiting-for-work",
  "waiting-to-activate",
  "restarting",
  "reconnecting",
  "verifying",
  "complete",
  "failed",
  "finalizing-record",
  "verification-refused",
  "unavailable",
];

const IN_FLIGHT_KINDS: ReadonlyArray<FleetUpdateViewKind> = [
  "updating",
  "downloading",
  "preparing",
  "applying",
  "restarting",
  "reconnecting",
  "verifying",
  "waiting-for-work",
  "waiting-to-activate",
];

function view(
  kind: FleetUpdateViewKind,
  overrides: Partial<FleetUpdateView>,
): FleetUpdateView {
  return { ...UNKNOWN_FLEET_UPDATE_VIEW, kind, qualified: false, ...overrides };
}

describe("inFlightUpdateKind", () => {
  it("returns null for a null view", () => {
    expect(inFlightUpdateKind(null)).toBeNull();
  });

  it("is non-null for exactly the nine in-flight kinds, and null for everything else", () => {
    for (const kind of ALL_KINDS) {
      const result = inFlightUpdateKind(view(kind, {}));
      if (IN_FLIGHT_KINDS.includes(kind)) {
        expect(result).toBe(kind);
      } else {
        expect(result).toBeNull();
      }
    }
  });

  it("reads the retained phase off an unknown view carrying lastKnownKind", () => {
    const retained: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "downloading",
    };
    expect(inFlightUpdateKind(retained)).toBe("downloading");
  });

  it("returns null for an unknown view with no retained phase", () => {
    expect(inFlightUpdateKind(UNKNOWN_FLEET_UPDATE_VIEW)).toBeNull();
  });
});

describe("deriveHostOverviewVersionTag", () => {
  function derive(input: {
    readonly offline: boolean;
    readonly unmanaged: boolean;
    readonly view: FleetUpdateView | null;
    readonly cliFloorBlocked: boolean;
    readonly answerKind: HostOverviewAnswerKind | null;
  }): HostOverviewVersionTag | null {
    return deriveHostOverviewVersionTag(input);
  }

  it("wears Last reported when offline, over every other input", () => {
    expect(
      derive({
        offline: true,
        unmanaged: false,
        view: view("downloading", {}),
        cliFloorBlocked: true,
        answerKind: "available",
      }),
    ).toBe("last-reported");
  });

  it("wears no tag when updates are not manageable here", () => {
    expect(
      derive({
        offline: false,
        unmanaged: true,
        view: null,
        cliFloorBlocked: false,
        answerKind: "available",
      }),
    ).toBeNull();
  });

  it("wears the in-flight tag for each in-flight kind", () => {
    const expected: Record<
      | "updating"
      | "downloading"
      | "preparing"
      | "applying"
      | "restarting"
      | "reconnecting"
      | "verifying",
      HostOverviewVersionTag
    > = {
      updating: "updating",
      downloading: "updating",
      preparing: "updating",
      applying: "updating",
      restarting: "updating",
      reconnecting: "updating",
      verifying: "updating",
    };
    for (const [kind, tag] of Object.entries(expected) as Array<
      [keyof typeof expected, HostOverviewVersionTag]
    >) {
      expect(
        derive({
          offline: false,
          unmanaged: false,
          view: view(kind, {}),
          cliFloorBlocked: false,
          answerKind: null,
        }),
      ).toBe(tag);
    }
    expect(
      derive({
        offline: false,
        unmanaged: false,
        view: view("waiting-to-activate", {}),
        cliFloorBlocked: false,
        answerKind: null,
      }),
    ).toBe("restart-to-finish");
  });

  it("wears waiting-on-work for a park with no floor, and needs-cli when the floor blocks it", () => {
    expect(
      derive({
        offline: false,
        unmanaged: false,
        view: view("waiting-for-work", {}),
        cliFloorBlocked: false,
        answerKind: null,
      }),
    ).toBe("waiting-on-work");
    expect(
      derive({
        offline: false,
        unmanaged: false,
        view: view("waiting-for-work", {}),
        cliFloorBlocked: true,
        answerKind: null,
      }),
    ).toBe("needs-cli");
  });

  it("wears no tag for a phase the page can no longer vouch for, though the phase still counts as in flight", () => {
    const retained: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "downloading",
    };
    const qualifiedPark = view("waiting-to-activate", { qualified: true });
    for (const demoted of [retained, qualifiedPark]) {
      // Still in flight: the buttons stay hidden...
      expect(inFlightUpdateKind(demoted)).not.toBeNull();
      // ...but the card makes no present-tense claim about it.
      expect(
        derive({
          offline: false,
          unmanaged: false,
          view: demoted,
          cliFloorBlocked: false,
          answerKind: "available",
        }),
      ).toBeNull();
    }
  });

  it("keeps needs-cli for a retained park, because the floor is a live fact about the catalog", () => {
    expect(
      derive({
        offline: false,
        unmanaged: false,
        view: {
          ...UNKNOWN_FLEET_UPDATE_VIEW,
          lastKnownKind: "waiting-for-work",
        },
        cliFloorBlocked: true,
        answerKind: null,
      }),
    ).toBe("needs-cli");
  });

  it("falls back to the answer's tag once nothing is in flight, and to null with no answer", () => {
    for (const [answer, tag] of [
      ["latest", "latest"],
      ["available", "available"],
      ["stranded", "available"],
      ["not-installable", null],
      ["checking", "checking"],
      ["unreachable", null],
      ["restart-to-finish", "restart-to-finish"],
      ["needs-cli", "needs-cli"],
    ] as ReadonlyArray<
      [HostOverviewAnswerKind, HostOverviewVersionTag | null]
    >) {
      expect(
        derive({
          offline: false,
          unmanaged: false,
          view: null,
          cliFloorBlocked: false,
          answerKind: answer,
        }),
      ).toBe(tag);
    }
    expect(
      derive({
        offline: false,
        unmanaged: false,
        view: null,
        cliFloorBlocked: false,
        answerKind: null,
      }),
    ).toBeNull();
  });

  it("wears no tag for a finished/failed/quiet view once nothing is in flight and the answer says so", () => {
    for (const kind of [
      "complete",
      "failed",
      "finalizing-record",
      "verification-refused",
      "unavailable",
      "idle",
    ] as const) {
      expect(
        derive({
          offline: false,
          unmanaged: false,
          view: view(kind, {}),
          cliFloorBlocked: false,
          answerKind: null,
        }),
      ).toBeNull();
    }
  });
});

describe("describeHostOfflineNotice", () => {
  it("states the last-seen half and the phase clause together, exactly as describeLastSeenUpdateClause states the clause", () => {
    const downloadingView = view("downloading", { targetVersion: "2.1.0" });
    const clause = describeLastSeenUpdateClause(downloadingView);
    expect(clause).not.toBeNull();
    expect(
      describeHostOfflineNotice({
        hostName: "host-a",
        lastSeen: "last seen 3h ago",
        view: downloadingView,
        accountKnowsHost: true,
      }),
    ).toBe(
      `Can't reach host-a — last seen 3h ago, ${clause}. Auto-update settings still apply at its next check-in; everything else here needs a connection.`,
    );
  });

  it("drops the last-seen half when the account holds no check-in, keeping only the clause", () => {
    const downloadingView = view("downloading", { targetVersion: "2.1.0" });
    const clause = describeLastSeenUpdateClause(downloadingView);
    expect(
      describeHostOfflineNotice({
        hostName: "host-a",
        lastSeen: null,
        view: downloadingView,
        accountKnowsHost: true,
      }),
    ).toBe(
      `Can't reach host-a — last seen ${clause}. Auto-update settings still apply at its next check-in; everything else here needs a connection.`,
    );
  });

  it("drops the phase clause entirely when nothing was in flight (complete/failed/quiet, and no view at all)", () => {
    expect(
      describeHostOfflineNotice({
        hostName: "host-a",
        lastSeen: "last seen 3h ago",
        view: view("complete", {}),
        accountKnowsHost: true,
      }),
    ).toBe(
      "Can't reach host-a — last seen 3h ago. Auto-update settings still apply at its next check-in; everything else here needs a connection.",
    );
    expect(
      describeHostOfflineNotice({
        hostName: "host-a",
        lastSeen: "last seen 3h ago",
        view: null,
        accountKnowsHost: true,
      }),
    ).toBe(
      "Can't reach host-a — last seen 3h ago. Auto-update settings still apply at its next check-in; everything else here needs a connection.",
    );
  });

  it("drops the auto-update tail when the account does not know this host", () => {
    expect(
      describeHostOfflineNotice({
        hostName: "host-a",
        lastSeen: null,
        view: null,
        accountKnowsHost: false,
      }),
    ).toBe("Can't reach host-a. Everything here needs a connection.");
  });
});

// -----------------------------------------------------------------------------
// SECTION B — standalone components
// -----------------------------------------------------------------------------

describe("<HostOverviewVersionCard/> hides Update now / Check now while in flight", () => {
  function answerWithUpdatable(): NonNullable<
    ComponentProps<typeof HostOverviewVersionCard>["answer"]
  > {
    return {
      summary: {
        hostName: "host-a",
        description: "v1.6.0 is available.",
        answerKind: "available",
        updatableVersion: "1.6.0",
        checking: false,
        busy: false,
        installing: false,
        onCheck: vi.fn(),
        onUpdateLatest: vi.fn(),
        remedy: null,
        failureDescription: null,
      },
      degrade: null,
      desktopBridge: null,
      onInstallationHelp: vi.fn(),
    };
  }

  it("shows Update now and Check now while nothing is in flight", () => {
    render(
      <HostOverviewVersionCard
        version="1.5.0"
        tag={null}
        answer={answerWithUpdatable()}
        inFlight={false}
        autoUpdate={null}
      />,
    );
    expect(screen.getByTestId("host-overview-update-now")).not.toBeNull();
    expect(screen.getByTestId("host-overview-update-check")).not.toBeNull();
  });

  it("hides both buttons the moment inFlight is true, though the same updatable version is on offer", () => {
    render(
      <HostOverviewVersionCard
        version="1.5.0"
        tag="updating"
        answer={answerWithUpdatable()}
        inFlight
        autoUpdate={null}
      />,
    );
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
  });

  it("in-flight-ness itself is keyed on every one of the nine in-flight kinds (inFlightUpdateKind), restoring to null on complete and failed", () => {
    for (const kind of IN_FLIGHT_KINDS) {
      expect(inFlightUpdateKind(view(kind, {}))).not.toBeNull();
    }
    expect(inFlightUpdateKind(view("complete", {}))).toBeNull();
    expect(inFlightUpdateKind(view("failed", {}))).toBeNull();
  });
});

describe("<HostOverviewOperationCard/> force controls are destructive, Restart stays default", () => {
  const completion: HostUpdateCompletion = { dismissed: false, dismiss: null };

  it("Restart is variant=default", () => {
    render(
      <HostOverviewOperationCard
        view={view("waiting-to-activate", { targetVersion: "1.6.0" })}
        hostName="host-a"
        onForceRestart={null}
        onRestart={vi.fn()}
        onForceUpdate={null}
        cliFloorBlocked={false}
        completion={completion}
      />,
    );
    expect(
      screen
        .getByTestId("host-overview-operation-restart")
        .getAttribute("data-variant"),
    ).toBe("default");
  });

  it("Force update… is variant=destructive", () => {
    render(
      <HostOverviewOperationCard
        view={view("waiting-for-work", {
          blockingSessionCount: 2,
          targetVersion: "1.6.0",
        })}
        hostName="host-a"
        onForceRestart={null}
        onRestart={null}
        onForceUpdate={vi.fn()}
        cliFloorBlocked={false}
        completion={completion}
      />,
    );
    const button = screen.getByTestId("host-overview-operation-force-update");
    expect(button.getAttribute("data-variant")).toBe("destructive");
    expect(button.textContent).toBe("Force update…");
  });

  it("Force restart… is variant=destructive", () => {
    render(
      <HostOverviewOperationCard
        view={view("waiting-for-work", {
          blockingSessionCount: 3,
          targetVersion: "1.6.0",
        })}
        hostName="host-a"
        onForceRestart={vi.fn()}
        onRestart={null}
        onForceUpdate={null}
        cliFloorBlocked={false}
        completion={completion}
      />,
    );
    const button = screen.getByTestId("host-overview-operation-force-restart");
    expect(button.getAttribute("data-variant")).toBe("destructive");
    expect(button.textContent).toBe("Force restart…");
  });
});

describe("<HostOverviewOperationCard/> tone", () => {
  const completion: HostUpdateCompletion = { dismissed: false, dismiss: null };

  function cardFor(v: FleetUpdateView): HTMLElement {
    render(
      <HostOverviewOperationCard
        view={v}
        hostName="host-a"
        onForceRestart={null}
        onRestart={null}
        onForceUpdate={null}
        cliFloorBlocked={false}
        completion={completion}
      />,
    );
    return screen.getByTestId("host-overview-operation-card");
  }

  it("keeps a failure red once it is only retained on an aged-out view", () => {
    const card = cardFor({
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "failed",
      targetVersion: "1.6.0",
    });
    expect(card.className).toContain("bg-destructive/10");
  });

  it("goes neutral for any other retained phase, which is no longer a present-tense claim", () => {
    const card = cardFor({
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "downloading",
      targetVersion: "1.6.0",
    });
    expect(card.className).toContain("bg-foreground/5");
    expect(card.className).not.toContain("bg-info/10");
  });

  it("reads a live failure red, as before", () => {
    const card = cardFor(view("failed", { targetVersion: "1.6.0" }));
    expect(card.className).toContain("bg-destructive/10");
  });
});

describe("<HostBusyForceDeferDialog/> Force is destructive only where it consents to ending work", () => {
  function dialog(forceDestructive: boolean) {
    return (
      <HostBusyForceDeferDialog
        purpose="restart"
        open
        title="Host is busy"
        message="host-a is busy running 2 sessions."
        detail={null}
        isForcing={false}
        forceLabel="Force restart"
        forceDestructive={forceDestructive}
        onForce={vi.fn()}
        onDefer={vi.fn()}
      />
    );
  }

  it("draws Force as destructive when it ends running work", () => {
    render(dialog(true));
    expect(
      screen.getByTestId("host-busy-force").getAttribute("data-variant"),
    ).toBe("destructive");
  });

  it("draws Force as the ordinary default variant for the one caller where it does not (the bound activation offer)", () => {
    render(dialog(false));
    expect(
      screen.getByTestId("host-busy-force").getAttribute("data-variant"),
    ).toBe("default");
  });
});

describe("<HostUpdateDrainGateRow/> Apply now is destructive, and the row renders only while genuinely gated", () => {
  function item(overrides: Partial<HostListItem["status"]>): HostListItem {
    return {
      hostId: "host-a",
      displayName: "host-a",
      platform: "darwin-arm64",
      kind: "personal",
      publicKey: "pk-1",
      createdAt: "2026-08-10T00:00:00Z",
      updatePolicy: "manual",
      status: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: "2026-08-12T00:00:00Z",
        ...overrides,
      },
    };
  }

  function mutation(): UpdateHostVersionPolicyMutation {
    return policyMutationFixture();
  }

  it("renders nothing when the registry has no pending update", () => {
    const { container } = render(
      <HostUpdateDrainGateRow
        item={item({ updateState: "current" })}
        mutation={mutation()}
        liveBusySessionCount={2}
        liveBusyBreakdown={null}
        settledBusySessionCount={2}
        settledBusyBreakdown={null}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing while pending with no live session count (no live source, not zero)", () => {
    const { container } = render(
      <HostUpdateDrainGateRow
        item={item({ updateState: "pending" })}
        mutation={mutation()}
        liveBusySessionCount={null}
        liveBusyBreakdown={null}
        settledBusySessionCount={null}
        settledBusyBreakdown={null}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows Waiting for N sessions and a destructive Apply now once pending with a positive live count", () => {
    render(
      <HostUpdateDrainGateRow
        item={item({ updateState: "pending" })}
        mutation={mutation()}
        liveBusySessionCount={2}
        liveBusyBreakdown={null}
        settledBusySessionCount={2}
        settledBusyBreakdown={null}
      />,
    );
    const row = screen.getByTestId("host-update-drain-gate-host-a");
    expect(row.textContent).toContain("Waiting for 2 sessions");
    const trigger = screen.getByTestId("host-apply-now-trigger-host-a");
    expect(trigger.getAttribute("data-variant")).toBe("destructive");
    expect(trigger.textContent).toBe("Apply now — ends 2 sessions");
  });
});

describe("<HostAutoUpdateRow/> smoke (not the subject here, mounted only to prove the fixture builds)", () => {
  it("renders the switch for a manual-policy host", () => {
    render(
      <HostAutoUpdateRow
        item={{
          hostId: "host-a",
          displayName: "host-a",
          platform: "darwin-arm64",
          kind: "personal",
          publicKey: "pk-1",
          createdAt: "2026-08-10T00:00:00Z",
          updatePolicy: "manual",
          status: {
            connectivity: "connectable",
            viewerReachability: "ok",
            clientCloud: "ok",
            updateState: "current",
            appVersion: "1.5.0",
            lastSeenAt: "2026-08-12T00:00:00Z",
          },
        }}
        mutation={policyMutationFixture()}
        className=""
      />,
    );
    expect(
      screen
        .getByTestId("host-auto-update-host-a")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

// -----------------------------------------------------------------------------
// SECTION C — the full panel
// -----------------------------------------------------------------------------

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

const METHODS_WITH_BOUND = [
  ...ALL_OVERVIEW_METHODS,
  "host.update.activate",
  "host.update.continue",
] as const;

function record(hostId: string, methods: readonly string[]): void {
  recordNegotiatedHostMethods(hostId, methods);
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of methods) manifest[method] = { major: 1, minor: 0 };
  // `recordNegotiatedHostManifest` REPLACES the negotiated methods set with
  // its own keys (`negotiated-manifest-registry.ts`), so this must only
  // carry a method a caller actually negotiated — unconditionally adding
  // `host.update.install` here would silently re-negotiate it behind a
  // caller that deliberately left it off `methods` to pin an
  // unsupported-method degrade.
  if (methods.includes("host.update.install")) {
    manifest["host.update.install"] = { major: 1, minor: 2 };
  }
  recordNegotiatedHostManifest(hostId, manifest);
}

function scopeFrom(
  hostId: string,
  fixture: OverviewHostFixture,
  hostOverrides: Partial<Parameters<typeof hostScopeOptionFixture>[0]>,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
      isActive: true,
      ...hostOverrides,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      getLocalEntry: () => null,
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
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

function renderPanel(): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/** A host that reported a download in progress via the `host.status@1.3` attempt. */
const DOWNLOADING_STATUS: ResponseOfMethod<HostRpcRegistry, "host.status"> = {
  ready: true,
  hostVersion: "1.5.0",
  protocolVersion: { major: 1, minor: 3 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: {
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
  },
  updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  storeFormats: null,
  install: null,
};

function completeStatus(
  targetVersion: string,
  attemptId: string,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: targetVersion,
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: {
      kind: "attempt",
      attemptId,
      generation: 1,
      sequence: 3,
      targetVersion,
      trigger: "manual",
      phase: "complete",
      execution: "terminal",
      continuation: null,
      progress: null,
      liveness: "active",
      livenessCause: null,
      busySessionCount: null,
      busyBreakdown: null,
      error: null,
    },
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
    storeFormats: null,
    install: null,
  };
}

function pendingDrainStatus(
  updateProgress: null,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 1 },
    busy: true,
    busySessionCount: 2,
    updateProgress,
    busyBreakdown: null,
    updateOperation: null,
    updateTransaction: null,
    storeFormats: null,
    install: null,
  };
}

function registryHostListItem(
  hostId: string,
  updateState: "current" | "pending",
): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk-1",
    createdAt: "2026-08-10T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState,
      appVersion: "1.5.0",
      lastSeenAt: "2026-08-12T00:00:00Z",
    },
  };
}

afterEach(() => {
  resetNegotiatedManifests();
  resetSettingsOpenIntentForTests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  useHostUpdateBannerStore.setState({ landingDismissedAttemptIds: [] });
});

describe("the header pill and the phone strip", () => {
  it("shows the pill on the header health line on a non-Status tab, and clicking it selects Status", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();
    await selectHostOverviewTab("ports");

    const pill = await screen.findByTestId("host-overview-update-pill");
    expect(pill.textContent).toContain("Downloading");
    expect(pill.getAttribute("data-tone")).toBe("info");

    fireEvent.click(pill);
    await waitFor(() => {
      expect(
        screen
          .getByTestId("host-overview-tab-panel-status")
          .getAttribute("data-state"),
      ).toBe("active");
    });
  });

  it("shows no pill on Status itself, where the update card is the answer", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
  });

  it("shows no pill while the health word reads Restarting…, even with a downloading view retained", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {
      health: {
        state: "restarting",
        label: "Restarting…",
        detail: "Expected restart — reconnecting.",
        tone: "idle",
        live: false,
      },
    });
    renderPanel();
    await selectHostOverviewTab("ports");

    await waitFor(() => {
      expect(screen.getByText("Restarting…")).not.toBeNull();
    });
    expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
  });

  describe("on a phone", () => {
    const initialInnerWidth = window.innerWidth;
    afterEach(() => {
      window.innerWidth = initialInnerWidth;
    });

    it("draws no header pill; draws the strip directly above the section Select on a non-Status tab; tapping it selects Status", async () => {
      window.innerWidth = 500;
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
      });
      record("host-a", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = bindingWith(fixture.client);
      scopeOverrides.current = scopeFrom("host-a", fixture, {});
      armSettingsOpenIntent({
        section: "host",
        resetToGeneral: false,
        tab: "ports",
        draft: null,
        hostId: null,
      });
      renderPanel();

      const strip = await screen.findByTestId("host-overview-update-strip");
      expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
      const select = screen.getByTestId("host-overview-tab-select");
      // The strip sits directly above the Select in DOM order: the strip
      // PRECEDES the Select node.
      expect(
        strip.compareDocumentPosition(select) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(strip);
      await waitFor(() => {
        expect(
          screen
            .getByTestId("host-overview-tab-panel-status")
            .getAttribute("data-state"),
        ).toBe("active");
      });
    });

    it("draws no strip on Status", async () => {
      window.innerWidth = 500;
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
      });
      record("host-a", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = bindingWith(fixture.client);
      scopeOverrides.current = scopeFrom("host-a", fixture, {});
      renderPanel();

      await screen.findByTestId("host-overview-tab-select");
      expect(screen.queryByTestId("host-overview-update-strip")).toBeNull();
    });
  });
});

describe("the completion acknowledgement is lifted to the panel, above the tab that mounts the card", () => {
  it("keeps 'Updated to vX' on the header pill without ever mounting Status, and clears it after HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => completeStatus("2.1.0", "attempt-complete-lift"),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    armSettingsOpenIntent({
      section: "host",
      resetToGeneral: false,
      tab: "ports",
      draft: null,
      hostId: null,
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("host-overview-update-pill").textContent).toBe(
        "Updated to v2.1.0",
      );
    });
    // Status was never visited: Radix still renders the (hidden) pane
    // wrapper for every tab, but a never-visited pane's own children are not
    // mounted, so the card this text would otherwise live on never mounted —
    // this text can only be coming from panel-level state.
    expect(screen.queryByTestId("host-overview-status-tab")).toBeNull();
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();

    await vi.advanceTimersByTimeAsync(
      HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS + 100,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
    });
  });

  it("a manual dismiss on the card (once Status IS visited) clears both the card and the header pill together", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          completeStatus("2.1.0", "attempt-complete-dismiss"),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    armSettingsOpenIntent({
      section: "host",
      resetToGeneral: false,
      tab: "ports",
      draft: null,
      hostId: null,
    });
    renderPanel();
    await screen.findByTestId("host-overview-update-pill");

    await selectHostOverviewTab("status");
    fireEvent.click(
      await screen.findByTestId("host-overview-operation-dismiss"),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });
    // The pill is off Status regardless, so re-select a non-Status tab to see it clear too.
    await selectHostOverviewTab("ports");
    expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
  });
});

describe("the one-wait rule: the account's drain gate withdraws once the host reports its own wait", () => {
  it("shows the account's drain gate before the host has parked on waiting-for-work", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => pendingDrainStatus(null),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {
      item: registryHostListItem("host-a", "pending"),
    });
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-update-drain-gate-host-a"),
      ).not.toBeNull();
    });
  });

  it("hides the account's drain gate once the view itself is waiting-for-work — the host's own card is the one wait shown", async () => {
    const fixture = buildOverviewHostFixture({
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
          updateOperation: {
            kind: "attempt",
            attemptId: "attempt-park",
            generation: 1,
            sequence: 2,
            targetVersion: "1.6.0",
            trigger: "manual",
            phase: "waiting-for-work",
            execution: "parked",
            continuation: null,
            progress: null,
            liveness: "active",
            livenessCause: null,
            busySessionCount: 2,
            busyBreakdown: null,
            error: null,
          },
          updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
          storeFormats: null,
          install: null,
        }),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {
      item: registryHostListItem("host-a", "pending"),
    });
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    expect(screen.queryByTestId("host-update-drain-gate-host-a")).toBeNull();
  });

  it("hides the account's drain gate while the host can't be reached — it names live work, so it needs the host's own count", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => pendingDrainStatus(null),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture, {
        item: registryHostListItem("host-a", "pending"),
        connectable: false,
      }),
      status: "connecting",
      client: null,
    };
    renderPanel();

    await screen.findByTestId("host-scope-connecting");
    expect(screen.queryByTestId("host-update-drain-gate-host-a")).toBeNull();
  });
});

describe("the offline notice: gated on unreachable-for-a-reason-other-than-restart, never shown while restarting or connecting", () => {
  it("does not show the offline notice while the health word reads Restarting…, even though the scope itself is unusable", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture, {
        connectable: false,
        health: {
          state: "restarting",
          label: "Restarting…",
          detail: "Expected restart — reconnecting.",
          tone: "idle",
          live: false,
        },
      }),
      status: "unreachable" as const,
      client: null,
    };
    renderPanel();

    await screen.findByTestId("host-overview-status-tab");
    expect(screen.queryByTestId("host-overview-offline-notice")).toBeNull();
  });

  it("does not show the offline notice while the scope is still connecting — that host has an answer coming, and waits in its loading shape", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture, { connectable: false }),
      status: "connecting",
      client: null,
    };
    renderPanel();

    await screen.findByTestId("host-scope-connecting");
    expect(screen.queryByTestId("host-overview-offline-notice")).toBeNull();
  });
});

describe("the auto-update caption", () => {
  it("shows on for an auto-policy host, off for a manual one, stays while unreachable, and 'Change in Updates' selects Updates", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {
      item: {
        ...registryHostListItem("host-a", "current"),
        updatePolicy: "auto",
      },
    });
    renderPanel();

    const caption = await screen.findByTestId(
      "host-overview-auto-update-caption",
    );
    expect(caption.getAttribute("data-state")).toBe("on");

    fireEvent.click(screen.getByTestId("host-overview-change-in-updates"));
    await waitFor(() => {
      expect(
        screen
          .getByTestId("host-overview-tab-panel-updates")
          .getAttribute("data-state"),
      ).toBe("active");
    });
  });

  it("stays on the version card while the host is unreachable", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture, {
        item: registryHostListItem("host-a", "current"),
        connectable: false,
      }),
      status: "unreachable" as const,
      client: null,
    };
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-auto-update-caption"),
      ).not.toBeNull();
    });
  });

  it("is absent when the account holds no registry row for this host", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, { item: null });
    renderPanel();

    await screen.findByTestId("host-overview-version-card");
    expect(
      screen.queryByTestId("host-overview-auto-update-caption"),
    ).toBeNull();
  });

  it("is absent when updates aren't manageable here, even with a registry row — the degrade notice replaces the answer, and Update now/Check now withdraw with it", async () => {
    // REMOTE, deliberately: `resolveOverviewMethodDegrade` withholds the
    // degrade when the local maintenance fallback route can still serve the
    // method (`host-overview-panel.tsx`'s `useOverviewCapabilities`), and
    // that fallback only exists for the local machine. A remote host has no
    // fallback route, so leaving `host.update.install` off the negotiated
    // manifest is the one fixture shape that actually degrades here — the
    // same reason `host-overview-installation-tab.test.tsx` uses a remote
    // host for its own unsupported-method pin.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    record(
      "host-a",
      ALL_OVERVIEW_METHODS.filter((method) => method !== "host.update.install"),
    );
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {
      isLocalMachine: false,
      item: registryHostListItem("host-a", "current"),
    });
    renderPanel();

    const notice = await screen.findByTestId("host-overview-updates-degraded");
    expect(notice.textContent).toContain(
      "host-a is running a version that doesn't support this yet. Update it and this comes back on its own.",
    );
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    expect(
      screen.queryByTestId("host-overview-auto-update-caption"),
    ).toBeNull();
  });
});

describe("'Pick it in Updates' — a stranded answer's link selects the Updates tab", () => {
  it("renders host-overview-pick-in-updates inside the role=status sentence, and clicking it selects Updates", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      // A host on an installed pre-release line whose OWN line has run out
      // (no newer rc/beta to offer) while the catalog lists a newer stable —
      // the "stranded" shape `host-overview-updates.test.tsx`'s stranded
      // fixtures use: nothing on the installed line, something elsewhere.
      hostVersion: "1.5.0-rc.1",
      overrideHandlers: {
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "installed-rc" as const,
          manifest: updateCheckManifest("1.6.0"),
        }),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    const link = await screen.findByTestId("host-overview-pick-in-updates");
    const status = screen.getByRole("status");
    expect(status.textContent.endsWith("Pick it in Updates to move.")).toBe(
      true,
    );
    expect(status.contains(link)).toBe(true);

    fireEvent.click(link);
    await waitFor(() => {
      expect(
        screen
          .getByTestId("host-overview-tab-panel-updates")
          .getAttribute("data-state"),
      ).toBe("active");
    });
  });
});

describe("a refused/failed attempt line shows while an update is in flight, even with Update now/Check now withdrawn", () => {
  it("shows host-overview-update-attempt-failed alongside a waiting-for-work in-flight card with both buttons absent", () => {
    render(
      <HostOverviewVersionCard
        version="1.5.0"
        tag="waiting-on-work"
        answer={{
          summary: {
            hostName: "host-a",
            description: "v1.6.0 is available.",
            answerKind: "available",
            updatableVersion: "1.6.0",
            checking: false,
            busy: false,
            installing: false,
            onCheck: vi.fn(),
            onUpdateLatest: vi.fn(),
            remedy: null,
            failureDescription:
              "host-a refused the last Force update… request.",
          },
          degrade: null,
          desktopBridge: null,
          onInstallationHelp: vi.fn(),
        }}
        inFlight
        autoUpdate={null}
      />,
    );
    expect(
      screen.getByTestId("host-overview-update-attempt-failed").textContent,
    ).toBe("host-a refused the last Force update… request.");
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
  });
});

describe("the bound activation offer's auto-open reaches a person who has moved to another tab", () => {
  it("opens the busy-force-defer dialog with no click, and stays open while a non-Status tab is active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase: "idle" | "preparing" | "parked" = "idle";
    function operation() {
      if (phase === "idle") return { kind: "none" as const };
      if (phase === "preparing") {
        return {
          kind: "attempt" as const,
          attemptId: "a1",
          generation: 1,
          sequence: 1,
          targetVersion: "1.6.0",
          trigger: "manual" as const,
          phase: "preparing" as const,
          execution: "active" as const,
          continuation: null,
          progress: null,
          liveness: "active" as const,
          livenessCause: null,
          busySessionCount: null,
          busyBreakdown: null,
          error: null,
        };
      }
      return {
        kind: "attempt" as const,
        attemptId: "a1",
        generation: 1,
        sequence: 4,
        targetVersion: "1.6.0",
        trigger: "manual" as const,
        phase: "waiting-to-activate" as const,
        execution: "parked" as const,
        continuation: null,
        progress: null,
        liveness: "active" as const,
        livenessCause: null,
        busySessionCount: 2,
        busyBreakdown: null,
        error: null,
      };
    }
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
          updateOperation: operation(),
          updateTransaction: {
            recordSchemaVersion: 2 as const,
            authority: "attempt" as const,
          },
          storeFormats: null,
          install: null,
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
        "host.update.activate": () => ({
          outcome: "accepted" as const,
          attemptId: "a1",
        }),
      },
    });
    record("host-a", METHODS_WITH_BOUND);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Preparing");
    });

    // Move away from Status BEFORE the park is seen.
    await selectHostOverviewTab("ports");
    expect(
      screen
        .getByTestId("host-overview-tab-panel-ports")
        .getAttribute("data-state"),
    ).toBe("active");

    phase = "parked";
    await vi.advanceTimersByTimeAsync(11_000);

    await screen.findByTestId("host-busy-force-defer-dialog");
    // Still over Ports: the offer opened without forcing the page back to Status.
    expect(
      screen
        .getByTestId("host-overview-tab-panel-ports")
        .getAttribute("data-state"),
    ).toBe("active");
    // The activation offer's Force is "Restart host" and stays the ordinary
    // default button, unlike the force-restart/force-update dialogs beside it
    // — Restart does not end the work it names, the update itself does.
    const force = screen.getByTestId("host-busy-force");
    expect(force.textContent).toContain("Restart host");
    expect(force.getAttribute("data-variant")).toBe("default");
  });
});

describe("the staged-wait Force update… dialog dispatches through the same busy/force/defer shape, destructive this time", () => {
  it("opens host-busy-force-defer-dialog with a destructive Force on a busy staged wait", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.3.0-rc.2",
      installation: {
        status: "managed" as const,
        installRecord: {
          installId: "install-1",
          version: "1.3.0-rc.2",
          runtimeVersion: null,
          platform: "darwin",
          arch: "arm64",
          installedAt: "2026-08-10T00:00:00Z",
          source: { kind: "registry", value: "1.3.0-rc.2" },
          archiveSha256: "a".repeat(64),
          signatureVerifiedAt: "2026-08-10T00:00:00Z",
          signatureKeyId: "key-1",
          sizeBytes: 1024,
          executablePath: "/tmp/traycer/1.3.0-rc.2/host",
          executableSha256: "b".repeat(64),
        },
        stagedRecord: {
          schemaVersion: 1,
          stageId: null,
          version: "1.3.0-rc.3",
          runtimeVersion: null,
          archiveSha256: "a".repeat(64),
          sizeBytes: 1024,
          source: { kind: "registry", value: "1.3.0-rc.3" },
          signatureKeyId: "key-1",
          signatureVerifiedAt: "2026-08-10T00:00:00Z",
          executablePath: "/tmp/traycer/1.3.0-rc.3/host",
          platform: "darwin",
          arch: "arm64",
          executableSha256: "b".repeat(64),
        },
        cliManifest: null,
      },
      overrideHandlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.3.0-rc.2",
          protocolVersion: { major: 1, minor: 1 },
          busy: true,
          busySessionCount: 2,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: null,
          updateTransaction: null,
          storeFormats: null,
          install: null,
        }),
        "host.update.check": () => ({
          outcome: "ok" as const,
          effectiveIncludePreReleases: true,
          includePreReleasesSource: "explicit-include" as const,
          manifest: {
            schemaVersion: 1,
            generatedAt: "2026-08-12T00:00:00Z",
            latest: "1.3.0-rc.3",
            versions: [
              {
                version: "1.3.0-rc.3",
                releasedAt: "2026-08-12T00:00:00Z",
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
          },
        }),
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-force-update"),
    );

    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.getAttribute("data-purpose")).toBe("update");
    const force = screen.getByTestId("host-busy-force");
    expect(force.textContent).toContain("Force update");
    expect(force.getAttribute("data-variant")).toBe("destructive");
  });
});
