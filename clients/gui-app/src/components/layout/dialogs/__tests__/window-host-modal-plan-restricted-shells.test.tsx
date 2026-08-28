/**
 * The plan-restricted narration, asserted per SHELL rather than once.
 *
 * The model itself is not new - `window-host-modal-host.test.tsx` pins the
 * precedence and the missing Retry. What no fixture there can see is that the
 * verdict and the presentation are read off two DIFFERENT signals, and the two
 * disagree on a browser tab:
 *
 *  - the VERDICT reads `runnerHost.hasLocalHost` (`localHostExpected`), which
 *    the web shell answers like the phone. That is what has to NOT divert a
 *    plan-restricted fleet into the cold-start `offline` arm, whose face is a
 *    start in progress - a spinner where the honest answer is a billing wall.
 *  - the PRESENTATION reads `isMobileApp()`, which the web shell answers like
 *    the desktop. So a mid-session downgrade in a tab is the blocking dialog,
 *    not the phone's pointer-transparent card.
 *
 * Both arms of the account's life are covered because they take different
 * paths through the narrator: on FIRST LOAD the gate is still blocking and the
 * narration is the startup card in its frame; on a MID-SESSION DOWNGRADE the
 * gate has latched, so the same verdict renders over a mounted app.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { setMobileApp } from "@/lib/mobile-app";
import {
  shellSurfaces,
  type ShellSurfaceFixture,
} from "../../../../../__tests__/shell-surfaces";

const PAID_HOST_ID = "host-a";
const OTHER_HOST_ID = "host-b";

/**
 * The platform deployment this shell is pointed at, in the shape every shell
 * bakes it: `<cloudUiBaseUrl>/sign-in`.
 *
 * The staging dashboard origin is used deliberately rather than an
 * `.invalid` stand-in. `clients/webapp/vite.config.ts` bakes `signInUrl` from
 * `cloudUiBaseUrl` and documents that same value as "the ORIGIN this bundle
 * has to be served from" (authn's CORS allow-list leaves the web shell no
 * other choice), so on the web shell the upgrade target's origin IS the app's
 * own origin - which is the property this fixture is here to pin, and which a
 * made-up origin could not express.
 */
const PLATFORM_SIGN_IN_URL = "https://platform.dev.traycer.ai/sign-in";

/**
 * Which surface the narration takes once the gate has latched.
 *
 * The one row that differs is the installed phone, and it differs for a
 * navigation reason rather than a cosmetic one (see `window-host-modal-host`'s
 * `isMobileApp()` arm: a modal layer stands the edge-swipe recognizer down).
 * The web rows sit with the desktop because a tab has the browser's own back
 * button and never had that reservation to lose.
 *
 * Written out per shell rather than derived from the fixture's own product
 * flag - a table computed from the gate's input would agree with whatever the
 * gate does.
 */
const DOWNGRADE_SURFACE: ReadonlyMap<string, string> = new Map([
  ["desktop", "window-host-modal"],
  ["installed mobile", "window-host-startup-card"],
  ["webapp", "window-host-modal"],
  ["browser dev", "window-host-modal"],
]);

function lease(overrides: Partial<HostLeaseSnapshot>): HostLeaseSnapshot {
  return {
    hostId: PAID_HOST_ID,
    status: "connecting",
    dead: null,
    ...overrides,
  } as HostLeaseSnapshot;
}

/**
 * A host the attach-grant endpoint refused with `403 plan_restricted`, as the
 * selection authority records it: a DEAD lease whose reason names the plan.
 * Death is what the fleet scan reads, so a fixture that only marked the host
 * unusable would never reach the plan-restricted arm at all.
 */
function planRestrictedLease(hostId: string): HostLeaseSnapshot {
  return {
    hostId,
    status: "dead",
    dead: { reason: "plan-restricted" },
  };
}

