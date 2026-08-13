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
import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/index";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { VERSION_LIST_PREVIEW } from "@/components/settings/panels/host-settings-panel-model";
import {
  buildOverviewHostFixture,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

/**
 * The version PICKER that replaced the single "Update to v<latest>" button
 * (`host-overview-updates.tsx` / `host-version-rows.tsx`): `host.update.check`
 * now hands back the whole manifest, every entry gets its own row, and Install
 * targets whichever row it was clicked on rather than always `manifest.latest`.
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
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    fireEvent.click(
      within(rowFor(rows, "1.6.0")).getByRole("button", { name: "Install" }),
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
          .getByRole("button", { name: "Install" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        within(rowFor(rows, "1.5.0"))
          .getByRole("button", { name: "Install" })
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
    const picker = await screen.findByTestId("host-version-rows");
    const rows = within(picker).getAllByRole("listitem");

    // Newer than installed — the one row that can actually do something.
    expect(
      within(rowFor(rows, "1.7.0"))
        .getByRole("button", { name: "Install" })
        .hasAttribute("disabled"),
    ).toBe(false);
    // Older than installed — dead, and says why rather than leaving a person
    // to discover it by clicking and watching nothing happen.
    expect(
      within(rowFor(rows, "1.5.0"))
        .getByRole("button", { name: "Install" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(rowFor(rows, "1.5.0").textContent).toContain("Already on v1.6.0");

    fireEvent.click(
      within(rowFor(rows, "1.5.0")).getByRole("button", { name: "Install" }),
    );
    expect(attempted).toEqual([]);
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
