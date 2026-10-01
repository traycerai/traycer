// T3 — Overview ▸ Updates tab: the single-row auto-update group, its work
// while the host cannot be reached, the unreachable/not-manageable list
// fallbacks, a refused install's two surfaces, and Check now (on the version
// list's heading) sharing the answer card's own check. See the `t3-updates-tab` ticket and the
// `host-overview-tabs` core-flows artifact ("Updates", "When the host can't
// answer", "What changes from today") for the behaviour each test pins.
//
// Same mocking boundary as the sibling Overview suites: `useHostScope` and
// `@/lib/host`'s `useHostBinding` are mocked rather than standing up a host
// runtime (see `host-overview-updates.test.tsx`, which this file deliberately
// does not duplicate — every case here is new coverage the ticket calls out).
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

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

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
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

// The account-write half of the auto-update row: mocked directly, the same
// boundary `host-registry-updates.test.tsx` uses, so a test can assert the
// exact write without standing up `useAuthStore`/`AuthService`.
const { mutateSpy } = vi.hoisted(() => ({ mutateSpy: vi.fn() }));
vi.mock("@/hooks/auth/use-update-host-version-mutation", () => ({
  useUpdateHostVersionPolicy: () => ({
    mutate: mutateSpy,
    isPending: false,
  }),
}));

import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods as recordNegotiatedHostMethodsByName,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/index";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  selectHostOverviewTab,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  mutateSpy.mockClear();
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

/** Only the two methods any suite in this file varies carry a negotiated minor. */
function negotiatedMinorFor(
  method: string,
  installMinor: number,
  statusMinor: number,
): number {
  if (method === "host.update.install") return installMinor;
  if (method === "host.status") return statusMinor;
  return 0;
}

function recordOverviewHostMethods(
  hostId: string,
  methods: readonly string[],
  installMinor: number,
  statusMinor: number,
): void {
  recordNegotiatedHostMethodsByName(hostId, methods);
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of methods) {
    manifest[method] = {
      major: 1,
      minor: negotiatedMinorFor(method, installMinor, statusMinor),
    };
  }
  recordNegotiatedHostManifest(hostId, manifest);
}

/** Plain method negotiation, no explicit minor — every case that doesn't need
 * `host.update.install`'s @1.3 refusal fields (`reason`/`storeFloor`). */
function recordNegotiatedHostMethods(
  hostId: string,
  methods: readonly string[],
): void {
  recordNegotiatedHostMethodsByName(hostId, methods);
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
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

function registryItemFor(
  hostId: string,
  updatePolicy: "auto" | "manual",
): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy,
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

/** A `host.update.check` manifest with the given versions, `darwin-arm64` the
 * only platform key — the shape a current CLI's projected answer takes. */
function multiVersionManifest(
  versions: readonly string[],
): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-12T00:00:00Z",
    latest: versions[0],
    versions: versions.map((version) => ({
      version,
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
          signatureAlgorithm: "minisign" as const,
          publicKeyId: "key-1",
        },
      },
    })),
  };
}

/** A successful `host.update.check` answer listing the given versions. */
function okAnswer(
  versions: readonly string[],
  includePreReleases: boolean,
): ResponseOfMethod<HostRpcRegistry, "host.update.check"> {
  return {
    outcome: "ok" as const,
    effectiveIncludePreReleases: includePreReleases,
    includePreReleasesSource: includePreReleases
      ? ("explicit-include" as const)
      : ("stable-default" as const),
    manifest: multiVersionManifest(versions),
  };
}

