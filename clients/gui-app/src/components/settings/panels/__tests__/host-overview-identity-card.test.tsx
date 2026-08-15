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
    renderPanel();

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
    renderPanel();

    await screen.findByText("Studio Mac");
    // Pinned as ABSENT rather than left un-asserted: a reader who remembers
    // this row would otherwise assume it moved rather than went.
    expect(screen.queryByTestId("host-overview-endpoint")).toBeNull();
  });
});

describe("<HostSettingsPanel /> Overview identity card — active-sessions chip", () => {
  it("reads '1 active session' once host.status answers with busySessionCount: 1", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Studio Mac",
      busySessionCount: 1,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    const chip = await screen.findByTestId("host-active-sessions");
    expect(chip.getAttribute("data-count")).toBe("1");
    expect(chip.textContent).toBe("1 active session");
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
          };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

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
    renderPanel();

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
    renderPanel();

    await screen.findByText("Studio Mac");
    expect(screen.queryByTestId("host-make-active")).toBeNull();
  });
});
