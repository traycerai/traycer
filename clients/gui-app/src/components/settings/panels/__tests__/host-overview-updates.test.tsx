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

import type { ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { VERSION_LIST_PREVIEW } from "@/components/settings/panels/host-settings-panel-model";
import {
  buildOverviewHostFixture,
  openHostOverviewAdvanced,
  openHostOverviewMenu,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

/**
 * The version PICKER that replaced the single "Update to v<latest>" button
 * (`host-overview-updates.tsx` / `host-version-rows.tsx`): `host.update.check`
 * now hands back the whole manifest, every entry gets its own row, and Install
 * targets whichever row it was clicked on rather than always `manifest.latest`.
 */

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
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

async function waitForButton(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name });
}

/**
 * The panel tree, over a caller-supplied query client.
 *
 * Split from `renderPanel` so a test can RE-render the same element with the
 * same client — which is what a scoped-host switch actually is. Building a
 * fresh client would tear the subtree down instead, and a test whose subtree
 * remounts cannot observe state that is supposed to survive a remount or be
 * cleared without one.
 */
function panelElement(client: QueryClient): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={makeRunnerHost()}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderPanel(): RenderResult & { readonly queryClient: QueryClient } {
  const queryClient = newQueryClient();
  return { ...render(panelElement(queryClient)), queryClient };
}

/**
 * A `host.update.check` manifest with an arbitrary number of versions, in the
 * same shape `updateCheckManifest` (`host-overview-test-support.ts`) builds —
 * that helper deliberately produces only ONE entry, so the multi-version
 * cases here assemble the manifest by hand instead of growing a second
 * exported helper for a shape only this file needs.
 */
/** The provenance an explicit override produces — never `installed-rc`. */
function sourceForExplicit(
  include: boolean,
): "explicit-include" | "explicit-exclude" {
  return include ? "explicit-include" : "explicit-exclude";
}

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

/**
 * A one-version manifest whose entry carries exactly ONE platform key — the
 * ambiguous shape `platformAssetFor` must judge: a current CLI's projected
 * answer and a legacy single-platform release both look like this, and only
 * the registry's platform string says which host the key belongs to.
 */
function soleKeyManifest(
  version: string,
  soleKey: string,
): HostAvailableManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-12T00:00:00Z",
    latest: version,
    versions: [
      {
        version,
        releasedAt: "2026-08-12T00:00:00Z",
        releaseNotesUrl: "https://example.invalid/notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          [soleKey]: {
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
      },
    ],
  };
}

function rowFor(rows: readonly HTMLElement[], version: string): HTMLElement {
  const row = rows.find((candidate) =>
    candidate.textContent.includes(`v${version}`),
  );
  if (row === undefined) {
    throw new Error(`no version row rendered for v${version}`);
  }
  return row;
}