/** Every host on the account refused: the arm's precondition is "every". */
const PLAN_RESTRICTED_FLEET: readonly HostLeaseSnapshot[] = [
  planRestrictedLease(PAID_HOST_ID),
  planRestrictedLease(OTHER_HOST_ID),
];

const PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

/**
 * The launch: nothing has served this window, and the readiness kind is one
 * the narrator owns - so the gate blocks and draws no card of its own.
 */
const GATE_BLOCKING: SurfaceReadiness = { kind: "unavailable-host" };
/** A window with a working app behind it. */
const GATE_READY: SurfaceReadiness = { kind: "ready" };

function controllerFor(
  readiness: SurfaceReadiness,
  hasBeenReady: boolean,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: PRESENTATION,
    hasBeenDefaultHostReady: hasBeenReady,
  };
}

function applySnapshot(overrides: Partial<SelectionKernelSnapshot>): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
    selectionRevision: 1,
    ...overrides,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

interface NarratorHarness {
  readonly openedLinks: string[];
  readonly setGate: (
    readiness: SurfaceReadiness,
    hasBeenReady: boolean,
  ) => void;
}

/**
 * The narrator under one shell, with the gate state re-settable.
 *
 * Providers and the runner host are built ONCE and re-rendered rather than
 * re-mounted, because `useWindowNarration`'s "has this window ever been
 * served" latch is component state: a harness that remounted on the gate flip
 * would re-arm it, and the mid-session fixture would be asserting a cold start
 * instead of a downgrade.
 */
