// T2: the notices strip (`host-overview-notices.tsx`) that replaced the
// Status tab and the header's live update pill/phone strip. Three layers,
// tested at the layer that actually decides the thing:
//  - pure model (`host-overview-status-model.ts`): `inFlightUpdateKind`,
//    `describeHostOfflineNotice`;
//  - standalone components, rendered with hand-built props rather than
//    through the whole panel, for a mechanism a single component owns
//    (the answer card's quiet answers and in-flight hiding, Check now's
//    in-flight hiding on the version list, the destructive-styled force
//    controls);
//  - the full panel, through the same harness `host-overview-tabs.test.tsx`
//    uses, for a decision only the panel makes (the strip's placement and
//    absence on every tab, the drain-gate/operation-card "one wait" rule,
//    the completion acknowledgement living above the tabs entirely).

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

import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
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
  describeHostOfflineNotice,
  inFlightUpdateKind,
} from "@/components/settings/panels/host-overview-status-model";
import { describeLastSeenUpdateClause } from "@/components/home/host-update-operation-copy";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
  type FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostOverviewUpdatesSummary } from "@/components/settings/panels/host-overview-updates-state";
import {
  HostOverviewAnswerCard,
  type HostOverviewVersionAnswer,
} from "@/components/settings/panels/host-overview-updates";
import { HostOverviewUpdatesTab } from "@/components/settings/panels/host-overview-updates-tab";
import type { VersionPickerProps } from "@/components/settings/panels/host-overview-version-picker";
import { describeCliFloorRemedy } from "@/components/settings/panels/host-overview-cli-floor-remedy";
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

  it("still counts a retained in-flight phase and a qualified park as in flight, so the answer card and Check now stay withheld", () => {
    const retained: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "downloading",
    };
    const qualifiedPark = view("waiting-to-activate", { qualified: true });
    for (const demoted of [retained, qualifiedPark]) {
      expect(inFlightUpdateKind(demoted)).not.toBeNull();
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

describe("<HostOverviewAnswerCard/> draws only an answer with something to say, and goes quiet while an update is in flight", () => {
  function summaryFor(
    overrides: Partial<HostOverviewUpdatesSummary>,
  ): HostOverviewUpdatesSummary {
    return {
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
      ...overrides,
    };
  }

  function answerWith(
    overrides: Partial<HostOverviewUpdatesSummary>,
  ): HostOverviewVersionAnswer {
    return {
      summary: summaryFor(overrides),
      degrade: null,
      desktopBridge: null,
      onInstallationHelp: vi.fn(),
      foregroundUpdateLine: null,
    };
  }

  function answerWithUpdatable(): HostOverviewVersionAnswer {
    return answerWith({});
  }

  function pickerProps(): VersionPickerProps {
    return {
      rows: [],
      storeFloorNotice: false,
      totalCount: 0,
      showAll: false,
      onToggleShowAll: vi.fn(),
      includePreReleases: false,
      onIncludePreReleasesChange: vi.fn(),
      includePreReleasesExplanation: null,
      installingVersion: null,
      disabled: false,
      foregroundUpdateLine: null,
      onInstall: vi.fn(),
      awaitingFirstCheck: false,
      checking: false,
      onCheck: vi.fn(),
      failureDescription: null,
    };
  }

  /**
   * The Updates tab as the panel composes it: the answer card and the version
   * picker, both fed the SAME in-flight fact, which is what makes Update now
   * (on the card) and Check now (on the picker's heading) go quiet together.
   */
  function renderTab(inFlight: boolean): void {
    render(
      <HostOverviewUpdatesTab
        answerCard={{
          version: "1.5.0",
          answer: answerWithUpdatable(),
          inFlight,
        }}
        autoUpdate={null}
        versions={pickerProps()}
        inFlight={inFlight}
        versionFallback={null}
      />,
    );
  }

  it.each([["latest"], ["checking"]] as const)(
    "draws nothing at all for the quiet %s answer",
    (answerKind) => {
      render(
        <HostOverviewAnswerCard
          version="1.5.0"
          answer={answerWith({ answerKind, updatableVersion: null })}
          inFlight={false}
        />,
      );
      expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();
      expect(screen.queryByTestId("host-overview-updates")).toBeNull();
    },
  );

  it.each([
    ["available", "Update available"],
    ["needs-cli", "Needs newer CLI tools"],
    ["restart-to-finish", "Restart to finish"],
    ["stranded", "Newer version on another release line"],
    ["not-installable", "Update unavailable for this host"],
    ["unreachable", "Update check failed"],
    ["check-failed", "Update check failed"],
  ] as const)(
    "draws a card for the %s answer, titled %s",
    (answerKind, title) => {
      render(
        <HostOverviewAnswerCard
          version="1.5.0"
          answer={answerWith({ answerKind, updatableVersion: null })}
          inFlight={false}
        />,
      );
      const card = screen.getByTestId("host-overview-answer-card");
      expect(card.getAttribute("data-answer")).toBe(answerKind);
      expect(within(card).getByText(title)).not.toBeNull();
    },
  );

  it("reads an available update as from → to, from the running version, with the plain sentence kept for a screen reader", () => {
    render(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answerWithUpdatable()}
        inFlight={false}
      />,
    );
    const sentence = screen.getByTestId("host-overview-updates");
    expect(sentence.textContent).toContain("v1.5.0");
    expect(sentence.textContent).toContain("v1.6.0");
    expect(screen.getByText("v1.6.0 is available.")).not.toBeNull();
  });

  it("mounts its polite live region before it has anything to say, and the card arrives inside the SAME node", () => {
    // Pins: the live region exists, empty and sr-only, before its content
    // does; a region inserted already filled is not announced.
    const view = render(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answerWith({ answerKind: "latest", updatableVersion: null })}
        inFlight={false}
      />,
    );
    const live = screen.getByTestId("host-overview-answer-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.classList.contains("sr-only")).toBe(true);
    expect(live.childNodes).toHaveLength(0);
    expect(live.textContent).toBe("");
    expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();

    view.rerender(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answerWithUpdatable()}
        inFlight={false}
      />,
    );
    expect(screen.getByTestId("host-overview-answer-live")).toBe(live);
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.classList.contains("sr-only")).toBe(false);
    const card = within(live).getByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("available");
  });

  const SHOWN_KIND_CASES: ReadonlyArray<{
    readonly name: string;
    readonly answer: HostOverviewVersionAnswer;
    readonly inFlight: boolean;
  }> = [
    { name: "available", answer: answerWith({}), inFlight: false },
    {
      name: "available with a refused-install footer",
      answer: answerWith({ failureDescription: "host-a refused the update." }),
      inFlight: false,
    },
    {
      name: "available while installing",
      answer: answerWith({ installing: true }),
      inFlight: false,
    },
    {
      name: "needs-cli",
      answer: answerWith({
        answerKind: "needs-cli",
        updatableVersion: null,
        remedy: describeCliFloorRemedy({
          isLocalMachine: false,
          platform: "darwin-arm64",
          cliSource: "manual",
          cliBinaryPath: "/home/u/.local/bin/traycer",
          cliVersion: "1.2.0",
          requiredCliVersion: "1.3.0",
          desktopUpdate: null,
          hostName: "host-a",
        }),
      }),
      inFlight: false,
    },
    {
      name: "restart-to-finish",
      answer: answerWith({
        answerKind: "restart-to-finish",
        updatableVersion: null,
      }),
      inFlight: false,
    },
    {
      name: "stranded",
      answer: answerWith({ answerKind: "stranded", updatableVersion: null }),
      inFlight: false,
    },
    {
      name: "not-installable",
      answer: answerWith({
        answerKind: "not-installable",
        updatableVersion: null,
      }),
      inFlight: false,
    },
    {
      name: "unreachable",
      answer: answerWith({ answerKind: "unreachable", updatableVersion: null }),
      inFlight: false,
    },
    {
      name: "check-failed, its failure as the supporting line",
      answer: answerWith({
        answerKind: "check-failed",
        updatableVersion: null,
        failureDescription:
          "host-a's Traycer CLI couldn't complete the request.",
      }),
      inFlight: false,
    },
    {
      name: "degraded",
      answer: { ...answerWith({}), degrade: "cli-unavailable" },
      inFlight: false,
    },
    {
      name: "failed-attempt",
      answer: answerWith({ failureDescription: "host-a refused the update." }),
      inFlight: true,
    },
  ];

  it.each(SHOWN_KIND_CASES)(
    "carries no live role of its own inside the standing region for $name",
    ({ answer, inFlight }) => {
      // Pins: nothing inside the region is itself live - a region nested in a
      // region is announced twice.
      render(
        <HostOverviewAnswerCard
          version="1.5.0"
          answer={answer}
          inFlight={inFlight}
        />,
      );
      const live = screen.getByTestId("host-overview-answer-live");
      // A card is in there, so the selector below is not looking at nothing.
      expect(
        within(live).getByTestId("host-overview-answer-card"),
      ).not.toBeNull();
      expect(
        live.querySelector('[role="status"], [role="alert"], [aria-live]'),
      ).toBeNull();
    },
  );

  it("shows Update now and Check now while nothing is in flight", () => {
    renderTab(false);
    expect(screen.getByTestId("host-overview-update-now")).not.toBeNull();
    expect(screen.getByTestId("host-overview-update-check")).not.toBeNull();
  });

  it("hides both the moment inFlight is true, though the same updatable version is on offer", () => {
    renderTab(true);
    expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    // The list itself is not part of what goes quiet.
    expect(screen.getByTestId("host-overview-version-picker")).not.toBeNull();
  });

  it("keeps the command-line-tools fix on screen while an update is in flight, and still withholds Update now", () => {
    const remedy = describeCliFloorRemedy({
      isLocalMachine: false,
      platform: "darwin-arm64",
      cliSource: "manual",
      cliBinaryPath: "/home/u/.local/bin/traycer",
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: null,
      hostName: "host-a",
    });
    render(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answerWith({
          answerKind: "needs-cli",
          description: remedy.sentence,
          remedy,
        })}
        inFlight
      />,
    );
    expect(
      screen
        .getByTestId("host-overview-answer-card")
        .getAttribute("data-answer"),
    ).toBe("needs-cli");
    expect(screen.getByRole("button", { name: "Copy command" })).not.toBeNull();
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
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
        foregroundHeldFinish={null}
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
        foregroundHeldFinish={null}
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
        foregroundHeldFinish={null}
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
        foregroundHeldFinish={null}
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
        foregroundUpdateLine={null}
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
        foregroundUpdateLine={null}
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
        foregroundUpdateLine={null}
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

describe("the notices strip: on every tab, not just one", () => {
  it("shows the operation card on the default Installation tab and still after switching to Ports, with no pill or strip testid anywhere", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: { "host.status": () => DOWNLOADING_STATUS },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain("Downloading");
    expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-strip")).toBeNull();

    await selectHostOverviewTab("ports");
    expect(screen.getByTestId("host-overview-operation-card")).not.toBeNull();
    expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
  });

  describe("on a phone", () => {
    const initialInnerWidth = window.innerWidth;
    afterEach(() => {
      window.innerWidth = initialInnerWidth;
    });

    it("draws the notices strip directly above the section Select on a non-default tab, with no pill or strip testid", async () => {
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

      const notices = await screen.findByTestId("host-overview-notices");
      expect(screen.queryByTestId("host-overview-update-pill")).toBeNull();
      expect(screen.queryByTestId("host-overview-update-strip")).toBeNull();
      const select = screen.getByTestId("host-overview-tab-select");
      // The strip sits directly above the Select in DOM order: the strip
      // PRECEDES the Select node.
      expect(
        notices.compareDocumentPosition(select) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });
});

describe("the update card lives in the notices strip, above the tabs, independent of which one is active", () => {
  it("shows 'Updated to vX' with no particular tab required, and clears it after HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS", async () => {
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
      expect(
        screen.getByTestId("host-overview-operation-card").textContent,
      ).toContain("Updated to v2.1.0");
    });

    await vi.advanceTimersByTimeAsync(
      HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS + 100,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });
  });

  it("a manual dismiss on the card clears it, whichever tab is active", async () => {
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
    await screen.findByTestId("host-overview-operation-card");

    fireEvent.click(
      await screen.findByTestId("host-overview-operation-dismiss"),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
    });
    // Still cleared after switching tabs — not per-tab state.
    await selectHostOverviewTab("data");
    expect(screen.queryByTestId("host-overview-operation-card")).toBeNull();
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

    await screen.findByTestId("host-overview-tab-panel-installation");
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

describe("the auto-update row — no longer a caption on the version card; the switch sits directly below the answer card on Updates", () => {
  it("shows on for an auto-policy host, off for a manual one, once Updates is selected", async () => {
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
    await selectHostOverviewTab("updates");

    const row = await screen.findByTestId("host-auto-update-host-a");
    expect(row.getAttribute("aria-checked")).toBe("true");
  });

  it("stays visible while the host is unreachable — an account write needs no route to the host", async () => {
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
    await selectHostOverviewTab("updates");

    await waitFor(() => {
      expect(screen.getByTestId("host-auto-update-host-a")).not.toBeNull();
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
    await selectHostOverviewTab("updates");

    await screen.findByTestId("host-overview-version-picker");
    expect(screen.queryByTestId("host-auto-update-host-a")).toBeNull();
  });

  it("stays visible when updates aren't manageable here — it is an account write, not a host capability — while the degrade notice replaces the answer and Update now/Check now withdraw", async () => {
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
    await selectHostOverviewTab("updates");

    const notice = await screen.findByTestId("host-overview-updates-degraded");
    expect(notice.textContent).toContain(
      "host-a is running a version that doesn't support this yet. Update it and this comes back on its own.",
    );
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    expect(screen.getByTestId("host-auto-update-host-a")).not.toBeNull();
  });
});

describe("a stranded answer's sentence points at the version list below it, with no 'Pick it in Updates' link", () => {
  it("ends the answer sentence with 'Pick it from the versions below to move.', and renders no host-overview-pick-in-updates element", async () => {
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
    await selectHostOverviewTab("updates");

    const sentence = await screen.findByTestId("host-overview-updates");
    expect(
      sentence.textContent.endsWith("Pick it from the versions below to move."),
    ).toBe(true);
    expect(screen.queryByTestId("host-overview-pick-in-updates")).toBeNull();
  });
});

describe("a refused/failed attempt line shows while an update is in flight, even with the answer and Update now withdrawn", () => {
  it("shows host-overview-update-attempt-failed as a card of its own while the answer is withheld in flight, with Update now absent", () => {
    render(
      <HostOverviewAnswerCard
        version="1.5.0"
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
          foregroundUpdateLine: null,
        }}
        inFlight
      />,
    );
    // The answer ("v1.6.0 is available.") is withheld; only the failure draws.
    expect(
      screen
        .getByTestId("host-overview-answer-card")
        .getAttribute("data-answer"),
    ).toBe("failed-attempt");
    const failure = screen.getByTestId("host-overview-update-attempt-failed");
    expect(failure.textContent).toBe(
      "host-a refused the last Force update… request.",
    );
    expect(screen.queryByTestId("host-overview-updates")).toBeNull();
    expect(screen.queryByTestId("host-overview-update-now")).toBeNull();
  });

  it("keeps the failure as a footer under a shown answer, and makes it the supporting line of a failed check", () => {
    const base: HostOverviewUpdatesSummary = {
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
      failureDescription: "host-a refused the last update.",
    };
    const answer = (
      summary: HostOverviewUpdatesSummary,
    ): HostOverviewVersionAnswer => ({
      summary,
      degrade: null,
      desktopBridge: null,
      onInstallationHelp: vi.fn(),
      foregroundUpdateLine: null,
    });
    const shown = render(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answer(base)}
        inFlight={false}
      />,
    );
    expect(
      screen.getByTestId("host-overview-update-attempt-failed").textContent,
    ).toBe("host-a refused the last update.");
    expect(screen.getByText("v1.6.0 is available.")).not.toBeNull();
    shown.unmount();

    render(
      <HostOverviewAnswerCard
        version="1.5.0"
        answer={answer({
          ...base,
          answerKind: "check-failed",
          description: "unused",
          updatableVersion: null,
          failureDescription: "Couldn't check for updates.",
        })}
        inFlight={false}
      />,
    );
    // No footer: the failure IS the supporting line.
    expect(
      screen.queryByTestId("host-overview-update-attempt-failed"),
    ).toBeNull();
    expect(screen.getByTestId("host-overview-updates").textContent).toBe(
      "Couldn't check for updates.",
    );
  });
});

describe("the bound activation offer's auto-open reaches a person who has moved to another tab", () => {
  it("opens the busy-force-defer dialog with no click, and stays open while a non-default tab is active", async () => {
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
    // The answer card (and its Update now button) lives on Updates now,
    // rather than on the page's default tab.
    await selectHostOverviewTab("updates");

    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await vi.advanceTimersByTimeAsync(11_000);
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toContain("Preparing");
    });

    // Move away from Updates BEFORE the park is seen.
    await selectHostOverviewTab("ports");
    expect(
      screen
        .getByTestId("host-overview-tab-panel-ports")
        .getAttribute("data-state"),
    ).toBe("active");

    phase = "parked";
    await vi.advanceTimersByTimeAsync(11_000);

    await screen.findByTestId("host-busy-force-defer-dialog");
    // Still over Ports: the offer opened without forcing the page back to
    // Updates. The dialog itself comes from the notices strip, which is on
    // every tab regardless.
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

describe("regression: activation debt does not narrate 'restart host to finish' twice", () => {
  it("the notices strip's operation card carries the sentence; the Updates tab draws no answer card and no restart-to-finish sentence of its own", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.4.0",
      installation: {
        status: "managed" as const,
        installRecord: {
          installId: "install-1",
          version: "1.5.0",
          runtimeVersion: null,
          platform: "darwin",
          arch: "arm64",
          installedAt: "2026-08-10T00:00:00Z",
          source: { kind: "registry", value: "1.5.0" },
          archiveSha256: "a".repeat(64),
          signatureVerifiedAt: "2026-08-10T00:00:00Z",
          signatureKeyId: "key-1",
          sizeBytes: 1024,
          executablePath: "/tmp/traycer/1.5.0/host",
          executableSha256: "b".repeat(64),
        },
        stagedRecord: null,
        cliManifest: null,
      },
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    // The operation card is in the notices strip, visible on the default
    // (Installation) tab already — it does not wait for Updates to mount.
    const card = await screen.findByTestId("host-overview-operation-card");
    expect(card.textContent).toContain(
      "Update installed — restart host to finish",
    );

    // The Updates tab, once its version list has drawn, has no answer card
    // and no repeat of the sentence the strip above the tabs already said.
    await selectHostOverviewTab("updates");
    await screen.findByTestId("host-overview-version-picker");
    expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();
    expect(
      screen.getByTestId("host-overview-tab-panel-updates").textContent,
    ).not.toContain("restart host to finish");
  });
});

describe("at rest, the notices strip renders nothing at all", () => {
  it("has no host-overview-notices element for an idle, reachable host with no drain wait and no registry row", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    record("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom("host-a", fixture, {});
    renderPanel();

    await screen.findByTestId("host-overview-tab-panel-installation");
    expect(screen.queryByTestId("host-overview-notices")).toBeNull();
  });
});