describe("<HostSettingsPanel /> Overview updates — version picker", () => {
  it("populates the version list and the summary WITHOUT anyone pressing Check now", async () => {
    // The check used to be a mutation, so both surfaces started empty: the
    // summary read "Ask this host which versions it can install." and the picker
    // read "Check for updates to see which versions this host can install." —
    // inside a disclosure you had already opened in order to see versions. This
    // pins that opening the page IS the ask.
    //
    // Asserting the ROWS, not just the request: a check that fired but whose
    // answer never reached the picker would satisfy a call-count assertion and
    // still leave the empty state on screen, which is the exact complaint.
    let checkCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () => {
          checkCalls += 1;
          return Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.7.0", "1.6.0"]),
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The summary answers on its own — no longer an invitation to go ask.
    await screen.findByText("v1.7.0 is available.");
    expect(screen.queryByText(/Ask this host which versions/)).toBeNull();

    await openHostOverviewAdvanced();
    await waitFor(() => {
      const rows = within(screen.getByTestId("host-version-rows"));
      expect(rows.getByText("v1.7.0")).toBeTruthy();
      expect(rows.getByText("v1.6.0")).toBeTruthy();
    });
    expect(
      screen.queryByText(/didn't return a list of installable versions/),
    ).toBeNull();
    // ONE request served both surfaces. Two would mean the summary and the
    // picker had each gone asking, which is what sharing the hook prevents.
    expect(checkCalls).toBe(1);
  });

  it("the release-candidate checkbox RE-ASKS the host with includePreReleases, rather than filtering a list already in hand", async () => {
    // Re-pins, on the RPC path, the one invariant the deleted bridge suite
    // owned ("passes the include prereleases filter when the Advanced version
    // picker checkbox is selected"). It has to be a fresh REQUEST: `host
    // available` decides what counts as a pre-release, and a client-side
    // predicate would disagree with the CLI the first time a build id stopped
    // being semver.
    // `boolean | undefined`, because ABSENT is one of the three states this
    // records - a `boolean[]` could not tell the default apart from an
    // explicit exclude, which is the distinction under test.
    const requests: Array<boolean | undefined> = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": (req) => {
          requests.push(req.includePreReleases);
          return Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(
              req.includePreReleases ? ["1.8.0-rc.1", "1.7.0"] : ["1.7.0"],
            ),
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // NO "Check now" click, and its removal is load-bearing rather than tidying.
    // The check fires on mount now, so a click here would race its own setup:
    // whether it produces a SECOND default request or silently joins the
    // in-flight one is a matter of timing, and the assertion below passes on
    // only one of those. That the list arrives at all without a click is the
    // behaviour this line now also pins.
    await openHostOverviewAdvanced();
    // ABSENT, not `false`. The first load states no override at all, which is
    // what lets the host derive inclusion from its own installed version; a
    // `false` here would be an explicit exclusion nobody asked for, and would
    // hide the RC line from exactly the hosts that should see it.
    await waitFor(() => expect(requests).toEqual([undefined]));

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include release candidates" }),
    );

    // A SECOND request, carrying the flag — not the same answer re-filtered.
    await waitFor(() => expect(requests).toEqual([undefined, true]));
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-version-rows")).getByText(
          "v1.8.0-rc.1",
        ),
      ).toBeTruthy();
    });
  });

  it("Check now renders one row per manifest version, Install on a non-latest row sends host.update.install with THAT row's version, and freezes every other row's Install button while it is in flight", async () => {
    // Pins the replacement for the single "Update to v<latest>" button: the
    // manifest can name several installable versions, and a person must be
    // able to pick one that is NOT `latest`. A regression that always wired
    // Install to `manifest.latest` would pass every pre-existing suite
    // (which only ever stubbed one version) and only fail here.
    let releaseInstall: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installedVersions: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.7.0", "1.6.0", "1.5.0"]),
          }),
        "host.update.install": async (req) => {
          installedVersions.push(req.version);
          await gate;
          return { outcome: "accepted" as const, attemptId: null };
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    // The list moved into the Advanced disclosure, which Radix does not mount
    // while closed — so this is the difference between "no rows" and "no drawer".
    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    fireEvent.click(
      within(rowFor(rows, "1.6.0")).getByRole("button", {
        name: "Install 1.6.0",
      }),
    );

    await waitFor(() => {
      expect(installedVersions).toEqual(["1.6.0"]);
    });

    // The two rows NOT clicked — one of them `latest` — are frozen too: one
    // detached host swap can't run a second install at the same time, so
    // "disable only the clicked row" is the wrong shape for this control.
    await waitFor(() => {
      expect(
        within(rowFor(rows, "1.7.0"))
          .getByRole("button", { name: "Install 1.7.0" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        within(rowFor(rows, "1.5.0"))
          .getByRole("button", { name: "Install 1.5.0" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    await act(async () => {
      releaseInstall?.();
      await gate;
    });
  });

  it("a row BELOW the installed version is not installable, because the CLI would short-circuit it and report nothing back", async () => {
    // The picker's premise is that a row means what it says. The CLI computes
    // `installedAtOrAboveTarget` and returns `installed-up-to-date` for a
    // target at OR BELOW what is installed (`download-stage.ts`), then skips
    // the apply and writes no progress marker — while `host.update.install`
    // has already answered `accepted`, because it returns at spawn. So an
    // enabled Install on an older row toasts "Updating…" for a host that will
    // do nothing and then say nothing. Every up-to-date host hits this the
    // moment "Show all" exposes its history.
    const attempted: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.6.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.7.0", "1.6.0", "1.5.0"]),
          }),
        "host.update.install": (req) => {
          attempted.push(req.version);
          return Promise.resolve({
            outcome: "accepted" as const,
            attemptId: null,
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    // The list moved into the Advanced disclosure, which Radix does not mount
    // while closed — so this is the difference between "no rows" and "no drawer".
    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");

    // Newer than installed — the one row that can actually do something.
    expect(
      within(rowFor(rows, "1.7.0"))
        .getByRole("button", { name: "Install 1.7.0" })
        .hasAttribute("disabled"),
    ).toBe(false);
    // Older than installed — dead, and says why rather than leaving a person
    // to discover it by clicking and watching nothing happen.
    expect(
      within(rowFor(rows, "1.5.0"))
        .getByRole("button", { name: "Install 1.5.0" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(rowFor(rows, "1.5.0").textContent).toContain("Already on v1.6.0");

    fireEvent.click(
      within(rowFor(rows, "1.5.0")).getByRole("button", {
        name: "Install 1.5.0",
      }),
    );
    expect(attempted).toEqual([]);
  });

  it("a YANKED latest is never offered by the summary — the row disables it and the CLI's resolveAsset refuses it, so an offer would dispatch a guaranteed rejection", async () => {
    const manifest = multiVersionManifest(["1.7.0", "1.6.0"]);
    const yankedLatest = {
      ...manifest,
      versions: manifest.versions.map((entry) =>
        entry.version === "1.7.0" ? { ...entry, yanked: true } : entry,
      ),
    };
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: yankedLatest,
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The summary tells the truth instead of advertising a version the CLI
    // would refuse: no plain "available", no Update now.
    await screen.findByText(
      "v1.7.0 is available, but host-a can't install it.",
    );
    expect(screen.queryByText("v1.7.0 is available.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();

    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    expect(
      within(rowFor(rows, "1.7.0"))
        .getByRole("button", { name: "Install 1.7.0" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("a sole platform key belonging to ANOTHER OS is a legacy one-platform release, not the host's projected answer — nothing is offered", async () => {
    // The fixture scope's registry platform is darwin-arm64; a legacy
    // (pre-projection) CLI hands back the full map, and a version released
    // only for linux gives that map exactly one key. Trusting it as "the
    // host's own answer" would offer an install the host CLI then refuses
    // during asset resolution.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: soleKeyManifest("1.7.0", "linux-x64"),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByText(
      "v1.7.0 is available, but host-a can't install it.",
    );
    expect(screen.queryByText("v1.7.0 is available.")).toBeNull();

    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    await waitFor(() => {
      const rows = within(picker).getAllByRole("listitem");
      expect(
        within(rowFor(rows, "1.7.0"))
          .getByRole("button", { name: "Install 1.7.0" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(rowFor(rows, "1.7.0").textContent).toContain(
        "No asset for this platform.",
      );
    });
  });

  it("a win32-arm64 host's sole win32-x64 key IS its projected answer — the emulated build the CLI itself resolves to stays installable", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: soleKeyManifest("1.7.0", "win32-x64"),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      // `currentHostPlatformKey()` maps win32/arm64 to the emulated x64 build,
      // so this registry row and that manifest key describe the SAME host.
      host: hostScopeOptionFixture({
        hostId: "host-a",
        isLocalMachine: true,
        connectable: true,
        platform: "win32-arm64",
      }),
    };
    renderPanel();

    await screen.findByText("v1.7.0 is available.");
    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    expect(
      within(rowFor(rows, "1.7.0"))
        .getByRole("button", { name: "Install 1.7.0" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("an install arming the page-wide gate CLOSES an already-open deregister confirmation — its question is stale and its confirm would dispatch mid-swap", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0"]),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", [
      ...ALL_OVERVIEW_METHODS,
      "host.service.status",
      "host.service.register",
      "host.service.deregister",
    ]);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await openHostOverviewAdvanced();
    // Grab the Install button BEFORE the dialog opens: Radix marks the page
    // behind an open dialog aria-hidden, which removes the rows from the
    // accessibility tree that role queries search.
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    const installButton = within(rowFor(rows, "1.6.0")).getByRole("button", {
      name: "Install 1.6.0",
    });

    fireEvent.click(
      await screen.findByTestId("host-overview-service-deregister"),
    );
    await screen.findByTestId("confirm-destructive-dialog");

    fireEvent.click(installButton);

    // The accepted install arms the gate; the open confirmation must go with
    // it — a confirm click after this point would re-register/deregister a
    // host that is swapping its installation.
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("an ALREADY-UPDATING answer keeps the page locked — someone else's swap is running in the same blind window the latch covers", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0"]),
          }),
        "host.update.install": () =>
          Promise.resolve({
            outcome: "already-updating" as const,
            attemptId: null,
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(false);
    });

    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    fireEvent.click(
      within(rowFor(rows, "1.6.0")).getByRole("button", {
        name: "Install 1.6.0",
      }),
    );

    // Wait for the SETTLE (its toast), not just the dispatch — the dispatch
    // arms the latch unconditionally, so only the post-settle state proves
    // the answer RETAINED it rather than releasing it as a refusal.
    await waitFor(() => {
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
        "host-a is already installing an update.",
      );
    });
    expect(
      screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("an ACCEPTED install locks the rename pencil and Run doctor with the rest of the page — neither may dispatch against a host mid-swap", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0"]),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // Enabled BEFORE the install — so the lock below is caused by the click,
    // not by a fixture that never let the pencil load.
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(false);
    });

    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    fireEvent.click(
      within(rowFor(rows, "1.6.0")).getByRole("button", {
        name: "Install 1.6.0",
      }),
    );

    // `accepted` returns at spawn and progress never surfaces in this fixture,
    // so what holds the page is the dispatch-armed accepted latch — the same
    // gate every other Overview verb consumes.
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(true);
    });
    await openHostOverviewMenu();
    expect(
      screen
        .getByTestId("host-overview-run-doctor")
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("G9.4 — a 'dispatch-indeterminate' host.update.install answer RELEASES the accepted latch and still invalidates host.status", async () => {
    // The `dispatch-indeterminate` arm (protocol @1.1) means the host spawned
    // a detached CLI but cannot attribute a durable attempt to this dispatch —
    // not a success, not a refusal. `useHostUpdateInstall`'s `onSuccess` must
    // NOT arm/must release `armUpdateInstallAccepted` for it (that 60s lockout
    // belongs to `accepted` alone), while still re-arming the `host.status`
    // read so `updateOperation` — the negotiated route to live progress for
    // this call — gets a chance to reveal what is actually happening.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(["1.6.0"]),
          }),
        "host.update.install": () =>
          Promise.resolve({
            outcome: "dispatch-indeterminate" as const,
            reason: "ack-timeout",
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(false);
    });
    const statusCallsBeforeInstall = fixture.hostStatusCalls();

    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    fireEvent.click(
      within(rowFor(rows, "1.6.0")).getByRole("button", {
        name: "Install 1.6.0",
      }),
    );

    // Wait for the informative settle toast — the dispatch-uncertain wording,
    // not the accepted or already-updating one.
    await waitFor(() => {
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
        "Couldn't confirm the update started on host-a: ack-timeout. Watching for progress.",
      );
    });

    // THE LATCH IS NOT ARMED: unlike the `accepted` case (which locks the
    // rename pencil), the rename control stays usable straight through the
    // settle — there is no window where this outcome froze the page.
    expect(
      screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
    ).toBe(false);

    // `host.status` WAS re-armed — the invalidation this outcome still
    // performs, distinguishing it from a pure refusal that no re-read follows.
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(
        statusCallsBeforeInstall,
      );
    });
  });

  it(`more than VERSION_LIST_PREVIEW (${VERSION_LIST_PREVIEW}) versions shows only the preview slice plus a toggle; clicking it reveals the rest and relabels to "Show recent"`, async () => {
    const versions = Array.from(
      { length: VERSION_LIST_PREVIEW + 2 },
      (_, index) => `2.${index}.0`,
    );
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
            manifest: multiVersionManifest(versions),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    fireEvent.click(await waitForButton("Check now"));
    // The list moved into the Advanced disclosure, which Radix does not mount
    // while closed — so this is the difference between "no rows" and "no drawer".
    await openHostOverviewAdvanced();
    const picker = await screen.findByTestId("host-version-rows");
    expect(within(picker).getAllByRole("listitem")).toHaveLength(
      VERSION_LIST_PREVIEW,
    );

    const toggle = screen.getByTestId("host-version-rows-toggle");
    expect(toggle.textContent).toBe("Show all");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-version-rows")).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(versions.length);
    });
    expect(screen.getByTestId("host-version-rows-toggle").textContent).toBe(
      "Show recent",
    );
  });

  /**
   * The v1.1 tri-state, from the checkbox down to the wire.
   *
   * The state under test is the one a boolean could not express: a host whose
   * DEFAULT catalog already includes release candidates, where "unchecked" and
   * "never touched" have to reach the host as different requests or unticking
   * the box does nothing at all (critique finding 7).
   */
  it("sends an explicit exclude when the box is unticked on a host whose default includes RCs", async () => {
    const requests: Array<boolean | undefined> = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "2.0.0-rc.1",
      overrideHandlers: {
        "host.update.check": (req) => {
          requests.push(req.includePreReleases);
          // What an RC host's CLI answers: with no flag it DERIVES inclusion
          // from the install and says so; an explicit flag is obeyed verbatim.
          const derived = req.includePreReleases === undefined;
          const included = derived || req.includePreReleases === true;
          const source = derived
            ? ("installed-rc" as const)
            : sourceForExplicit(req.includePreReleases === true);
          return Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: included,
            includePreReleasesSource: source,
            manifest: multiVersionManifest(
              included ? ["2.0.0-rc.2", "1.7.0"] : ["1.7.0"],
            ),
          });
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await openHostOverviewAdvanced();
    await waitFor(() => expect(requests).toEqual([undefined]));

    const checkbox = await screen.findByRole("checkbox", {
      name: "Include release candidates",
    });
    // TICKED before any interaction: the box reports what the catalog did, and
    // this catalog included RCs. Rendering it unticked beside visible RC rows
    // would be the control contradicting the list under it.
    await waitFor(() =>
      expect(checkbox.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-version-rows")).getByText(
          "v2.0.0-rc.2",
        ),
      ).toBeTruthy();
    });

    fireEvent.click(checkbox);

    // FALSE, not absent. Absent would re-ask the same question and get the
    // same RC rows back.
    await waitFor(() => expect(requests).toEqual([undefined, false]));
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-version-rows")).queryByText(
          "v2.0.0-rc.2",
        ),
      ).toBeNull();
    });
  });

  it("explains an RC-derived catalog, and says nothing when provenance is not installed-rc", async () => {
    async function renderWithSource(
      source: "installed-rc" | "stable-default",
      hostId: string,
    ): Promise<void> {
      const fixture = buildOverviewHostFixture({
        hostId,
        isLocalMachine: true,
        hostVersion: "2.0.0-rc.1",
        overrideHandlers: {
          "host.update.check": () =>
            Promise.resolve({
              outcome: "ok" as const,
              effectiveIncludePreReleases: source === "installed-rc",
              includePreReleasesSource: source,
              manifest: multiVersionManifest(["1.7.0"]),
            }),
        },
      });
      recordNegotiatedHostMethods(hostId, ALL_OVERVIEW_METHODS);
      hostBindingMock.current = { hostClient: fixture.client };
      scopeOverrides.current = scopeFrom(hostId, fixture);
      renderPanel();
      await openHostOverviewAdvanced();
    }

    await renderWithSource("installed-rc", "host-a");
    const reason = await screen.findByTestId(
      "host-overview-include-pre-releases-reason",
    );
    // Provenance, phrased as a fact about the host. It must not imply a saved
    // preference, because there is none to turn off.
    expect(reason.textContent).toContain("2.0.0-rc.1");

    cleanup();

    // `stable-default` is also what the v1.0->v1.1 bridge reports for an old
    // host, which is exactly why the copy is gated on `installed-rc` alone:
    // that value is unreachable from a peer that derived nothing, so a
    // negotiated v1.0 response can never produce an explanation.
    await renderWithSource("stable-default", "host-b");
    expect(
      screen.queryByTestId("host-overview-include-pre-releases-reason"),
    ).toBeNull();
  });

  it("offers matching stable over a later same-line RC when latest still lags", async () => {
    // `latest` is stable-CHANNEL metadata. On a host running 2.0.0-rc.1 it can
    // still read 1.9.0 while 2.0.0 is published, so a summary keyed off
    // `latest` would offer a DOWNGRADE - or, once the strictly-newer gate
    // rejected it, claim the host was up to date with its own stable sitting
    // in the list. Matching stable also wins over the later RC, which is what
    // makes implicit following terminate.
    const manifest = multiVersionManifest(["2.0.0-rc.2", "2.0.0", "1.9.0"]);
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "2.0.0-rc.1",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "installed-rc" as const,
            manifest: { ...manifest, latest: "1.9.0" },
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("v2.0.0 is available.")).toBeTruthy();
    });
  });

  it("asks a newly scoped host with no override, discarding the previous host's filter", async () => {
    // The override is a decision about ONE machine, and this pins the
    // OBSERVABLE rule: whatever host Settings scopes to next is asked with no
    // override, so it gets its own derived default.
    //
    // Two mechanisms enforce that today and this test does not distinguish
    // them: the panel remounts under a host key, AND `useHostOverviewUpdates`
    // clears the override when `hostId` changes. The hook-level clear is the
    // backstop for the day the key changes — isolating it would need the
    // condition-poll coordinator harness the panel provides, so it is covered
    // here at the level a user would notice.
    const requestsByHost: Array<{
      readonly hostId: string;
      readonly includePreReleases: boolean | undefined;
    }> = [];
    function fixtureFor(hostId: string): OverviewHostFixture {
      const fixture = buildOverviewHostFixture({
        hostId,
        isLocalMachine: true,
        hostVersion: "2.0.0-rc.1",
        overrideHandlers: {
          "host.update.check": (req) => {
            requestsByHost.push({
              hostId,
              includePreReleases: req.includePreReleases,
            });
            return Promise.resolve({
              outcome: "ok" as const,
              effectiveIncludePreReleases: req.includePreReleases !== false,
              includePreReleasesSource:
                req.includePreReleases === undefined
                  ? ("installed-rc" as const)
                  : ("explicit-exclude" as const),
              manifest: multiVersionManifest(["1.7.0"]),
            });
          },
        },
      });
      recordNegotiatedHostMethods(hostId, ALL_OVERVIEW_METHODS);
      return fixture;
    }

    const hostA = fixtureFor("host-a");
    hostBindingMock.current = { hostClient: hostA.client };
    scopeOverrides.current = scopeFrom("host-a", hostA);
    const view = renderPanel();

    await openHostOverviewAdvanced();
    await waitFor(() =>
      expect(requestsByHost).toEqual([
        { hostId: "host-a", includePreReleases: undefined },
      ]),
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include release candidates" }),
    );
    await waitFor(() =>
      expect(requestsByHost).toContainEqual({
        hostId: "host-a",
        includePreReleases: false,
      }),
    );

    const hostB = fixtureFor("host-b");
    hostBindingMock.current = { hostClient: hostB.client };
    scopeOverrides.current = scopeFrom("host-b", hostB);
    view.rerender(panelElement(view.queryClient));

    // host-b is asked with NO override — host-a's exclusion did not follow it.
    await waitFor(() =>
      expect(
        requestsByHost.filter((entry) => entry.hostId === "host-b"),
      ).toEqual([{ hostId: "host-b", includePreReleases: undefined }]),
    );
  });

  it("does not claim an abandoned-line RC is on the latest version while a newer row is listed", async () => {
    // The regression this batch created: with `installed-rc` and NOTHING on
    // the installed line, `targetCandidates` is empty, so the summary read
    // "This host is running the latest version." — directly above an enabled,
    // installable row for a newer version on another line.
    //
    // Not moving automatically is deliberate (a follower must not be pushed
    // onto a line nobody put it on). Saying it is already latest is not.
    const manifest = multiVersionManifest(["2.1.0", "1.9.0"]);
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "2.0.0-rc.1",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "installed-rc" as const,
            manifest,
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(
        screen.queryByText("This host is running the latest version."),
      ).toBeNull();
    });
    const summary = await screen.findByText(/2\.1\.0 is available/);
    // Names the newer version AND says it will not be taken automatically, so
    // the sentence and the enabled row below it agree.
    expect(summary.textContent).toContain("2.0.0-rc.1");
    expect(summary.textContent).toContain("won't update to it automatically");

    // The manual route stays open: the newer row is present and installable.
    await openHostOverviewAdvanced();
    const rows = within(await screen.findByTestId("host-version-rows"));
    const row = rowFor(rows.getAllByRole("listitem"), "2.1.0");
    expect(
      within(row)
        .getByRole("button", { name: "Install 2.1.0" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("still says up to date when the abandoned line really is the newest build", async () => {
    // The other half: no same-line candidate AND nothing newer anywhere. The
    // original sentence is correct here and must survive.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "2.0.0-rc.1",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "installed-rc" as const,
            manifest: multiVersionManifest(["1.9.0"]),
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByText("This host is running the latest version."),
      ).toBeTruthy();
    });
  });

  it("falls back to the HIGHEST later same-line RC when the line's stable is unusable", async () => {
    // Exercises the ordered candidate list end to end: matching stable first,
    // then later RCs newest-first. The stable is yanked, so the gate loop must
    // walk past it — and must land on rc.3 rather than rc.2, which is what the
    // ordering (and its now-lawful comparator) is for.
    const base = multiVersionManifest([
      "2.0.0",
      "2.0.0-rc.3",
      "2.0.0-rc.2",
      "1.9.0",
    ]);
    const manifest = {
      ...base,
      latest: "1.9.0",
      versions: base.versions.map((entry) =>
        entry.version === "2.0.0" ? { ...entry, yanked: true } : entry,
      ),
    };
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "2.0.0-rc.1",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "installed-rc" as const,
            manifest,
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("v2.0.0-rc.3 is available.")).toBeTruthy();
    });
  });

  it("does not tell a STABLE host it follows a release line when explicit include surfaces a newer RC", async () => {
    // The stranded-line sentence explains a mechanism — "follows its own
    // release line" — that applies only to a host whose catalog was DERIVED
    // from an installed release candidate. This host is stable, on the newest
    // stable, and sees an RC row only because the user ticked the box. Gating
    // the copy on `upToDate` alone would have narrated that state with a
    // mechanism the host is not subject to.
    const base = multiVersionManifest(["2.0.0-rc.1", "1.9.0"]);
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.9.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            effectiveIncludePreReleases: true,
            includePreReleasesSource: "explicit-include" as const,
            // `latest` is the STABLE the host is already on; the RC is newer
            // but is not what the stable channel points at.
            manifest: { ...base, latest: "1.9.0" },
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(() => {
      expect(
        screen.getByText("This host is running the latest version."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/follows its own release line/)).toBeNull();

    // The RC the user asked to see is still there and still installable — the
    // gate changes the sentence, never the manual route.
    await openHostOverviewAdvanced();
    const rows = within(await screen.findByTestId("host-version-rows"));
    const row = rowFor(rows.getAllByRole("listitem"), "2.0.0-rc.1");
    expect(
      within(row)
        .getByRole("button", { name: "Install 2.0.0-rc.1" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
