import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentInvitation,
} from "@traycer/protocol/host/environment/contracts";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

/**
 * NEW-154-6: a page whose team the environment list no longer carries. The
 * person was removed, or removed and invited back; either way the page used to
 * read "These settings are no longer available." with a blank trigger.
 * NEW-154-24: a viewer's one standing line, which the boundary gives every
 * cloud-read page at once.
 */

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

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

const V10 = { major: 1, minor: 0 } as const;

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

function team(
  effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
): EnvironmentDescriptorV11 {
  return {
    environmentId: "env-a",
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-a",
    label: "Acme",
    effectiveRole,
    kind: "team",
    hostCount: 1,
    providerHandle: "handle-a",
  };
}

const INVITATION: EnvironmentInvitation = {
  environmentId: "env-a",
  teamName: "Acme",
  role: "editor",
  paidPlan: false,
};

function Probe(): ReactNode {
  const source = useConfigurationSource();
  return (
    <p data-testid="probe">
      {source.kind === "host" ? "host" : source.environmentId}
    </p>
  );
}

/**
 * Mounts the boundary on `env-a` with the list the host answers. The list is
 * read again after `onListed`, so a removal is the same list changing under an
 * open page.
 */
function mountBoundary(options: {
  readonly environments: () => readonly EnvironmentDescriptorV11[];
  readonly invitations: readonly EnvironmentInvitation[];
}): { readonly rerenderList: () => Promise<void> } {
  negotiateMethods({
    "environment.invitations.list": V10,
    "environment.invitations.accept": V10,
  });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.list": () => ({ environments: [...options.environments()] }),
    "environment.invitations.list": () => ({
      invitations: [...options.invitations],
    }),
  });
  render(
    <ConfigurationSourceBoundary
      target={{ kind: "team", environmentId: "env-a" }}
    >
      <Probe />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return {
    rerenderList: () => harness.queryClient.invalidateQueries(),
  };
}

describe("a team the environment list no longer carries", () => {
  it("says the person is no longer in it and moves the selection to Personal", async () => {
    const listed: { current: readonly EnvironmentDescriptorV11[] } = {
      current: [PERSONAL, team("editor")],
    };
    const { rerenderList } = mountBoundary({
      environments: () => listed.current,
      invitations: [],
    });
    await screen.findByTestId("probe");

    listed.current = [PERSONAL];
    await rerenderList();

    expect(await screen.findByText("You're no longer in Acme.")).toBeTruthy();
    expect(
      screen.queryByText("These settings are no longer available."),
    ).toBeNull();
    await waitFor(() =>
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      ),
    );
  });

  it("offers Review for a team that has invited the person back", async () => {
    mountBoundary({
      environments: () => [PERSONAL],
      invitations: [INVITATION],
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(
      screen.queryByText("These settings are no longer available."),
    ).toBeNull();
    // An invitation is not a membership: the selection stays, so the trigger
    // and the Review keep naming the same team.
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  it("keeps the failed read's own line and Retry, which an answer has not refuted", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => {
        throw new Error("down");
      },
      "environment.invitations.list": () => ({ invitations: [] }),
    });
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );

    expect(
      await screen.findByText("Couldn't read these settings."),
    ).toBeTruthy();
    expect(screen.queryByText(/You're no longer in/)).toBeNull();
  });
});

// NEW-154-6: the trigger reads this label, so an invited team must have one.
describe("the name a picked configuration is called", () => {
  function Label(): ReactNode {
    return (
      <span data-testid="label">{usePickedTeamLabel("env-a") ?? "none"}</span>
    );
  }

  function mountLabel(options: {
    readonly environments: readonly EnvironmentDescriptorV11[];
    readonly invitations: readonly EnvironmentInvitation[];
  }): void {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [...options.environments] }),
      "environment.invitations.list": () => ({
        invitations: [...options.invitations],
      }),
    });
    render(<Label />, { wrapper: harness.Wrapper });
  }

  it("names a team the list carries by its label", async () => {
    mountLabel({ environments: [PERSONAL, team("editor")], invitations: [] });
    expect(await screen.findByText("Acme")).toBeTruthy();
  });

  it("names a team that has only invited the person by the invitation", async () => {
    mountLabel({ environments: [PERSONAL], invitations: [INVITATION] });
    expect(await screen.findByText("Acme")).toBeTruthy();
  });

  it("names nothing for an id neither the list nor an invitation knows", async () => {
    mountLabel({ environments: [PERSONAL], invitations: [] });
    expect(await screen.findByText("none")).toBeTruthy();
  });
});

describe("the viewer's standing line", () => {
  function mountRole(
    effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
  ): void {
    const harness = mountTeamPage(poolSource(effectiveRole), {
      "environment.list": () => ({
        environments: [PERSONAL, team(effectiveRole)],
      }),
    });
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
  }

  it("stands above a viewer's page, once", async () => {
    mountRole("viewer");
    await screen.findByTestId("probe");
    expect(
      screen.getAllByText("You can see Acme's settings but not change them."),
    ).toHaveLength(1);
  });

  it.each(["admin", "editor"] as const)(
    "says nothing to %s, who can change the settings",
    async (role) => {
      mountRole(role);
      await screen.findByTestId("probe");
      expect(screen.queryByText(/but not change them/)).toBeNull();
    },
  );

  it("says nothing on Personal, which its owner changes", async () => {
    const harness = mountTeamPage(poolSource("owner"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
    });
    render(
      <ConfigurationSourceBoundary target={{ kind: "personal" }}>
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByTestId("probe");
    expect(screen.queryByText(/but not change them/)).toBeNull();
  });
});