function renderNarrator(
  surface: ShellSurfaceFixture,
  readiness: SurfaceReadiness,
  hasBeenReady: boolean,
): NarratorHarness {
  const openedLinks: string[] = [];
  // The fixture's CAPABILITY posture, with the two fields this suite is about
  // stated on top: the deployment the shell points at, and a link opener that
  // records instead of discarding.
  const runnerHost: IRunnerHost = {
    ...surface.runnerHost,
    signInUrl: PLATFORM_SIGN_IN_URL,
    openExternalLink: (url: string) => {
      openedLinks.push(url);
      return Promise.resolve();
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (next: SurfaceReadiness, nextHasBeenReady: boolean) => (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(next, nextHasBeenReady)}
        >
          <WindowHostModalHost bypassed={false} />
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  const view = render(tree(readiness, hasBeenReady));
  return {
    openedLinks,
    setGate: (next, nextHasBeenReady) => {
      view.rerender(tree(next, nextHasBeenReady));
    },
  };
}

function downgradeSurfaceFor(name: string): string {
  const testId = DOWNGRADE_SURFACE.get(name);
  if (testId === undefined) {
    throw new Error(`no post-latch expectation for the "${name}" shell`);
  }
  return testId;
}

/** The narration, whichever presentation this shell chose. */
function narratorSurface(): HTMLElement | null {
  return (
    screen.queryByTestId("window-host-modal") ??
    screen.queryByTestId("window-host-startup-card")
  );
}

beforeEach(() => {
  // The narrator mounts only for a signed-in user, and `gateBlocksApp` reads
  // this first - a signed-out harness models a window with an app behind it,
  // which is the opposite of the launch the first-load fixture describes.
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState({ status: "signed-out" });
  setMobileApp(false);
});

describe("plan-restricted narration per shell", () => {
  it("has an expectation for every shell that mounts the app", () => {
    expect(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    ).toEqual([...DOWNGRADE_SURFACE.keys()].sort());
  });

  describe.each(shellSurfaces())("on $name", (surface) => {
    it("first load: the plan wall, not a start in progress", async () => {
      setMobileApp(surface.mobileApp);
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: null,
        leases: PLAN_RESTRICTED_FLEET,
      });

      renderNarrator(surface, GATE_BLOCKING, false);

      // Existence before absence: a narrator that rendered nothing would
      // satisfy every "no spinner" assertion below.
      const card = await screen.findByTestId("window-host-startup-card");
      expect(card.getAttribute("data-variant")).toBe("plan-restricted");
      expect(card.getAttribute("data-cause")).toBe("no-usable-host");
      // The titled face, which is the difference between this and the
      // cold-start card: `no-usable-host` is a settled answer and says so.
      expect(
        screen.getByTestId("window-host-startup-card-title").textContent,
      ).toBe("Your plan doesn't include remote hosts");

      // Nothing is starting, so nothing narrates a start. This is the arm the
      // web shell's `hasLocalHost: false` could have diverted into.
      expect(screen.queryByTestId("window-host-modal-progress")).toBeNull();
      expect(screen.queryByTestId("local-host-loading-spinner")).toBeNull();

      // The remedy is offered, and the dead-host recoveries are not: retrying
      // a network that is not broken is the wrong instruction here.
      expect(screen.getByTestId("host-scope-plan-upgrade")).toBeTruthy();
      expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    });

    it("mid-session downgrade: silent while a host serves, then the plan wall", async () => {
      setMobileApp(surface.mobileApp);
      // The paid window: one host serving, narrator silent.
      applySnapshot({
        attached: true,
        effectiveHostId: PAID_HOST_ID,
        targetHostId: PAID_HOST_ID,
        preferredHostId: PAID_HOST_ID,
        leases: [lease({ hostId: PAID_HOST_ID, status: "ready", dead: null })],
      });

      const harness = renderNarrator(surface, GATE_READY, true);

      // The PRECONDITION, not a discriminating control, and the difference is
      // worth stating: post-latch the narrator is silent for any cause but
      // ∅, so nothing short of a compound mutation makes this line fail. It
      // is here because it is what makes the rest of this fixture a
      // DOWNGRADE - a window that was working - rather than a second spelling
      // of the first-load case above.
      expect(narratorSurface()).toBeNull();

      // The downgrade: the next attach-grant comes back `403 plan_restricted`,
      // so the authority kills every lease and derives no effective host.
      harness.setGate(GATE_BLOCKING, true);
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: PAID_HOST_ID,
        preferredHostId: PAID_HOST_ID,
        leases: PLAN_RESTRICTED_FLEET,
        selectionRevision: 2,
      });

      const expectedTestId = downgradeSurfaceFor(surface.name);
      await waitFor(() => {
        expect(screen.getByTestId(expectedTestId)).toBeTruthy();
      });
      const narration = screen.getByTestId(expectedTestId);
      expect(narration.getAttribute("data-variant")).toBe("plan-restricted");
      expect(narration.getAttribute("data-cause")).toBe("no-usable-host");
      // The other presentation is not also on screen - "one narrator per
      // scope" is the rule this surface exists to keep.
      expect(
        [...DOWNGRADE_SURFACE.values()]
          .filter((testId) => testId !== expectedTestId)
          .every((testId) => screen.queryByTestId(testId) === null),
      ).toBe(true);
      expect(screen.getByTestId("host-scope-plan-upgrade")).toBeTruthy();
      expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    });

    it("the upgrade action targets the deployment's own dashboard origin", async () => {
      setMobileApp(surface.mobileApp);
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: null,
        leases: PLAN_RESTRICTED_FLEET,
      });

      const harness = renderNarrator(surface, GATE_BLOCKING, false);

      fireEvent.click(await screen.findByTestId("host-scope-plan-upgrade"));

      // Stated as the RELATIONSHIP rather than as a literal: what the web
      // shell needs is that the upgrade never leaves the deployment this tab
      // was served from, and the origin of the shell's own `signInUrl` is the
      // only value that tracks a redeployment. Note what it resolves to - that
      // origin's ROOT, the dashboard index, not a billing route: the app-wide
      // `resolvePlatformBaseUrl` convention this shares with the user menu's
      // "Manage subscription" answers an origin and nothing deeper.
      const expectedTarget = new URL(PLATFORM_SIGN_IN_URL).origin;
      await waitFor(() => {
        expect(harness.openedLinks).toEqual([expectedTarget]);
      });
    });
  });
});
