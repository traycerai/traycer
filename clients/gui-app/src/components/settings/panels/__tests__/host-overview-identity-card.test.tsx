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
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * `HostIdentityCard`'s restructure (`host-identity-card.tsx`): `actions` moved
 * into a footer bar, the `via relay… / ws://… pid N` endpoint row is deleted,
 * a session-count chip replaced it, and `ThisWindowCard` no longer renders on
 * the Overview — its boolean now rides an `Active` tag plus a footer button.
 */

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

function renderPanel(queryClient: QueryClient | undefined): void {
  render(
    <QueryClientProvider
      client={
        queryClient ??
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

describe("<HostSettingsPanel /> Overview identity card — rename affordance and the deleted endpoint row", () => {
  it("Edit name is reachable by its accessible name and swaps the heading for an inline input", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    // Waiting on the NAME rather than the button itself: the pencil renders
    // immediately but stays disabled (`!loaded`) until `host.identity.get`
    // answers, and a click on a disabled control is a no-op jsdom silently
    // absorbs rather than surfaces as a failure.
    await screen.findByText("Studio Mac");
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    // IN PLACE, not a new row: the input replaces the `<h2>` rather than
    // opening an editor band beneath it (`useInlineRename`, the same hook the
    // tab strips use). Both halves are asserted, because the old editor also
    // put an input on screen — what makes this the fixed behaviour is that the
    // heading is GONE while it is up, so the card does not grow and shove
    // everything below it down as you reach for it.
    const input = await screen.findByTestId<HTMLInputElement>(
      "host-overview-name-input",
    );
    expect(input.value).toBe("Studio Mac");
    expect(
      within(screen.getByTestId("host-identity-card")).queryByRole("heading", {
        name: "Studio Mac",
      }),
    ).toBeNull();
  });

  it("the deleted `via relay… / ws://… pid N` endpoint row never renders", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    await screen.findByText("Studio Mac");
    // Pinned as ABSENT rather than left un-asserted: a reader who remembers
    // this row would otherwise assume it moved rather than went.
    expect(screen.queryByTestId("host-overview-endpoint")).toBeNull();
  });
});

describe("<HostSettingsPanel /> Overview identity card — busy chip", () => {
  it("reads 'Idle' with no live tone when the host reports no work", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      busy: false,
      busySessionCount: 0,
      busyBreakdown: {
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    const chip = await screen.findByTestId("host-active-sessions");
    expect(chip.textContent).toBe("Idle");
    expect(chip.getAttribute("data-live")).toBe("false");
    expect(chip.className).not.toMatch(/emerald/);
  });

  it("reads '1 agent working' for a {1,0,0} breakdown", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      busy: true,
      busySessionCount: 1,
      busyBreakdown: {
        workingAgents: 1,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    const chip = await screen.findByTestId("host-active-sessions");
    expect(chip.getAttribute("data-count")).toBe("1");
    expect(chip.getAttribute("data-live")).toBe("true");
    expect(chip.textContent).toBe("1 agent working");
    expect(chip.textContent).not.toMatch(/session/i);
  });

  it("falls back to '2 sessions' for a @1.1 host with a count and no breakdown", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      busy: true,
      busySessionCount: 2,
      busyBreakdown: null,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    const chip = await screen.findByTestId("host-active-sessions");
    expect(chip.getAttribute("data-count")).toBe("2");
    expect(chip.textContent).toBe("2 sessions");
  });

  it("is ABSENT entirely while host.status has not resolved — not the same as a known zero", async () => {
    let releaseStatus: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      overrideHandlers: {
        "host.status": async () => {
          await gate;
          return {
            ready: true,
            hostVersion: "1.5.0",
            protocolVersion: { major: 1, minor: 1 },
            busy: true,
            busySessionCount: 1,
            updateProgress: null,
            busyBreakdown: null,
          };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    // The identity card mounts before `host.status` answers — "not yet
    // known" and "known zero" are different facts, and rendering the chip
    // here would be claiming an answer the host has not given.
    await screen.findByText("Studio Mac");
    expect(screen.queryByTestId("host-active-sessions")).toBeNull();

    await act(async () => {
      releaseStatus?.();
      await gate;
    });

    expect(await screen.findByTestId("host-active-sessions")).toBeTruthy();
  });

  it("keeps the busy chip on screen while host.status is refetching", async () => {
    let statusCalls = 0;
    let releaseRefetch: (() => void) | null = null;
    const refetchGate = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      overrideHandlers: {
        "host.status": async () => {
          statusCalls += 1;
          if (statusCalls > 1) {
            await refetchGate;
          }
          return {
            ready: true,
            hostVersion: "1.5.0",
            protocolVersion: { major: 1, minor: 2 },
            busy: true,
            busySessionCount: 2,
            updateProgress: null,
            busyBreakdown: {
              workingAgents: 0,
              activeTerminalAgents: 0,
              busyTerminals: 2,
            },
          };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    renderPanel(queryClient);

    const chip = await screen.findByTestId("host-active-sessions");
    expect(chip.textContent).toBe("2 terminals working");

    act(() => {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope("host-a", "host.status"),
      });
    });

    // Prove the invalidation actually matched and a refetch is in flight
    // (gated on refetchGate) - otherwise a wrong query key would leave the
    // initial render on screen and the retained-content assertion below
    // would pass vacuously.
    await waitFor(() => {
      expect(statusCalls).toBe(2);
    });

    expect(screen.getByTestId("host-active-sessions").textContent).toBe(
      "2 terminals working",
    );

    await act(async () => {
      releaseRefetch?.();
      await refetchGate;
    });

    expect(screen.getByTestId("host-active-sessions").textContent).toBe(
      "2 terminals working",
    );
  });
});

describe("<HostSettingsPanel /> Overview identity card — window binding", () => {
  it("host.isActive: false renders 'Activate' in the header cluster and calls scope.makeActive with the scoped host id", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    const makeActive = vi.fn();
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: "host-a",
        isLocalMachine: true,
        connectable: true,
        // The scope fixture defaults `isActive: true`; this branch needs the
        // other one.
        isActive: false,
      }),
      hostId: "host-a",
      status: "ready",
      client: fixture.client,
      makeActive,
    };
    renderPanel(undefined);

    const button = await screen.findByTestId("host-make-active");
    // "Activate", paired with the "Active" state it produces. The old label
    // was "Use in this window" beside an "Active" badge — two vocabularies for
    // one boolean, which is what made the badge and the button read as
    // unrelated controls.
    expect(button.textContent).toBe("Activate");
    fireEvent.click(button);
    expect(makeActive).toHaveBeenCalledWith("host-a");
  });

  it("host.isActive: true renders no Activate button", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    // `scopeFrom` -> `hostScopeOptionFixture` defaults `isActive: true`.
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);

    await screen.findByText("Studio Mac");
    expect(screen.queryByTestId("host-make-active")).toBeNull();
  });
});