/** A promise a test holds open, and the one call that lets it go. */
interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release: () => void = () => {
    throw new Error("gate was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

function panelElement(
  client: QueryClient,
  runnerHost: IRunnerHost,
): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

/**
 * Renders the panel and returns a `rerender` that replays the SAME element —
 * so a test can mutate `scopeOverrides.current` (a scope flip, e.g. reachable
 * → unreachable) and force the mocked `useHostScope` to be called again, the
 * same pattern `host-overview-operation-card.test.tsx`'s
 * `renderPanelPersistent` uses.
 */
function renderPanelPersistent(): { readonly rerender: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = makeRunnerHost();
  const { rerender } = render(panelElement(client, runnerHost));
  return { rerender: () => rerender(panelElement(client, runnerHost)) };
}

function scopeFrom(
  hostId: string,
  fixture: OverviewHostFixture,
  item: HostListItem,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: false,
      connectable: true,
      item,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
    ...overrides,
  };
}

describe("<HostSettingsPanel /> Overview ▸ Updates tab", () => {
  it("draws no group label over the single-row auto-update group, and its switch still writes the account policy while the host can't be reached", async () => {
    // The ticket's own contrast: "Pick a different version" gets an explicit
    // label div ahead of its bordered group; the auto-update row does not —
    // its own title stands for the group. A regression that wrapped the row
    // in a labelled group (the way every OTHER group on this tab is) would
    // render a `<div>` whose text is "Auto-update"; today only the row's own
    // `<p>` carries that text.
    //
    // The write is an account record (`host.update.check`/`install` never
    // enter into it), which is exactly why it must keep working on a host
    // this page cannot reach — a registry row a person can still see and
    // toggle from Updates even while the host itself is offline.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      { status: "unreachable" },
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");

    // No standalone label div for the auto-update group — only its own row
    // title, which renders in a `<p>`.
    expect(screen.queryByText("Auto-update", { selector: "div" })).toBeNull();
    expect(screen.getByText("Auto-update", { selector: "p" })).toBeTruthy();

    const toggle = await screen.findByTestId("host-auto-update-host-a");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);

    expect(mutateSpy).toHaveBeenCalledWith({
      updatePolicy: "auto",
      desiredVersion: undefined,
      force: undefined,
    });
  });

  it("replaces the version list with the unreachable sentence while the auto-update row stays", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    const panel = renderPanelPersistent();

    await selectHostOverviewTab("updates");
    await screen.findByTestId("host-overview-version-picker");

    // The scope stops being usable — the host goes unreachable — with
    // nothing else about the fixture changing, the same shape a negotiated
    // peer dropping connection leaves it in.
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      { status: "unreachable" },
    );
    panel.rerender();

    await waitFor(() => {
      expect(
        screen.getByText("Connect to host-a to choose a version."),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("host-overview-version-picker")).toBeNull();
    // The account-backed row survives the very state that removed the list.
    expect(screen.getByTestId("host-auto-update-host-a")).toBeTruthy();
  });

  it("a transient refused install shows under the version list and, for a current host, as a failed-attempt card of its own, and every row unfreezes once it resolves", async () => {
    let releaseInstall: () => void = () => {
      throw new Error("install gate was not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.6.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0", "1.5.0", "1.4.0"]),
          }),
        "host.update.install": async (req) => {
          await gate;
          return {
            outcome: "cli-failed" as const,
            reason: `host-a's CLI can't downgrade to v${req.version}`,
            storeFloor: null,
          };
        },
      },
    });
    // @1.3 install negotiated so the mock's `reason`/`storeFloor` fields
    // actually decode — the store-floor suite's own precedent.
    recordOverviewHostMethods("host-a", ALL_OVERVIEW_METHODS, 3, 4);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    const targetRow = rows.find((row) => row.textContent.includes("v1.5.0"));
    const otherRow = rows.find((row) => row.textContent.includes("v1.4.0"));
    if (targetRow === undefined || otherRow === undefined) {
      throw new Error("expected both version rows to render");
    }

    fireEvent.click(
      within(targetRow).getByRole("button", { name: "Install 1.5.0" }),
    );

    // While the dispatch is in flight every row freezes — the one pressed
    // and its peers alike.
    await waitFor(() => {
      expect(
        within(otherRow)
          .getByRole("button", { name: "Install 1.4.0" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    releaseInstall();
    await gate;

    // The refusal reads once under the list, where Install was pressed …
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-version-install-refused").textContent,
      ).toContain("host-a's CLI can't downgrade to v1.5.0");
    });
    // … and once above it, from the SAME failure. This host is current
    // (1.6.0 is the latest), so the answer is quiet and there is no answer
    // for the failure to sit under: it is drawn as a card of its own, the
    // `failed-attempt` kind, and its title carries the reason.
    const failedCard = screen.getByTestId("host-overview-answer-card");
    expect(failedCard.getAttribute("data-answer")).toBe("failed-attempt");
    expect(
      within(failedCard).getByTestId("host-overview-update-attempt-failed")
        .textContent,
    ).toContain("host-a's CLI can't downgrade to v1.5.0");

    // The rows unfreeze; nothing switched tabs.
    await waitFor(() => {
      expect(
        within(otherRow)
          .getByRole("button", { name: "Install 1.4.0" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(
      screen
        .getByTestId("host-overview-tab-panel-updates")
        .getAttribute("data-state"),
    ).toBe("active");
  });

  it("a refused install under an available answer shows as the footer inside that card, not as a card of its own", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve(okAnswer(["1.6.0", "1.5.0"], false)),
        "host.update.install": () =>
          Promise.resolve({
            outcome: "cli-failed" as const,
            reason: "host-a's CLI can't install v1.6.0",
            storeFloor: null,
          }),
      },
    });
    // @1.3 install negotiated so the mock's `reason`/`storeFloor` fields
    // actually decode, as in the refused-install test above.
    recordOverviewHostMethods("host-a", ALL_OVERVIEW_METHODS, 3, 4);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");
    const card = await screen.findByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("available");
    fireEvent.click(await screen.findByTestId("host-overview-update-now"));

    // The refusal lands as the red footer INSIDE the answer that is still
    // showing: the card keeps its `available` kind, and there is only one.
    await waitFor(() => {
      expect(
        within(card).getByTestId("host-overview-update-attempt-failed")
          .textContent,
      ).toContain("host-a's CLI can't install v1.6.0");
    });
    expect(screen.getAllByTestId("host-overview-answer-card")).toHaveLength(1);
    expect(
      screen
        .getByTestId("host-overview-answer-card")
        .getAttribute("data-answer"),
    ).toBe("available");
  });

  it("Check now, with no list to show, runs the exact check the answer card uses, refreshing both from one request", async () => {
    let checkCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () => {
          checkCalls += 1;
          if (checkCalls === 1) {
            return Promise.resolve({ outcome: "invalid-output" as const });
          }
          return Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0"]),
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");
    await waitFor(() => expect(checkCalls).toBe(1));
    await screen.findByText(
      "This host didn't return a list of installable versions.",
    );

    // The page's ONE Check now sits on the version list's heading, even with
    // the list empty; the empty list carries no second copy of it.
    const check = within(
      screen.getByTestId("host-overview-version-picker"),
    ).getByTestId("host-overview-update-check");
    fireEvent.click(check);

    // ONE new request — if Check now fired its own separate ask instead of
    // the page's shared one, this would either stay at 1 (a dead button) or
    // jump straight past 2 as two instances raced.
    await waitFor(() => expect(checkCalls).toBe(2));

    // Both surfaces read the SAME answer from that one request: the list now
    // has a row, and the answer card's own sentence — leading this same
    // Updates tab — names the same version.
    await waitFor(() => {
      const rows = within(screen.getByTestId("host-version-rows"));
      expect(rows.getByText("v1.6.0")).toBeTruthy();
    });
    expect(screen.getByTestId("host-overview-updates").textContent).toContain(
      "v1.6.0 is available.",
    );
  });

  it("a structurally not-manageable host replaces the version list with its reason but keeps the auto-update row", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({ outcome: "cli-unavailable" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");

    // Scoped to the Updates pane, and exactly ONE copy. The answer card
    // leads this tab and states the reason itself (its degrade body); the
    // version list used to add the same sentence as its own fallback directly
    // under it, which read as the same notice twice.
    const updatesPane = within(
      screen.getByTestId("host-overview-tab-panel-updates"),
    );
    await waitFor(() => {
      expect(
        updatesPane.getAllByText(
          "host-a has no Traycer CLI installed to run this, so it can't be done over the connection.",
        ),
      ).toHaveLength(1);
    });
    expect(screen.queryByTestId("host-overview-version-picker")).toBeNull();
    // The reason replaces the LIST; the account-backed auto-update row is
    // untouched by a refusal the host's CLI made, not the account.
    expect(screen.getByTestId("host-auto-update-host-a")).toBeTruthy();
  });

  // T3 fixup-1: `versionConnecting` (`host-overview-panel.tsx`) never read
  // `host.health.state === "restarting"`, so an expected restart fell through
  // to whatever the scope status or operation view said instead of the
  // loading shape every other region already gives a restart. Two arms, one
  // per row of the ticket's own table.
  it("health restarting, scope unreachable with a null client: the connecting shape replaces the unreachable sentence, and the auto-update row stays", async () => {
    hostBindingMock.current = null;
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: "host-a",
        isLocalMachine: false,
        connectable: false,
        item: registryItemFor("host-a", "manual"),
        health: {
          state: "restarting",
          label: "Restarting…",
          detail: null,
          tone: "idle",
          live: false,
        },
      }),
      hostId: "host-a",
      status: "unreachable",
      client: null,
    };
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");

    const updatesPane = within(
      screen.getByTestId("host-overview-tab-panel-updates"),
    );
    await updatesPane.findByTestId("host-scope-connecting");
    // The unreachable fallback ("replaces the version list with the
    // unreachable sentence…" above) must NOT win here — an expected restart
    // is a wait, not the outage that sentence describes.
    expect(
      updatesPane.queryByText("Connect to host-a to choose a version."),
    ).toBeNull();
    // The account write keeps working through the wait, same as it does
    // through a genuine outage.
    expect(updatesPane.getByTestId("host-auto-update-host-a")).toBeTruthy();
  });

  it("health restarting, scope usable, no operation observation: the connecting shape replaces the picker", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId: "host-a",
        isLocalMachine: false,
        connectable: true,
        item: registryItemFor("host-a", "manual"),
        health: {
          state: "restarting",
          label: "Restarting…",
          detail: null,
          tone: "idle",
          live: false,
        },
      }),
      hostId: "host-a",
      status: "ready",
      // `host.status`'s default fixture answer carries no `updateOperation`
      // (`updateOperation: null`) — the health flipped before the host's own
      // report of the restart did, which is exactly the gap the fix closes.
      client: fixture.client,
    };
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );

    await selectHostOverviewTab("updates");

    const updatesPane = within(
      screen.getByTestId("host-overview-tab-panel-updates"),
    );
    await updatesPane.findByTestId("host-scope-connecting");
    expect(
      updatesPane.queryByTestId("host-overview-version-picker"),
    ).toBeNull();
  });
});

