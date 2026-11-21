import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type {
  SyncLinksFolder,
  SyncLinksListResponse,
  SyncLinksPeer,
} from "@traycer/protocol/host/sync-links-schemas";
import { provider } from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { profileWithStanding } from "@/components/settings/panels/__tests__/provider-profile-standing-fixture";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: () => ({ setProfileRecordEnabled: vi.fn() }),
  };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: () => ({ setProfileRecordEnabled: vi.fn() }),
  };
});

const HOST_ID = "host-providers-page";
const PROVIDER_ID = "claude-code";
const WORK_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN = "Signed in";
const HELD_ONE = "Moves to Personal when MacBook Air does";
const HELD_TWO = "Moves to Personal when MacBook Air and Mac mini do";

const AIR: SyncLinksPeer = {
  hostId: "host-air",
  displayName: "MacBook Air",
  version: "current",
};
const MINI: SyncLinksPeer = {
  hostId: "host-mini",
  displayName: "Mac mini",
  version: "current",
};

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function signedInRow(): ProviderProfile {
  return profileWithStanding({}, { profileId: WORK_PROFILE_ID, label: "Work" });
}

function folder(
  hold: SyncLinksFolder["hold"],
  peers: readonly SyncLinksPeer[],
): SyncLinksFolder {
  return {
    providerId: PROVIDER_ID,
    profileId: WORK_PROFILE_ID,
    label: "Work",
    accountClass: "renewing",
    hold,
    peers: [...peers],
  };
}

function renderSection(input: {
  readonly row: ProviderProfile;
  readonly syncLinks: SyncLinksListResponse | null;
}): { readonly syncListCalls: () => number } {
  let syncListCalls = 0;
  const listed = provider(PROVIDER_ID, [input.row]);
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => ({
        providers: [listed],
        native: null,
        offersSignIns: true,
      }),
      "providers.syncLinks.list": () => {
        syncListCalls += 1;
        return input.syncLinks ?? { teamComputer: false, folders: [] };
      },
    },
  });
  clientMock.current = client;
  const manifest = {
    "providers.list": { major: 10, minor: 14 },
    "providers.startLogin": { major: 1, minor: 5 },
    "providers.awaitLogin": { major: 2, minor: 4 },
    ...(input.syncLinks === null
      ? {}
      : { "providers.syncLinks.list": { major: 1, minor: 0 } }),
  };
  recordNegotiatedHostManifest(HOST_ID, manifest);
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={listed}
          hostId={HOST_ID}
          isSelectedHostLocal
          canAddProfile
          credentialRefusal={null}
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={WORK_PROFILE_ID}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { syncListCalls: () => syncListCalls };
}

describe("ProviderProfileScopedSection held for Personal", () => {
  it("replaces the status badge with the one computer that still has to move", async () => {
    const reads = renderSection({
      row: signedInRow(),
      syncLinks: {
        teamComputer: false,
        folders: [folder("held-for-personal", [AIR])],
      },
    });

    const badge = await screen.findByText(HELD_ONE);
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(reads.syncListCalls()).toBeGreaterThan(0);
  });

  it("names both computers that still have to move", async () => {
    renderSection({
      row: signedInRow(),
      syncLinks: {
        teamComputer: false,
        folders: [folder("held-for-personal", [AIR, MINI])],
      },
    });

    const badge = await screen.findByText(HELD_TWO);
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it("keeps the status badge when the folder is not held", async () => {
    const reads = renderSection({
      row: signedInRow(),
      syncLinks: {
        teamComputer: false,
        folders: [folder("none", [AIR])],
      },
    });

    await waitFor(() => expect(reads.syncListCalls()).toBeGreaterThan(0));
    const badge = screen.getByText(SIGNED_IN);
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(screen.queryByText(HELD_ONE)).toBeNull();
  });
});
