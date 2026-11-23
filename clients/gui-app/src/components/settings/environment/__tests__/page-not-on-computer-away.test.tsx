// A Local pick of a computer this app cannot reach answers every page it lacks
// with "Can't reach {name} from here", never with Update: nothing on it can be
// updated until it is back. A computer that is reachable and merely below the
// minimum version keeps the update. The scope is the real one over a stood-in
// host list, so the status comes from the host's own facts.
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/minimum-host-version")
    >()),
    MINIMUM_HOST_VERSION: "2.0.0",
  }),
);

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
      }),
  };
});
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import { PageOrNotOnComputer } from "@/components/settings/environment/page-not-on-computer";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { pickOldHostLocal } from "@/components/settings/__tests__/old-host-pick-fixture";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { ReactNode } from "react";

/** A computer whose app is older than the minimum the Settings pages need. */
function belowMinimumEntry(hostId: string): RemoteHostDirectoryEntry {
  const base = remoteEntry(hostId, null);
  return {
    ...base,
    version: "1.5.4",
    remoteStatus: { ...base.remoteStatus, appVersion: "1.5.4" },
  };
}

function listOldHost(overrides: Partial<HostScopeOption>): void {
  harness.hosts = [
    hostScopeOptionFixture({
      hostId: "host-old",
      name: "Old laptop",
      isLocalMachine: false,
      isActive: false,
      ...overrides,
    }),
  ];
}

/** Concealed or absent: the page stays mounted beneath the notice, out of view. */
function expectHiddenFromView(node: Element | null): void {
  expect(node === null || isConcealed(node)).toBe(true);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function pageElement(section: SettingsSectionId): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <PageOrNotOnComputer section={section}>
        <input data-testid="draft" />
      </PageOrNotOnComputer>
    </QueryClientProvider>
  );
}

function renderSecrets(): void {
  render(pageElement("secrets"));
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  harness.hosts = [];
  harness.activeHostId = null;
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

describe("Secrets under a Local pick of an old computer", () => {
  it("shows Can't reach, not Update, when the computer has no connection to this app", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  it("shows Can't reach, not Update, when the computer is below the minimum version and has no connection", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: false,
      entry: belowMinimumEntry("host-old"),
    });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  it("keeps the update when the computer is connected and merely below the minimum version", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: true,
      entry: belowMinimumEntry("host-old"),
    });

    renderSecrets();

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(
      screen.getByTestId("page-not-on-computer-update").textContent,
    ).toContain("Update Old laptop to use Secrets.");
  });
});

describe("A page an old computer has, under a Local pick that goes out of reach and comes back", () => {
  it("shows only the notice while it is out of reach, and gives back the draft typed before", () => {
    pickOldHostLocal();
    harness.activeHostId = "host-old";
    listOldHost({ connectable: true, isActive: true });
    const view = render(pageElement("providers"));
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    fireEvent.change(screen.getByTestId("draft"), {
      target: { value: "keep this draft" },
    });

    listOldHost({ connectable: false, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("draft"));

    listOldHost({ connectable: true, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.getByTestId("draft")).toHaveProperty(
      "value",
      "keep this draft",
    );
  });
});