// A RE-CHECK IS NOT AN ANSWER (`describeCheckState`): the answer card must not
// unmount for the span of a re-check. Each case below holds the second
// `host.update.check` open and asserts, in that window, that the SAME card
// node is still on screen; on the old behaviour the in-flight fetch answered
// "checking", which draws no card, so `getByTestId` throws and `toBe` fails.
describe("<HostSettingsPanel /> Overview ▸ Updates tab — a re-check leaves the answer standing", () => {
  async function openUpdatesTab(fixture: OverviewHostFixture): Promise<void> {
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = scopeFrom(
      "host-a",
      fixture,
      registryItemFor("host-a", "manual"),
      {},
    );
    render(
      panelElement(
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        }),
        makeRunnerHost(),
      ),
    );
    await selectHostOverviewTab("updates");
  }

  function checkNow(): HTMLElement {
    return screen.getByTestId("host-overview-update-check");
  }

  it("Check now over an available answer keeps the card mounted (same node) with Update now disabled, and Update now returns when it settles", async () => {
    // Pins: the card must not unmount for the span of a re-check.
    const gate = makeGate();
    let checkCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () => {
          checkCalls += 1;
          if (checkCalls === 1) {
            return Promise.resolve(okAnswer(["1.6.0"], false));
          }
          return gate.promise.then(() => okAnswer(["1.6.0"], false));
        },
      },
    });
    await openUpdatesTab(fixture);

    const card = await screen.findByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("available");
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(false);
    });
    expect(
      screen.getByTestId("host-overview-update-now").hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(checkNow());
    await waitFor(() => expect(checkCalls).toBe(2));
    // The render of the in-flight re-check is on screen once Check now spins.
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(true);
    });

    expect(screen.getByTestId("host-overview-answer-card")).toBe(card);
    expect(card.getAttribute("data-answer")).toBe("available");
    expect(
      screen.getByTestId("host-overview-update-now").hasAttribute("disabled"),
    ).toBe(true);

    gate.release();
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByTestId("host-overview-answer-card")).toBe(card);
    expect(card.getAttribute("data-answer")).toBe("available");
    expect(
      screen.getByTestId("host-overview-update-now").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("ticking Include release candidates keeps the card mounted (same node) while the new check is held", async () => {
    // Pins: the card must not unmount while a query-key change re-asks the
    // host with the previous catalog kept on screen (`keepPreviousData`).
    const gate = makeGate();
    let checkCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () => {
          checkCalls += 1;
          if (checkCalls === 1) {
            return Promise.resolve(okAnswer(["1.6.0"], false));
          }
          return gate.promise.then(() => okAnswer(["1.6.0"], true));
        },
      },
    });
    await openUpdatesTab(fixture);

    const card = await screen.findByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("available");
    const checkbox = screen.getByRole("checkbox", {
      name: "Include release candidates",
    });
    await waitFor(() => {
      expect(checkbox.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkCalls).toBe(2));
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(true);
    });

    expect(screen.getByTestId("host-overview-answer-card")).toBe(card);
    expect(card.getAttribute("data-answer")).toBe("available");
    expect(
      screen.getByTestId("host-overview-update-now").hasAttribute("disabled"),
    ).toBe(true);

    gate.release();
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByTestId("host-overview-answer-card")).toBe(card);
    expect(card.getAttribute("data-answer")).toBe("available");
    expect(
      screen.getByTestId("host-overview-update-now").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("a retry of a check that failed with no catalog keeps the unreachable card, and a current answer then retires it", async () => {
    // Pins: the card must not unmount for the span of the retry. With no
    // catalog behind it TanStack drops `isError` the instant the retry starts
    // (`status` returns to pending), so only `checkSettledUnreachable`'s
    // settle counter keeps this answer from falling to the first load's
    // "checking", which draws no card.
    const gate = makeGate();
    let checkCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: false,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () => {
          checkCalls += 1;
          if (checkCalls === 1) {
            return Promise.reject(new Error("host unreachable"));
          }
          return gate.promise.then(() => okAnswer(["1.5.0"], false));
        },
      },
    });
    await openUpdatesTab(fixture);

    const card = await screen.findByTestId("host-overview-answer-card");
    expect(card.getAttribute("data-answer")).toBe("unreachable");
    expect(checkCalls).toBe(1);
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(checkNow());
    await waitFor(() => expect(checkCalls).toBe(2));
    await waitFor(() => {
      expect(checkNow().hasAttribute("disabled")).toBe(true);
    });

    expect(screen.getByTestId("host-overview-answer-card")).toBe(card);
    expect(card.getAttribute("data-answer")).toBe("unreachable");

    // The retry answers with the version the host already runs: latest, which
    // is quiet, so the card goes away for the RIGHT reason and not before.
    gate.release();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-answer-card")).toBeNull();
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-version-rows")).getByText("v1.5.0"),
      ).toBeTruthy();
    });
  });
});
