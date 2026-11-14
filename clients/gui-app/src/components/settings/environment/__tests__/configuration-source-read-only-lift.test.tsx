import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentInvitation,
} from "@traycer/protocol/host/environment/contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  ConfigurationSourceBoundary,
  type CloudConfigurationTarget,
} from "@/components/settings/environment/configuration-source-boundary";
import { TeamGuide } from "@/components/settings/environment/team-guide";
import { useCanEditConfiguration } from "@/components/settings/environment/configuration-source";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { negotiateMethodsOn } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

const VERSION_1 = { major: 1, minor: 0 } as const;

const PERSONAL: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

function team(role: string): EnvironmentDescriptorV11 {
  return {
    environmentId: "env-team",
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-team",
    label: "Acme",
    effectiveRole: role as EnvironmentDescriptorV11["effectiveRole"],
    kind: "team",
    hostCount: 1,
    providerHandle: "acme",
  };
}

const TEAM_COMPUTER: HostDirectoryEntry = {
  ...remoteEntry("host-team", null),
  owner: { kind: "team", id: "team-a", name: "Acme" },
};

const OTHER_COMPUTER: HostDirectoryEntry = {
  ...remoteEntry("host-personal", null),
  owner: { kind: "user", id: "user-me" },
};

const ACCESS_CASES = [
  {
    role: "admin",
    canEdit: true,
    selected: "team computer",
    activeHost: TEAM_COMPUTER,
  },
  {
    role: "editor",
    canEdit: true,
    selected: "team computer",
    activeHost: TEAM_COMPUTER,
  },
  {
    role: "viewer",
    canEdit: false,
    selected: "team computer",
    activeHost: TEAM_COMPUTER,
  },
  {
    role: "unknown-role",
    canEdit: false,
    selected: "team computer",
    activeHost: TEAM_COMPUTER,
  },
  {
    role: "admin",
    canEdit: true,
    selected: "another computer",
    activeHost: OTHER_COMPUTER,
  },
  {
    role: "editor",
    canEdit: true,
    selected: "another computer",
    activeHost: OTHER_COMPUTER,
  },
  {
    role: "viewer",
    canEdit: false,
    selected: "another computer",
    activeHost: OTHER_COMPUTER,
  },
  {
    role: "unknown-role",
    canEdit: false,
    selected: "another computer",
    activeHost: OTHER_COMPUTER,
  },
] as const;

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

function PermissionProbe() {
  const canEdit = useCanEditConfiguration();
  return <output data-testid="permission" data-can-edit={String(canEdit)} />;
}

function mountBoundary(options: {
  readonly target: CloudConfigurationTarget;
  readonly environments: readonly EnvironmentDescriptorV11[];
  readonly activeHost: HostDirectoryEntry;
}): void {
  negotiateMethodsOn(options.activeHost.hostId, {
    "environment.invitations.list": VERSION_1,
    "environment.invitations.accept": VERSION_1,
    "environment.configuration.guide.set": VERSION_1,
    "environment.configuration.guide.reset": VERSION_1,
  });
  const invitations: readonly EnvironmentInvitation[] = [];
  const harness = mountTeamPage(poolSource("admin"), {
    "environment.list": () => ({ environments: [...options.environments] }),
    "environment.invitations.list": () => ({ invitations: [...invitations] }),
    "environment.configuration.guide.get": () => ({
      outcome: "unset",
      revision: "rev-1",
    }),
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(harness.queryClient),
    findHostById: (hostId) =>
      hostId === options.activeHost.hostId ? options.activeHost : null,
    messenger: harness.messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-token",
    }),
  );
  teamHostBoundary.client = client.createRequester(options.activeHost);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-me", username: "user-me" },
  });
  render(
    <ConfigurationSourceBoundary target={options.target} section={null}>
      <>
        <PermissionProbe />
        <TeamGuide />
      </>
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
}

describe("named team settings read the authn role on either selected computer", () => {
  it.each(ACCESS_CASES)(
    "$role canEdit=$canEdit with $selected selected",
    async ({ role, canEdit, activeHost }) => {
      mountBoundary({
        target: { kind: "team", environmentId: "env-team" },
        environments: [PERSONAL, team(role)],
        activeHost,
      });

      const probe = await screen.findByTestId("permission");
      await waitFor(() => {
        expect(probe.getAttribute("data-can-edit")).toBe(String(canEdit));
      });
      if (role === "viewer" || role === "unknown-role") {
        expect(
          screen.getByText("You can see Acme's settings but not change them."),
        ).toBeTruthy();
        expect(
          await screen.findByText(
            "Acme's agents use the default selection guide until someone saves one.",
          ),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Write one" })).toBeNull();
      } else {
        expect(
          screen.queryByText(
            "You can see Acme's settings but not change them.",
          ),
        ).toBeNull();
        const writeOne = await screen.findByRole("button", {
          name: "Write one",
        });
        expect(writeOne.hasAttribute("disabled")).toBe(false);
      }
    },
  );

  it("keeps a Personal cloud page read-only when an Admin selects a team computer", async () => {
    mountBoundary({
      target: { kind: "personal" },
      environments: [PERSONAL, team("admin")],
      activeHost: TEAM_COMPUTER,
    });

    const probe = await screen.findByTestId("permission");
    await waitFor(() => {
      expect(probe.getAttribute("data-can-edit")).toBe("false");
    });
    expect(
      screen.getByText("You can see Personal's settings but not change them."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write one" })).toBeNull();
  });
});