/**
 * A rejected `host.identity.get`, and the button it puts in the pencil's place.
 *
 * The state under test is the one BETWEEN the two reads. `failed` used to be
 * `identityQuery.isError`, and TanStack returns a query with no data behind it
 * to `pending` the moment a refetch starts (`fetchState` clears `error`) — so
 * the arm holding the retry button unmounted on the click that started the
 * retry, and the disabled pencil flickered in for the length of the read. The
 * three tests below pin the whole cycle rather than only the fix: the in-flight
 * window, and BOTH settled exits, because the counter the fix reads
 * (`errorUpdateCount`) never resets and "does the button then latch forever" is
 * the first thing that has to be answered.
 */
describe("<HostSettingsPanel /> Overview identity card — the failed-name retry", () => {
  /** A fixture whose identity read fails, then parks until the test releases it. */
  function buildRetryFixture(second: {
    readonly gate: Promise<void>;
    readonly succeeds: boolean;
  }): { readonly fixture: OverviewHostFixture; readonly calls: () => number } {
    let calls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      overrideHandlers: {
        "host.identity.get": async () => {
          calls += 1;
          if (calls === 1) throw new Error("identity read refused");
          await second.gate;
          if (!second.succeeds) throw new Error("identity read refused again");
          return {
            systemName: "studio.local",
            customName: "Studio Mac",
            effectiveName: "Studio Mac",
          };
        },
      },
    });
    return { fixture, calls: () => calls };
  }

  function mountRetryPanel(fixture: OverviewHostFixture): void {
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel(undefined);
  }

  /**
   * The native `disabled` property, not `toBeDisabled()`: jest-dom's matchers
   * are not wired into this suite, so the matcher would be undefined rather
   * than failing informatively.
   */
  function isDisabled(element: HTMLElement): boolean {
    return element instanceof HTMLButtonElement && element.disabled;
  }

  it("keeps 'Retry name' mounted and spinning for the whole retry it started", async () => {
    // Held in an object rather than a `let`: TS narrows a captured `let` to
    // `null` at the call site because it cannot prove the executor ran.
    const second: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      second.release = resolve;
    });
    const { fixture, calls } = buildRetryFixture({ gate, succeeds: true });
    mountRetryPanel(fixture);

    const retry = await screen.findByTestId("host-overview-retry-identity");
    // Idle: worded, pressable, and NOT spinning. The spinner's absence here is
    // what makes its presence below evidence of the retry rather than of the
    // button simply always carrying one.
    expect(retry.textContent).toBe("Retry name");
    expect(isDisabled(retry)).toBe(false);
    expect(
      screen.queryByTestId("host-overview-retry-identity-spinner"),
    ).toBeNull();

    fireEvent.click(retry);

    // The whole point of the fix, and an equality rather than a tolerance: the
    // SAME button is still on screen, now spinning. `findBy` would pass on a
    // remount too, so the node identity is asserted directly.
    expect(
      await screen.findByTestId("host-overview-retry-identity-spinner"),
    ).toBeTruthy();
    expect(screen.getByTestId("host-overview-retry-identity")).toBe(retry);
    expect(isDisabled(retry)).toBe(true);
    // The regression itself: the arm used to swap for the pencil, which is a
    // different affordance for a different job and is disabled while it shows.
    expect(screen.queryByRole("button", { name: "Edit name" })).toBeNull();
    expect(calls()).toBe(2);

    await act(async () => {
      second.release();
      await gate;
    });

    expect(await screen.findByText("Studio Mac")).toBeTruthy();
  });

  it("hands the pencil back once the retry succeeds — the failure is not latched", async () => {
    const { fixture } = buildRetryFixture({
      gate: Promise.resolve(),
      succeeds: true,
    });
    mountRetryPanel(fixture);

    fireEvent.click(await screen.findByTestId("host-overview-retry-identity"));

    // `errorUpdateCount` never returns to zero, so this is the assertion that
    // says the fix reads it as one half of a conjunction and not on its own:
    // a settled identity retires the retry arm however many times it failed
    // before.
    const pencil = await screen.findByRole("button", { name: "Edit name" });
    expect(isDisabled(pencil)).toBe(false);
    expect(screen.queryByTestId("host-overview-retry-identity")).toBeNull();
  });

  it("returns a pressable 'Retry name' when the retry fails again", async () => {
    const { fixture, calls } = buildRetryFixture({
      gate: Promise.resolve(),
      succeeds: false,
    });
    mountRetryPanel(fixture);

    fireEvent.click(await screen.findByTestId("host-overview-retry-identity"));

    // Settling in error a second time has to release the spinner, or the fix
    // would have traded a flicker for a permanently busy control.
    await waitFor(() => {
      expect(calls()).toBe(2);
      expect(
        screen.queryByTestId("host-overview-retry-identity-spinner"),
      ).toBeNull();
    });
    const retry = screen.getByTestId("host-overview-retry-identity");
    expect(retry.textContent).toBe("Retry name");
    expect(isDisabled(retry)).toBe(false);
  });
});
