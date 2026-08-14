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

/**
 * A `host.update.check` manifest with an arbitrary number of versions, in the
 * same shape `updateCheckManifest` (`host-overview-test-support.ts`) builds —
 * that helper deliberately produces only ONE entry, so the multi-version
 * cases here assemble the manifest by hand instead of growing a second
 * exported helper for a shape only this file needs.
 */
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
    const requests: boolean[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.0.0",
      overrideHandlers: {
        "host.update.check": (req) => {
          requests.push(req.includePreReleases);
          return Promise.resolve({
            outcome: "ok" as const,
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
    // whether it produces a SECOND `false` request or silently joins the
    // in-flight one is a matter of timing, and `toEqual([false])` passes on only
    // one of those. That the list arrives at all without a click is the
    // behaviour this line now also pins.
    await openHostOverviewAdvanced();
    await waitFor(() => expect(requests).toEqual([false]));

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include release candidates" }),
    );

    // A SECOND request, carrying the flag — not the same answer re-filtered.
    await waitFor(() => expect(requests).toEqual([false, true]));
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
            manifest: multiVersionManifest(["1.7.0", "1.6.0", "1.5.0"]),
          }),
        "host.update.install": async (req) => {
          installedVersions.push(req.version);
          await gate;
          return { outcome: "accepted" as const };
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
            manifest: multiVersionManifest(["1.7.0", "1.6.0", "1.5.0"]),
          }),
        "host.update.install": (req) => {
          attempted.push(req.version);
          return Promise.resolve({ outcome: "accepted" as const });
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
          Promise.resolve({ outcome: "ok" as const, manifest: yankedLatest }),
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
            manifest: multiVersionManifest(["1.6.0"]),
          }),
        "host.update.install": () =>
          Promise.resolve({ outcome: "already-updating" as const }),
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
});
